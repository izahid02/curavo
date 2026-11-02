"""
Error reports: every crash on this PC is noted so ARZ sees it in the control
panel - usually before the shop has even phoned.

WHERE ERRORS COME FROM
  backend  an API request that crashed (unhandled exception -> HTTP 500).
           Hooked in main.py with app.add_exception_handler(Exception, ...).
  log      anything the app logs at ERROR level (a startup step failing, a
           background task dying).  A logging.Handler on the root logger.
  screen   a JavaScript error in the browser window - sent by the frontend
           (src/lib/errorReporter.js) to POST /api/diagnostics/client-error.

HOW THEY ARE KEPT
  Grouped by FINGERPRINT = source + error type + where in the code + which
  screen/API (numbers in paths replaced by N).  The same crash 40 times is one
  row with count=40.  The message is NOT part of the fingerprint, so
  "Product 12 not found" and "Product 97 not found" are one problem.

  Recording never blocks the request that failed: reports go onto an in-memory
  queue and a small background thread writes them to the error_reports table.
  The cloud helper (cloud_agent.py) sends whatever is new on its next round.
  With the cloud switched off, the table simply fills (capped) and nothing
  leaves the PC.

PRIVACY: messages are cut to 1,000 characters and stacks to the last 40 lines.
Error messages can occasionally mention a name or number; the backups ARZ can
open already contain far more, so this adds no new kind of exposure.
"""
import hashlib
import logging
import queue
import re
import threading
import traceback
from datetime import datetime, timedelta

from app.database import SessionLocal
from app.models.cloud import ErrorReport
from app.version import VERSION

MAX_ROWS = 500              # kinds of error kept on this PC
KEEP_DAYS = 30              # a kind not seen for this long is forgotten (once sent)
BATCH = 100

_q: "queue.Queue[dict]" = queue.Queue(maxsize=1000)
_worker = None
_worker_lock = threading.Lock()
_local = threading.local()  # stops an error while recording an error from looping


def _norm_route(route: str) -> str:
    return re.sub(r"\d+", "N", (route or ""))[:200]


def fingerprint(source: str, kind: str, frames: str, route: str) -> str:
    raw = f"{source}|{kind}|{frames}|{_norm_route(route)}"
    return hashlib.sha256(raw.encode("utf-8", "replace")).hexdigest()


def _frames_of(tb_text: str) -> str:
    """The 'File ..., line N, in func' lines - where it happened, not what was in it."""
    lines = [l.strip() for l in tb_text.splitlines() if l.strip().startswith("File ")]
    # Keep the file NAME (not the folder - it differs per PC) and the function.
    out = []
    for l in lines[-8:]:
        m = re.match(r'File "(?:.*[\\/])?([^"\\/]+)", line \d+, in (.+)', l)
        out.append(f"{m.group(1)}:{m.group(2)}" if m else l)
    return ";".join(out)


def record(source: str, kind: str, message: str, stack: str = "", route: str = "",
           frames: str = None) -> None:
    """Note one error.  Cheap and never raises - safe to call from anywhere."""
    if getattr(_local, "busy", False):
        return
    try:
        item = {
            "source": source[:20],
            "kind": (kind or "Error")[:120],
            "message": (message or "")[:1000],
            "stack": "\n".join((stack or "").splitlines()[-40:])[:20000],
            "route": _norm_route(route),
            "at": datetime.utcnow(),
        }
        item["fingerprint"] = fingerprint(item["source"], item["kind"],
                                          frames if frames is not None else _frames_of(stack), route)
        _q.put_nowait(item)
        _ensure_worker()
    except Exception:
        pass


def record_exception(exc: BaseException, source: str = "backend", route: str = "") -> None:
    tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    record(source, type(exc).__name__, str(exc), tb, route)


def _ensure_worker():
    global _worker
    if _worker and _worker.is_alive():
        return
    with _worker_lock:
        if _worker and _worker.is_alive():
            return
        _worker = threading.Thread(target=_drain_forever, name="curavo-errors", daemon=True)
        _worker.start()


def _drain_forever():
    while True:
        item = _q.get()
        items = [item]
        while len(items) < 50:
            try:
                items.append(_q.get_nowait())
            except queue.Empty:
                break
        try:
            _write(items)
        finally:
            for _ in items:
                _q.task_done()


def flush() -> None:
    """
    Make sure everything recorded so far is in the table (called before
    sending, and by tests): write what is still queued, then wait for the
    background writer to finish anything it had already picked up.
    """
    items = []
    while True:
        try:
            items.append(_q.get_nowait())
        except queue.Empty:
            break
    if items:
        try:
            _write(items)
        finally:
            for _ in items:
                _q.task_done()
    _q.join()


def _write(items):
    _local.busy = True
    db = SessionLocal()
    try:
        for it in items:
            row = db.query(ErrorReport).filter(ErrorReport.fingerprint == it["fingerprint"]).first()
            if row is None:
                if db.query(ErrorReport).count() >= MAX_ROWS:
                    continue
                row = ErrorReport(fingerprint=it["fingerprint"], count=0, sent_count=0,
                                  first_seen=it["at"])
                db.add(row)
            row.source, row.kind, row.message = it["source"], it["kind"], it["message"]
            row.stack, row.route, row.app_version = it["stack"], it["route"], VERSION
            row.count = (row.count or 0) + 1
            row.last_seen = it["at"]
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()
        _local.busy = False


# ---------------------------------------------------------------------------
# For the cloud helper
# ---------------------------------------------------------------------------

def pending_count(db) -> int:
    return db.query(ErrorReport).filter(ErrorReport.count > ErrorReport.sent_count).count()


class _Pending:
    def __init__(self, row):
        self.row = row
        self.new = row.count - row.sent_count

    def as_payload(self):
        r = self.row
        return {"fingerprint": r.fingerprint, "source": r.source, "kind": r.kind,
                "message": r.message or "", "stack": r.stack or "", "route": r.route or "",
                "app_version": r.app_version or "", "count": self.new,
                "first_seen": r.first_seen.isoformat() if r.first_seen else "",
                "last_seen": r.last_seen.isoformat() if r.last_seen else ""}


def take_batch(db):
    flush()
    rows = (db.query(ErrorReport).filter(ErrorReport.count > ErrorReport.sent_count)
            .order_by(ErrorReport.last_seen.desc()).limit(BATCH).all())
    return [_Pending(r) for r in rows]


def mark_sent(db, batch):
    for p in batch:
        p.row.sent_count = p.row.sent_count + p.new
    cutoff = datetime.utcnow() - timedelta(days=KEEP_DAYS)
    db.query(ErrorReport).filter(ErrorReport.last_seen < cutoff,
                                 ErrorReport.count == ErrorReport.sent_count).delete()
    db.commit()


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------

class ErrorLogHandler(logging.Handler):
    """Every ERROR-level log line becomes a report (source 'log')."""

    # Loggers whose errors are either noise or already captured elsewhere:
    # uvicorn repeats every crash the exception handler has already recorded,
    # and the cloud helper's own failures are shown on the Backup page instead.
    SKIP = ("uvicorn", "curavo.cloud", "sqlalchemy")

    def __init__(self):
        super().__init__(level=logging.ERROR)

    def emit(self, rec: logging.LogRecord):
        if rec.name.startswith(self.SKIP) or getattr(_local, "busy", False):
            return
        try:
            stack = ""
            kind = "LoggedError"
            if rec.exc_info and rec.exc_info[1] is not None:
                stack = "".join(traceback.format_exception(*rec.exc_info))
                kind = type(rec.exc_info[1]).__name__
            # The fingerprint uses WHERE it was logged, so one log line = one group.
            frames = f"{rec.module}:{rec.funcName}:{rec.lineno}"
            record("log", kind, rec.getMessage(), stack, route=rec.name, frames=frames)
        except Exception:
            pass


def install_log_handler():
    root = logging.getLogger()
    if not any(isinstance(h, ErrorLogHandler) for h in root.handlers):
        root.addHandler(ErrorLogHandler())
