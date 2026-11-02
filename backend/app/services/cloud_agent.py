"""
The Curavo cloud helper on the shop PC: checks in, uploads a locked backup once
a day, sends error reports, and picks up renewed licence keys.

THE ONE RULE: THE CLOUD MUST NEVER GET IN THE WAY OF THE SHOP.
  * It runs on its own background thread, never inside a request.
  * No internet, a slow line, the server down: every failure is caught,
    written to cloud_state.last_error in plain English, and retried on the
    next round.  Nothing is ever shown as an error to the counter staff.
  * The database snapshot uses SQLite's online backup API (never a file copy
    - see the WAL rule in CLAUDE.md), so billing carries on while it runs.

EACH ROUND (every 15 minutes, first one a minute after start-up):
  1. register   - first contact only: shop code -> device token
  2. heartbeat  - version, licence state, health; the reply may carry a
                  renewed licence key, which is activated straight away
  3. errors     - queued error reports (services/error_reports.py)
  4. backup     - if none has reached the cloud yet today (IST)

WHERE THE CLOUD IS: CURAVO_CLOUD_URL (environment) or DEFAULT_CLOUD_URL below.
Empty = cloud switched off; the app works exactly as before.

All log lines here are ASCII-only (CLAUDE.md section 6: cp1252 crash).
"""
import hashlib
import json
import logging
import os
import platform
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

from app.database import SessionLocal, get_app_data_dir, get_branding_dir
from app.models.cloud import CloudState
from app.services import backup_crypto, licence
from app.version import VERSION

# Filled in when the production server exists (e.g. https://cloud.curavo.in).
DEFAULT_CLOUD_URL = ""

ROUND_SECONDS = 15 * 60
# With an owner phone connected, rounds run every 5 minutes so the phone's
# figures are never more than ~5 minutes old.  (Backups stay once a day.)
OWNER_ROUND_SECONDS = 5 * 60
OWNER_PUSH_HOUR_IST = 9      # the morning "needs attention" notification
FIRST_ROUND_DELAY = 60
TIMEOUT = 30
UPLOAD_TIMEOUT = 600
IST = timezone(timedelta(hours=5, minutes=30))

log = logging.getLogger("curavo.cloud")


def cloud_url() -> str:
    """
    Where the Curavo cloud is, first match wins:
      1. CURAVO_CLOUD_URL environment variable (developers)
      2. a file cloud_url.txt in the data folder - one line, e.g.
         http://192.168.1.20:8100 - so a TEST PC can be pointed at the test
         cloud on Zahid's Mac without rebuilding anything
      3. DEFAULT_CLOUD_URL (the real server, once it exists)
    """
    env = os.environ.get("CURAVO_CLOUD_URL")
    if env is not None:
        return env.strip().rstrip("/")
    try:
        f = get_app_data_dir() / "cloud_url.txt"
        if f.exists():
            line = f.read_text(encoding="utf-8").strip().splitlines()[0].strip()
            if line.startswith(("http://", "https://")):
                return line.rstrip("/")
    except (OSError, IndexError):
        pass
    return DEFAULT_CLOUD_URL.rstrip("/")


def update_endpoint(base: str) -> str:
    """
    The address the desktop shell asks "is there a newer Curavo?".  The
    {{...}} parts are filled in by the Tauri updater itself.
    """
    return f"{base}/updates/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}"


def machine_fingerprint() -> str:
    """Identifies THIS PC (not the shop) without sending anything personal."""
    raw = f"{uuid.getnode()}|{platform.node()}|{platform.system()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def get_state(db) -> CloudState:
    row = db.query(CloudState).order_by(CloudState.id).first()
    if row is None:
        row = CloudState(backup_key=backup_crypto.new_shop_key())
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


class CloudError(Exception):
    """A plain-English, ASCII reason the cloud step did not work."""


def _urllib_transport(method, url, body, headers, timeout):
    """Real HTTP.  Returns (status, response bytes).  Tests swap this out."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class CloudAgent:
    def __init__(self, url=None, transport=None, session_factory=SessionLocal):
        self.url = (url if url is not None else cloud_url()).rstrip("/")
        self.transport = transport or _urllib_transport
        self.session_factory = session_factory
        self._lock = threading.Lock()       # one round at a time
        self._stop = threading.Event()
        self._thread = None
        self.busy = False

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    # ------------------------------------------------------------------ HTTP

    def _call(self, method, path, *, state=None, shop_code=None, payload=None,
              body=None, extra_headers=None, timeout=TIMEOUT):
        headers = {"User-Agent": f"Curavo/{VERSION}"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if state is not None and state.device_token:
            headers["Authorization"] = f"Bearer {state.device_token}"
            headers["X-Shop-Code"] = shop_code
        headers.update(extra_headers or {})
        try:
            status, data = self.transport(method, self.url + path, body, headers, timeout)
        except Exception as e:      # DNS, refused, timeout, TLS...
            raise CloudError(f"Could not reach the Curavo cloud ({type(e).__name__}).")
        try:
            parsed = json.loads(data or b"null")
        except ValueError:
            parsed = None
        if status >= 400:
            detail = parsed.get("detail") if isinstance(parsed, dict) else None
            raise CloudError(str(detail or f"Cloud replied with error {status}.").encode("ascii", "replace").decode())
        return status, parsed

    # ----------------------------------------------------------------- steps

    def _register(self, db, state, shop_code, shop_name):
        _, data = self._call("POST", "/agent/v1/register", payload={
            "shop_code": shop_code, "shop_name": shop_name,
            "app_version": VERSION, "machine_fp": machine_fingerprint()})
        state.device_token = data["device_token"]
        state.registered_at = datetime.utcnow()
        db.commit()
        log.info("Cloud: registered this shop")

    def _heartbeat(self, db, state, shop_code, shop_name):
        st = licence.licence_status(db)
        _, reply = self._call("POST", "/agent/v1/heartbeat", state=state, shop_code=shop_code, payload={
            "shop_name": shop_name,
            "app_version": VERSION,
            "os_name": f"{platform.system()} {platform.release()}"[:80],
            "machine_fp": machine_fingerprint(),
            "licence": {k: st.get(k) for k in ("state", "days_left", "valid_until", "trial_ends_on",
                                                 "serial", "restricted")},
            "health": self._health(db, state),
        })
        # Phones the owner unlinked from the phone itself: forget them here too,
        # so nothing more is locked for them.
        active = (reply or {}).get("owner_devices")
        if isinstance(active, list):
            from app.models.cloud import OwnerDevice
            for d in db.query(OwnerDevice).all():
                if d.device_id not in active:
                    db.delete(d)
            db.commit()
        key = (reply or {}).get("licence_key")
        if key:
            try:
                licence.activate(db, key)
                log.info("Cloud: renewed licence key received and activated")
            except licence.LicenceKeyError as e:
                raise CloudError(f"A licence key from ARZ was refused: {e}")

    def _health(self, db, state) -> dict:
        from sqlalchemy import text
        data_dir = get_app_data_dir()
        db_file = data_dir / "pharmacy.db"
        local = sorted((data_dir / "backups").glob("*.db"), key=lambda p: p.stat().st_mtime) \
            if (data_dir / "backups").exists() else []
        try:
            import shutil
            free = shutil.disk_usage(str(data_dir)).free
        except OSError:
            free = None
        try:
            invoices_today = db.execute(text(
                "SELECT COUNT(*) FROM invoices WHERE date(invoice_date) = date('now')")).scalar()
        except Exception:
            invoices_today = None
        try:
            from app.services import error_reports
            pending = error_reports.pending_count(db)
        except Exception:
            pending = None
        return {
            "db_bytes": db_file.stat().st_size if db_file.exists() else None,
            "disk_free_bytes": free,
            "last_local_backup": datetime.fromtimestamp(local[-1].stat().st_mtime).isoformat() if local else None,
            "local_backups": len(local),
            "last_cloud_backup": state.last_backup_at.isoformat() if state.last_backup_at else None,
            "invoices_today": invoices_today,
            "errors_pending": pending,
        }

    def _flush_errors(self, db, state, shop_code):
        try:
            from app.services import error_reports
        except ImportError:
            return
        batch = error_reports.take_batch(db)
        if not batch:
            return
        self._call("POST", "/agent/v1/errors", state=state, shop_code=shop_code,
                   payload={"errors": [r.as_payload() for r in batch]})
        error_reports.mark_sent(db, batch)

    # ------------------------------------------------------------ owner app

    def _send_owner_summary(self, db, state, shop_code, shop_name):
        """Lock a fresh summary for the connected phones and leave it at the cloud."""
        from app.models.cloud import OwnerDevice
        from app.services import owner_app
        devices = db.query(OwnerDevice).all()
        if not devices:
            return
        summary = owner_app.build_summary(db)
        payload = {"locked": owner_app.lock_summary(summary, devices),
                   "device_ids": [d.device_id for d in devices]}
        now_ist = datetime.now(IST)
        if (not summary.get("restricted") and now_ist.hour >= OWNER_PUSH_HOUR_IST
                and state.owner_push_on != now_ist.date()):
            note = owner_app.push_text(shop_name, owner_app.attention_counts(summary))
            if note:
                payload["push"] = note
            state.owner_push_on = now_ist.date()
        self._call("POST", "/agent/v1/owner-summary", state=state, shop_code=shop_code, payload=payload)
        state.owner_summary_at = datetime.utcnow()
        db.commit()

    def owner_call(self, method, path, payload=None):
        """For the Connect-phone screen: one direct call, in the request."""
        if not self.enabled:
            raise CloudError("The Curavo cloud is not switched on for this PC.")
        db = self.session_factory()
        try:
            state = get_state(db)
            if not state.device_token:
                raise CloudError("This PC has not joined the Curavo cloud yet. Try again in a few minutes.")
            code = licence.get_state(db).shop_code
            _, data = self._call(method, path, state=state, shop_code=code, payload=payload, timeout=15)
            return data
        finally:
            db.close()

    def backup_due(self, state) -> bool:
        if not state.last_backup_at:
            return True
        last = state.last_backup_at.replace(tzinfo=timezone.utc).astimezone(IST).date()
        return last < datetime.now(IST).date()

    def make_backup_blob(self, state, shop_code) -> bytes:
        """Snapshot pharmacy.db (online backup API) + branding/, packed and locked."""
        data_dir = get_app_data_dir()
        tmp = data_dir / f".cloud_snapshot_{os.getpid()}.db"
        try:
            src = sqlite3.connect(str(data_dir / "pharmacy.db"))
            try:
                dst = sqlite3.connect(str(tmp))
                try:
                    src.backup(dst)
                finally:
                    dst.close()
            finally:
                src.close()
            files = {"pharmacy.db": tmp.read_bytes()}
        finally:
            tmp.unlink(missing_ok=True)
        for f in get_branding_dir().glob("*"):
            if f.is_file():
                files[f"branding/{f.name}"] = f.read_bytes()
        meta = {"shop_code": shop_code, "created_at": datetime.utcnow().isoformat() + "Z",
                "app_version": VERSION, "files": sorted(files)}
        return backup_crypto.encrypt_backup(backup_crypto.pack_files(files), meta, state.backup_key)

    def _upload_backup(self, db, state, shop_code):
        blob = self.make_backup_blob(state, shop_code)
        self._call("POST", "/agent/v1/backups", state=state, shop_code=shop_code, body=blob,
                   extra_headers={"Content-Type": "application/octet-stream",
                                  "X-Backup-Created": datetime.utcnow().isoformat() + "Z",
                                  "X-Backup-Sha256": hashlib.sha256(blob).hexdigest(),
                                  "X-App-Version": VERSION},
                   timeout=UPLOAD_TIMEOUT)
        state.last_backup_at = datetime.utcnow()
        state.last_backup_size = len(blob)
        db.commit()
        log.info("Cloud: backup uploaded (%d bytes)", len(blob))

    # ----------------------------------------------------------------- round

    def run_once(self, force_backup=False) -> bool:
        """One round.  Returns True if everything worked.  Never raises."""
        if not self.enabled:
            return False
        if not self._lock.acquire(blocking=False):
            return False                     # a round is already running
        self.busy = True
        db = self.session_factory()
        state = None
        try:
            state = get_state(db)
            lic = licence.get_state(db)
            shop_code = lic.shop_code
            from app.models.settings import PharmacySettings
            ps = db.query(PharmacySettings).order_by(PharmacySettings.id).first()
            shop_name = ps.pharmacy_name if ps else ""

            if not state.device_token:
                self._register(db, state, shop_code, shop_name)
            self._heartbeat(db, state, shop_code, shop_name)
            self._flush_errors(db, state, shop_code)
            self._send_owner_summary(db, state, shop_code, shop_name)
            if force_backup or self.backup_due(state):
                self._upload_backup(db, state, shop_code)

            state.last_contact_at = datetime.utcnow()
            state.last_contact_ok = True
            state.last_error = None
            db.commit()
            return True
        except CloudError as e:
            self._record_failure(db, state, str(e))
            return False
        except Exception as e:  # a bug here must still never reach the shop
            self._record_failure(db, state, f"Cloud helper failed: {type(e).__name__}")
            log.exception("Cloud: unexpected failure")
            return False
        finally:
            db.close()
            self.busy = False
            self._lock.release()

    def _record_failure(self, db, state, msg):
        msg = msg.encode("ascii", "replace").decode()
        log.warning("Cloud: %s", msg)
        try:
            db.rollback()
            if state is not None:
                state = db.merge(state)
                state.last_contact_at = datetime.utcnow()
                state.last_contact_ok = False
                state.last_error = msg[:500]
                state.last_error_at = datetime.utcnow()
                db.commit()
        except Exception:
            pass

    # ---------------------------------------------------------------- thread

    def start(self):
        if not self.enabled or self._thread:
            return
        self._thread = threading.Thread(target=self._loop, name="curavo-cloud", daemon=True)
        self._thread.start()
        log.info("Cloud: helper started")

    def stop(self):
        self._stop.set()

    def _loop(self):
        if self._stop.wait(FIRST_ROUND_DELAY):
            return
        while not self._stop.is_set():
            self.run_once()
            self._stop.wait(OWNER_ROUND_SECONDS if self._has_owner_phone() else ROUND_SECONDS)

    def _has_owner_phone(self) -> bool:
        try:
            from app.models.cloud import OwnerDevice
            db = self.session_factory()
            try:
                return db.query(OwnerDevice).count() > 0
            finally:
                db.close()
        except Exception:
            return False

    def run_in_background(self, force_backup=False):
        """For the "Back up to cloud now" button: returns at once."""
        threading.Thread(target=self.run_once, kwargs={"force_backup": force_backup}, daemon=True).start()


agent = CloudAgent()
