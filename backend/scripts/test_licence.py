"""
Regression test: THE CURAVO SUBSCRIPTION - trial, licence key, grace, restricted.

Run:  python3 backend/scripts/test_licence.py
Needs the backend's own dependencies (fastapi, sqlalchemy, httpx, cryptography);
it drives the real endpoints against a throwaway database under HCC_DATA_DIR.

The rules it holds the app to (decided Nov 2026 - see services/licence.py):
  * 30-day free trial from first run; then RESTRICTED (no grace for a trial).
  * A licence key is valid only if ARZ signed it, only for THIS shop's code,
    and only until its end date + 15 days of grace.
  * RESTRICTED pauses reports and backup downloads (402) - but BILLING, the
    dashboard and TAKING backups keep working.
  * Turning the PC clock back does not bring a trial or licence back.
  * Editing the stored key in the database does not help either.

ARZ's real private key is never needed: the test makes its own throwaway key
pair and points the app at that public key for the duration of the run.
"""
import os, sys, shutil, base64, json
from datetime import date, timedelta
from pathlib import Path

sandbox = os.path.join(os.path.expanduser("~"), ".hcc_test_licence")
shutil.rmtree(sandbox, ignore_errors=True)
os.makedirs(sandbox)
os.environ["HCC_DATA_DIR"] = sandbox          # BEFORE any app import
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tools" / "licence"))

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from fastapi.testclient import TestClient     # noqa: E402
from sqlalchemy import text                    # noqa: E402
from app.main import app                       # noqa: E402
from app.database import SessionLocal          # noqa: E402
from app.services import licence               # noqa: E402
from curavo_licence import make_key, public_key_b64   # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

print("[0] The app ships with a real ARZ public key")
check("at least one key", len(licence.PUBLIC_KEYS) >= 1, True)
check("each is 32 raw bytes (Ed25519)",
      all(len(base64.b64decode(k)) == 32 for k in licence.PUBLIC_KEYS), True)

# A throwaway signing key, and a second "attacker" key the app must not trust.
ARZ = Ed25519PrivateKey.generate()
OTHER = Ed25519PrivateKey.generate()
licence.PUBLIC_KEYS = [public_key_b64(ARZ)]

T0 = date(2026, 11, 2)
NOW = {"d": T0}
licence._today = lambda: NOW["d"]

def go(d):
    NOW["d"] = d

def key_for(code, until, signer=ARZ, shop="Test Shop", serial=1):
    return make_key(signer, {"v": 1, "serial": serial, "shop": shop, "code": code.replace("-", ""),
                             "plan": "standard", "issued": "2026-11-02", "until": until.isoformat()})

with TestClient(app) as c:
    tok = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}

    def ok(r, what):
        assert r.status_code < 300, f"{what}: {r.status_code} {r.text[:300]}"
        return r.json()

    def status():
        return ok(c.get("/api/licence/status", headers=H), "status")

    def activate(k):
        return c.post("/api/licence/activate", headers=H, json={"key": k})

    def reports_code():
        return c.get("/api/reports/sales", headers=H).status_code

    # Stock for bills, and one backup to try downloading
    sup = ok(c.post("/api/suppliers/", headers=H, json={"name": "Test Distributor"}), "supplier")
    prod = ok(c.post("/api/inventory/products", headers=H, json={"name": "TEST TAB", "gst_rate": "5", "medicine_type": "TABLET"}), "product")
    ok(c.post("/api/inventory/add-stock", headers=H, json={
        "product_id": prod["id"], "supplier_id": sup["id"], "supplier_invoice_number": "T-1",
        "supplier_invoice_date": str(date.today()), "batch_number": "B1", "quantity": 100,
        "expiry_date": f"{date.today().year + 2}-12", "mrp": "10", "cost_price": "6",
        "payment_mode": "CASH", "supplier_invoice_total": "630.00", "amount_paid": "630.00"}), "stock")

    def bill_code():
        return c.post("/api/billing/invoices", headers=H, json={
            "items": [{"product_id": prod["id"], "quantity": 1}], "payment_method": "CASH"}).status_code

    # ------------------------------------------------------------------
    print("[1] A brand-new shop is on a 30-day trial")
    s = status()
    CODE = s["shop_code"]
    check("state", s["state"], "TRIAL")
    check("30 days left on day one", s["days_left"], 30)
    check("trial ends on day 30", s["trial_ends_on"], str(T0 + timedelta(days=29)))
    check("shop code looks like XXXX-XXXX", len(CODE) == 9 and CODE[4] == "-", True)
    check("shop code avoids 0/O/1/I/L", set(CODE.replace("-", "")) <= set(licence._CODE_ALPHABET), True)
    check("nothing locked", (s["restricted"], s["locked_features"]), (False, []))
    check("reports open", reports_code(), 200)
    check("not logged in -> 401", c.get("/api/licence/status").status_code, 401)

    print("[2] Last day of the trial")
    go(T0 + timedelta(days=29))
    s = status()
    check("still TRIAL, 1 day left", (s["state"], s["days_left"]), ("TRIAL", 1))
    check("reports still open", reports_code(), 200)

    print("[3] Trial over -> restricted, but billing keeps working")
    go(T0 + timedelta(days=30))
    s = status()
    check("state", s["state"], "EXPIRED")
    check("restricted", s["restricted"], True)
    check("locked list", s["locked_features"], ["reports", "exports", "backup_download", "owner_app"])
    check("reports -> 402", reports_code(), 402)
    check("profit report -> 402", c.get("/api/reports/profit", headers=H).status_code, 402)
    check("reports when logged out -> 401 (not 402)", c.get("/api/reports/sales").status_code, 401)
    check("BILLING STILL WORKS", bill_code(), 201)
    check("dashboard still works", c.get("/api/dashboard/summary", headers=H).status_code, 200)
    made = c.post("/api/backup/create", headers=H)
    check("Backup Now still works", made.status_code, 201)
    fname = made.json()["filename"]
    check("backup download -> 402", c.get(f"/api/backup/download/{fname}", headers=H).status_code, 402)
    check("backup list still works", c.get("/api/backup/list", headers=H).status_code, 200)

    print("[4] Turning the PC clock back does not bring the trial back")
    go(T0)
    check("still EXPIRED", status()["state"], "EXPIRED")
    check("'today' stays at the latest date seen", status()["today"], str(T0 + timedelta(days=30)))
    go(T0 + timedelta(days=30))

    print("[5] Keys that must be refused")
    TODAY = T0 + timedelta(days=30)
    UNTIL = TODAY + timedelta(days=365)
    good = key_for(CODE, UNTIL)
    r = activate("hello")
    check("not a key -> 400", r.status_code, 400)
    r = activate(good[:-6])
    check("truncated key -> 400", r.status_code, 400)
    # Same signature, end date pushed out by a year: the signature must break.
    payload_b64, sig_b64 = good[len("CURAVO-"):].split(".")
    body = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    body["until"] = str(UNTIL + timedelta(days=365))
    forged = "CURAVO-" + base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":")).encode()).decode().rstrip("=") + "." + sig_b64
    check("edited end date -> 400", activate(forged).status_code, 400)
    check("signed by someone else -> 400", activate(key_for(CODE, UNTIL, signer=OTHER)).status_code, 400)
    r = activate(key_for("2345-6789", UNTIL))
    check("another shop's key -> 400", r.status_code, 400)
    check("...and it says which code to send", CODE in r.json()["detail"], True)
    check("already-ended key -> 400", activate(key_for(CODE, TODAY - timedelta(days=16))).status_code, 400)
    check("still EXPIRED after all that", status()["state"], "EXPIRED")

    print("[6] A real key, pasted the way WhatsApp wraps it")
    wrapped = " ".join(good[i:i + 40] for i in range(0, len(good), 40)) + "\n"
    r = activate(wrapped)
    check("accepted", r.status_code, 200)
    s = r.json()
    check("state", s["state"], "ACTIVE")
    check("licensed to", s["licensed_to"], "Test Shop")
    check("valid until", s["valid_until"], str(UNTIL))
    check("reports open again", reports_code(), 200)
    check("backup download open again", c.get(f"/api/backup/download/{fname}", headers=H).status_code, 200)
    check("same key again is fine", activate(good).status_code, 200)

    print("[7] After the end date: 15 days of grace, then restricted")
    go(UNTIL)
    check("last paid day is ACTIVE", status()["state"], "ACTIVE")
    go(UNTIL + timedelta(days=1))
    s = status()
    check("day after -> GRACE, 15 days left", (s["state"], s["days_left"]), ("GRACE", 15))
    check("nothing locked in grace", (s["restricted"], reports_code()), (False, 200))
    go(UNTIL + timedelta(days=15))
    s = status()
    check("last grace day", (s["state"], s["days_left"]), ("GRACE", 1))
    go(UNTIL + timedelta(days=16))
    check("then EXPIRED", status()["state"], "EXPIRED")
    check("reports -> 402", reports_code(), 402)
    check("billing still works", bill_code(), 201)

    print("[8] Renewal, and an older key cannot replace a newer one")
    UNTIL2 = UNTIL + timedelta(days=16 + 365)
    check("renewal key accepted", activate(key_for(CODE, UNTIL2, serial=2)).status_code, 200)
    check("ACTIVE again", status()["state"], "ACTIVE")
    r = activate(key_for(CODE, UNTIL2 - timedelta(days=100), serial=3))
    check("shorter key refused", r.status_code, 400)
    check("valid_until unchanged", status()["valid_until"], str(UNTIL2))

    print("[9] Editing the stored key in the database does not help")
    db = SessionLocal()
    stored = db.execute(text("SELECT licence_key FROM licence_state")).scalar()
    p, sg = stored[len("CURAVO-"):].split(".")
    body = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    body["until"] = "2099-12-31"
    tampered = "CURAVO-" + base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":")).encode()).decode().rstrip("=") + "." + sg
    db.execute(text("UPDATE licence_state SET licence_key = :k"), {"k": tampered}); db.commit()
    s = status()
    check("a tampered key stops counting", (s["state"], s["valid_until"]), ("EXPIRED", None))
    db.execute(text("UPDATE licence_state SET licence_key = :k"), {"k": stored}); db.commit()
    check("the genuine key counts again", status()["state"], "ACTIVE")
    db.close()

    print("[10] Every status message is plain ASCII (safe for any log)")
    msgs = [status()[k] for k in ("headline", "detail")] + [licence.RESTRICTED_MESSAGE]
    check("ASCII only", all(m.isascii() for m in msgs), True)

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
