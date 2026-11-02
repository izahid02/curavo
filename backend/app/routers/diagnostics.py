"""
POST /api/diagnostics/client-error - the screens report their own crashes.

Called by frontend/src/lib/errorReporter.js when a page throws.  No login
needed (the login screen can break too), so it is size-capped and
rate-limited: at most 30 reports a minute reach the queue, the rest are
dropped.  What happens next is in services/error_reports.py.
"""
import threading
import time

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services import error_reports

router = APIRouter(prefix="/diagnostics", tags=["Diagnostics"])

_PER_MINUTE = 30
_window = {"start": 0.0, "n": 0}
_lock = threading.Lock()


class ClientError(BaseModel):
    kind: str = Field(default="Error", max_length=120)
    message: str = Field(default="", max_length=2000)
    stack: str = Field(default="", max_length=20000)
    route: str = Field(default="", max_length=200)


def _allowed() -> bool:
    now = time.monotonic()
    with _lock:
        if now - _window["start"] > 60:
            _window["start"], _window["n"] = now, 0
        _window["n"] += 1
        return _window["n"] <= _PER_MINUTE


@router.post("/client-error", status_code=204)
def client_error(body: ClientError):
    if _allowed():
        # Browser stacks: "at fn (http://host/assets/x.js:1:2)" - keep the
        # function names only, so a rebuild (new file hashes) is the same group.
        import re
        frames = ";".join(re.findall(r"at ([\w$.<>]+) ", body.stack)[:8])
        error_reports.record("screen", body.kind, body.message, body.stack, body.route, frames=frames)
    return None
