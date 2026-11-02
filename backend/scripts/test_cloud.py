"""
Regression test: THE CURAVO CLOUD - check-ins, LOCKED daily backups, error
reports, licence delivery, and the control panel's view of all of it.

Run:  python3 backend/scripts/test_cloud.py
Runs the shop app AND the cloud server in this one process, each on its own
throwaway folder; the shop's cloud helper talks to the cloud server directly
(no network).  The real shop data, cloud and ARZ keys are never touched: the
test makes its own recovery and licence key pairs.

What it holds the system to:
  * The cloud being off, down or refusing changes NOTHING for the shop:
    billing works, and the helper only notes a plain-English reason.
  * A backup leaves the PC LOCKED.  The server's copy opens only with ARZ's
    recovery key or the shop's own key; a changed byte is detected.
  * The backup holds the real database (a sale made before it is inside) and
    the shop's logo/signature.
  * One cloud backup a day, unless "Back up now".
  * Crashes are reported once per kind with a count; sending twice does not
    double-count; a "fixed" error that happens again reopens.
  * A key queued in the panel reaches the shop and is activated.
  * A second PC cannot hijack a shop code; "Reset device" lets a new one in;
    two PCs on one code are flagged.
"""
import base64, hashlib, logging, os, shutil, sys, sqlite3, tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_cloud"
shutil.rmtree(sandbox, ignore_errors=True)
(sandbox / "shop").mkdir(parents=True)
(sandbox / "cloud").mkdir(parents=True)
os.environ["HCC_DATA_DIR"] = str(sandbox / "shop")          # BEFORE any app import
os.environ["CURAVO_CLOUD_DATA"] = str(sandbox / "cloud")
os.environ["CURAVO_ADMIN_PASSWORD"] = "test-panel-password"
os.environ.pop("CURAVO_CLOUD_URL", None)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "cloud" / "server"))
sys.path.insert(0, str(ROOT / "tools" / "licence"))

from cryptography.hazmat.primitives import serialization          # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey    # noqa: E402
from fastapi.testclient import TestClient                          # noqa: E402

from app.main import app as shop_app                               # noqa: E402
from app.database import SessionLocal, get_branding_dir            # noqa: E402
from app.services import backup_crypto, cloud_agent, error_reports, licence  # noqa: E402
from curavo_cloud.main import app as cloud_app                     # noqa: E402
from curavo_licence import make_key, public_key_b64                # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

# Throwaway ARZ keys for this run
RECOVERY = X25519PrivateKey.generate()
backup_crypto.RECOVERY_PUBLIC_KEYS = [base64.b64encode(RECOVERY.public_key().public_bytes(
    serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()]
SIGNER = Ed25519PrivateKey.generate()
licence.PUBLIC_KEYS = [public_key_b64(SIGNER)]

with TestClient(cloud_app) as cloud, TestClient(shop_app, raise_server_exceptions=False) as shop:

    CLOUD_UP = {"up": True}

    def transport(method, url, body, headers, timeout):
        """The shop's helper -> the cloud app, in-process."""
        if not CLOUD_UP["up"]:
            raise ConnectionRefusedError("down")
        path = url.split("://", 1)[1].split("/", 1)[1]
        r = cloud.request(method, "/" + path, content=body, headers=headers)
        return r.status_code, r.content

    agent = cloud_agent.agent           # the same instance the app's endpoints use

    tok = shop.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    shop.put("/api/settings/pharmacy", headers=H, json={"pharmacy_name": "Cloud Test Pharmacy"})
    CODE = shop.get("/api/licence/status", headers=H).json()["shop_code"].replace("-", "")

    # A sale, so we can find it inside the backup later
    sup = shop.post("/api/suppliers/", headers=H, json={"name": "Dist"}).json()
    prod = shop.post("/api/inventory/products", headers=H, json={"name": "CLOUD TAB", "gst_rate": "5", "medicine_type": "TABLET"}).json()
    shop.post("/api/inventory/add-stock", headers=H, json={
        "product_id": prod["id"], "supplier_id": sup["id"], "supplier_invoice_number": "T-1",
        "supplier_invoice_date": str(date.today()), "batch_number": "B1", "quantity": 100,
        "expiry_date": f"{date.today().year + 2}-12", "mrp": "10", "cost_price": "6",
        "payment_mode": "CASH", "supplier_invoice_total": "630.00", "amount_paid": "630.00"})

    def bill():
        return shop.post("/api/billing/invoices", headers=H, json={
            "items": [{"product_id": prod["id"], "quantity": 1}], "payment_method": "CASH"})

    first_invoice = bill().json()["invoice_number"]
    (get_branding_dir() / "logo.png").write_bytes(b"\x89PNG-test-logo")

    p = cloud.post("/admin/api/login", json={"username": "arz", "password": "test-panel-password"})
    A = {"Authorization": f"Bearer {p.json()['token']}"}

    def local_state():
        db = SessionLocal()
        try:
            st = cloud_agent.get_state(db)
            db.expunge(st)
            return st
        finally:
            db.close()

    # ------------------------------------------------------------------
    print("[1] Cloud switched off: nothing happens, nothing breaks")
    agent.url = ""
    check("helper reports disabled", agent.enabled, False)
    check("a round does nothing", agent.run_once(), False)
    check("status says off", shop.get("/api/cloud/status", headers=H).json(), {"enabled": False})

    print("[2] First round: register, check in, upload a backup")
    agent.url, agent.transport = "http://cloud.test", transport
    check("round succeeds", agent.run_once(), True)
    st = local_state()
    check("device token stored", bool(st.device_token), True)
    check("backup time stored", st.last_backup_at is not None, True)
    shops = cloud.get("/admin/api/shops", headers=A).json()
    check("panel lists one shop", [s["shop_code"] for s in shops], [CODE])
    s0 = shops[0]
    check("with its name", s0["shop_name"], "Cloud Test Pharmacy")
    check("online", s0["online"], True)
    check("backup OK", s0["backup_status"], "OK")
    check("licence state reported", s0["licence_state"], "TRIAL")
    status = shop.get("/api/cloud/status", headers=H).json()
    check("shop status: ok, no error", (status["last_contact_ok"], status["last_error"]), (True, None))

    print("[3] One backup a day, unless asked")
    agent.run_once()
    detail = cloud.get(f"/admin/api/shops/{CODE}", headers=A).json()
    check("second round same day: still 1 backup", len(detail["backups"]), 1)
    check("heartbeats recorded", len(detail["heartbeats"]), 2)
    agent.run_once(force_backup=True)
    detail = cloud.get(f"/admin/api/shops/{CODE}", headers=A).json()
    check("'back up now': 2 backups", len(detail["backups"]), 2)
    check("health: invoices today reported", detail["last_heartbeat"]["health"]["invoices_today"], 1)

    print("[4] The server's copy is LOCKED")
    bid = detail["backups"][0]["id"]
    blob = cloud.get(f"/admin/api/shops/{CODE}/backups/{bid}", headers=A).content
    check("starts with the Curavo magic", blob[:10], backup_crypto.MAGIC)
    check("no readable database inside", b"SQLite format 3" in blob, False)
    check("no shop name in clear", b"Cloud Test Pharmacy" in blob, False)
    try:
        backup_crypto.decrypt_backup(blob, recovery_private=X25519PrivateKey.generate())
        check("a stranger's key is refused", "opened", "refused")
    except backup_crypto.BackupCryptoError:
        check("a stranger's key is refused", "refused", "refused")
    files = backup_crypto.unpack_files(backup_crypto.decrypt_backup(blob, recovery_private=RECOVERY))
    check("ARZ's recovery key opens it", sorted(files), ["branding/logo.png", "pharmacy.db"])
    check("logo came along", files["branding/logo.png"], b"\x89PNG-test-logo")
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as t:
        t.write(files["pharmacy.db"])
    con = sqlite3.connect(t.name)
    check("the sale is inside the backup",
          con.execute("SELECT invoice_number FROM invoices").fetchall(), [(first_invoice,)])
    con.close(); os.unlink(t.name)
    st = local_state()
    check("the shop's own key opens it too",
          len(backup_crypto.decrypt_backup(blob, shop_key_b64=st.backup_key)) > 0, True)
    bad = bytearray(blob); bad[-20] ^= 1
    try:
        backup_crypto.decrypt_backup(bytes(bad), recovery_private=RECOVERY)
        check("a changed byte is detected", "opened", "refused")
    except backup_crypto.BackupCryptoError:
        check("a changed byte is detected", "refused", "refused")

    print("[5] Cloud down: the shop carries on")
    CLOUD_UP["up"] = False
    check("round fails quietly", agent.run_once(force_backup=True), False)
    status = shop.get("/api/cloud/status", headers=H).json()
    check("status: last contact failed", status["last_contact_ok"], False)
    check("plain-English, ASCII reason", (status["last_error"] or "").startswith("Could not reach") and status["last_error"].isascii(), True)
    check("BILLING STILL WORKS", bill().status_code, 201)
    CLOUD_UP["up"] = True
    check("next round recovers", agent.run_once(), True)
    check("error cleared", shop.get("/api/cloud/status", headers=H).json()["last_error"], None)

    print("[6] Error reports: grouped, counted once, reopened if they return")
    from fastapi import APIRouter
    _r = APIRouter()

    @_r.get("/api/_test_crash/{n}")
    def _crash(n: int):
        return {}["missing-key"]
    # In front of the app's own catch-all route (the desktop build serves the
    # screens from the same server, so unknown paths fall through to them).
    shop_app.router.routes[0:0] = _r.routes
    for i in range(3):
        check(f"crash {i + 1} -> 500", shop.get(f"/api/_test_crash/{i}").status_code, 500)
    for _ in range(2):
        shop.post("/api/diagnostics/client-error", json={
            "kind": "TypeError", "message": "x is undefined", "route": "/billing",
            "stack": "TypeError: x\n    at lineCalc (http://h/assets/a.js:1:2)\n    at Billing (http://h/assets/a.js:3:4)"})
    logging.getLogger("app.test").error("A background task failed")
    error_reports.flush()
    # An earlier "Back up now" round may still be running in the background;
    # wait for it, or this round is skipped (the lock) and the test races it.
    with agent._lock:
        pass
    agent.run_once()
    errs = cloud.get("/admin/api/errors", headers=A).json()
    by_kind = {e["kind"]: e for e in errs}
    check("three kinds of error", sorted(by_kind), ["KeyError", "LoggedError", "TypeError"])
    check("3 crashes = 1 group, count 3", by_kind["KeyError"]["count"], 3)
    check("path numbers grouped", by_kind["KeyError"]["route"], "GET /api/_test_crash/N")
    check("screen error counted twice", by_kind["TypeError"]["count"], 2)
    check("screen error source", by_kind["TypeError"]["source"], "screen")
    agent.run_once()
    errs = {e["kind"]: e for e in cloud.get("/admin/api/errors", headers=A).json()}
    check("sending again does not double-count", errs["KeyError"]["count"], 3)
    cloud.post(f"/admin/api/errors/{errs['KeyError']['id']}/resolve", headers=A)
    check("resolved errors leave the open list",
          "KeyError" in {e["kind"] for e in cloud.get("/admin/api/errors", headers=A).json()}, False)
    shop.get("/api/_test_crash/9")
    error_reports.flush()
    agent.run_once()
    errs = {e["kind"]: e for e in cloud.get("/admin/api/errors", headers=A).json()}
    check("it happened again -> reopened", "KeyError" in errs, True)
    check("...flagged as came back", errs.get("KeyError", {}).get("regressed"), True)
    check("...count now 4", errs.get("KeyError", {}).get("count"), 4)

    print("[7] A licence key sent from the panel reaches the shop")
    until = date.today() + timedelta(days=365)
    key = make_key(SIGNER, {"v": 1, "serial": 7, "shop": "Cloud Test Pharmacy", "code": CODE,
                            "plan": "standard", "issued": str(date.today()), "until": str(until)})
    other = make_key(SIGNER, {"v": 1, "serial": 8, "shop": "X", "code": "23456789",
                              "plan": "standard", "issued": str(date.today()), "until": str(until)})
    check("panel refuses another shop's key", cloud.post(f"/admin/api/shops/{CODE}/licence", headers=A, json={"key": other}).status_code, 400)
    check("panel queues the right key", cloud.post(f"/admin/api/shops/{CODE}/licence", headers=A, json={"key": key}).status_code, 200)
    agent.run_once()
    check("shop is now ACTIVE", shop.get("/api/licence/status", headers=H).json()["state"], "ACTIVE")
    agent.run_once()
    s0 = next(s for s in cloud.get("/admin/api/shops", headers=A).json() if s["shop_code"] == CODE)
    check("panel sees ACTIVE", s0["licence_state"], "ACTIVE")
    check("delivery done, nothing pending", s0["pending_licence_until"], None)

    print("[8] One shop code, one PC")
    real_fp = cloud_agent.machine_fingerprint
    cloud_agent.machine_fingerprint = lambda: "another-pc-fingerprint"
    agent.run_once()
    s0 = next(s for s in cloud.get("/admin/api/shops", headers=A).json() if s["shop_code"] == CODE)
    check("a second PC within a day is flagged", s0["machine_conflict_at"] is not None, True)
    cloud.post(f"/admin/api/shops/{CODE}/clear-conflict", headers=A)
    cloud_agent.machine_fingerprint = real_fp
    db = SessionLocal(); cloud_agent.get_state(db).device_token = None; db.commit(); db.close()
    check("a PC without the device link cannot take the code", agent.run_once(), False)
    check("...and is told to ask ARZ", "reset" in (local_state().last_error or ""), True)
    cloud.post(f"/admin/api/shops/{CODE}/reset-device", headers=A)
    check("after 'Reset device' it registers", agent.run_once(), True)

    print("[9] The doors are locked")
    check("panel without login -> 401", cloud.get("/admin/api/shops").status_code, 401)
    check("wrong panel password -> 401", cloud.post("/admin/api/login", json={"username": "arz", "password": "nope"}).status_code, 401)
    st = local_state()
    SH = {"Authorization": f"Bearer {st.device_token}", "X-Shop-Code": CODE}
    check("a shop's token cannot open the panel", cloud.get("/admin/api/shops", headers=SH).status_code, 401)
    check("a wrong device token -> 401", cloud.post("/agent/v1/heartbeat", json={},
          headers={"Authorization": "Bearer nope", "X-Shop-Code": CODE}).status_code, 401)
    check("an unlocked file is refused", cloud.post("/agent/v1/backups", content=b"SQLite format 3\x00 plain",
          headers={**SH, "Content-Type": "application/octet-stream"}).status_code, 400)
    check("a damaged upload is refused", cloud.post("/agent/v1/backups", content=backup_crypto.MAGIC + b"xx",
          headers={**SH, "Content-Type": "application/octet-stream", "X-Backup-Sha256": "0" * 64}).status_code, 400)
    cloud.patch(f"/admin/api/shops/{CODE}", headers=A, json={"disabled": True})
    check("a disabled shop is turned away", agent.run_once(), False)
    check("...billing still works", bill().status_code, 201)
    cloud.patch(f"/admin/api/shops/{CODE}", headers=A, json={"disabled": False, "notes": "Pilot shop"})
    check("enabled again", agent.run_once(), True)
    audit = [a["action"] for a in cloud.get("/admin/api/audit", headers=A).json()]
    check("panel actions are audited", {"queue_licence", "reset_device", "disable", "enable"} <= set(audit), True)

    print("[10] Overview numbers")
    ov = cloud.get("/admin/api/overview", headers=A).json()
    check("1 shop, online", (ov["shops"], ov["online"]), (1, 1))
    check("backups OK", ov["backups_ok"], 1)
    check("open errors counted", ov["errors_open"] >= 3, True)

    agent.url = ""

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
