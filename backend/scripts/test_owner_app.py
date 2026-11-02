"""
Regression test: the OWNER APP (shop PC <-> Curavo cloud <-> owner's phone).

Run:  python3 backend/scripts/test_owner_app.py
Shop app and cloud server run in one process on a throwaway folder; the
PHONE's own JavaScript (mobile/src/lockbox.js) is run with Node when
mobile/node_modules exists (npm install in mobile/ once).

What it holds the system to:
  * Only someone who scanned the QR on the shop PC can connect a phone - a
    wrong proof, a reused or expired code are refused.
  * The cloud stores the summary LOCKED: no sales figure or patient name is
    readable in what it holds.
  * Each connected phone opens its own copy; a phone that was not connected,
    or was removed, cannot - with Python AND with the phone's real code.
  * The figures inside match the shop (today's sales, credit, stock).
  * Unlinking on the phone is noticed by the PC; removing on the PC locks the
    phone out.  At most 5 phones.
  * A lapsed subscription pauses the app (summary says "restricted", no money).
  * The morning notification carries counts, never money, once a day.
"""
import base64, json, os, shutil, subprocess, sys, tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_owner_app"
shutil.rmtree(sandbox, ignore_errors=True)
(sandbox / "shop").mkdir(parents=True)
(sandbox / "cloud").mkdir(parents=True)
os.environ["HCC_DATA_DIR"] = str(sandbox / "shop")          # BEFORE any app import
os.environ["CURAVO_CLOUD_DATA"] = str(sandbox / "cloud")
os.environ["CURAVO_ADMIN_PASSWORD"] = "test-panel-password"
os.environ.pop("CURAVO_CLOUD_URL", None)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "cloud" / "server"))

from cryptography.hazmat.primitives import serialization                         # noqa: E402
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey    # noqa: E402
from fastapi.testclient import TestClient                                        # noqa: E402

from app.main import app as shop_app                                             # noqa: E402
from app.database import SessionLocal                                            # noqa: E402
from app.services import cloud_agent, licence, owner_app                         # noqa: E402
from curavo_cloud import push                                                    # noqa: E402
from curavo_cloud.main import app as cloud_app                                   # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

NODE_OK = (ROOT / "mobile" / "node_modules" / "@noble").exists() and shutil.which("node")

def phone_js(job):
    """Run the phone's real code (mobile/src/lockbox.js) under Node."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(job, f)
    try:
        out = subprocess.run(["node", str(ROOT / "mobile" / "scripts" / "check_lockbox.mjs"), f.name],
                             capture_output=True, text=True, timeout=30)
        return json.loads(out.stdout)
    finally:
        os.unlink(f.name)


class Phone:
    """A pretend phone: its own key pair, talking to the cloud like the app does."""
    def __init__(self, cloud, name, use_js=False):
        self.cloud, self.name = cloud, name
        if use_js:
            kp = phone_js({"mode": "keypair"})
            self.priv_b64, self.pub_b64 = kp["privateKey"], kp["publicKey"]
        else:
            k = X25519PrivateKey.generate()
            self.priv_b64 = base64.b64encode(k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                                             serialization.NoEncryption())).decode()
            self.pub_b64 = base64.b64encode(k.public_key().public_bytes(serialization.Encoding.Raw,
                                                                        serialization.PublicFormat.Raw)).decode()
        self.device_id = self.token = None

    @property
    def key(self):
        return X25519PrivateKey.from_private_bytes(base64.b64decode(self.priv_b64))

    def scan(self, qr_text, proof=None, use_js=False):
        q = json.loads(qr_text)
        if proof is None:
            proof = (phone_js({"mode": "proof", "secret": q["k"], "public_key": self.pub_b64, "pairing_id": q["p"]})["proof"]
                     if use_js else owner_app.pairing_proof(q["k"], self.pub_b64, q["p"]))
        r = self.cloud.post("/mobile/v1/pair", json={"shop_code": q["s"], "pairing_id": q["p"],
                                                     "public_key": self.pub_b64, "proof": proof, "name": self.name})
        if r.status_code == 201:
            self.device_id, self.token = r.json()["device_id"], r.json()["device_token"]
        return r

    @property
    def H(self):
        return {"X-Device-Id": self.device_id or "", "Authorization": f"Bearer {self.token or ''}"}

    def status(self):
        return self.cloud.get("/mobile/v1/status", headers=self.H)

    def summary(self):
        return self.cloud.get("/mobile/v1/summary", headers=self.H)

    def open(self, locked):
        """locked = the cloud's reply for this phone -> the summary, or None."""
        full = {"nonce": locked["nonce"], "ct": locked["ct"], "wraps": {self.device_id: locked["wrap"]}}
        try:
            return owner_app.unlock_summary(full, self.device_id, self.key)
        except Exception:
            return None


with TestClient(cloud_app) as cloud, TestClient(shop_app, raise_server_exceptions=False) as shop:

    def transport(method, url, body, headers, timeout):
        path = url.split("://", 1)[1].split("/", 1)[1]
        r = cloud.request(method, "/" + path, content=body, headers=headers)
        return r.status_code, r.content

    PUSHES = []
    push.sender = lambda msgs: PUSHES.extend(msgs)

    agent = cloud_agent.agent
    # The real one starts a thread; here it runs at once so rounds never overlap.
    agent.run_in_background = lambda force_backup=False: agent.run_once(force_backup=force_backup)
    tok = shop.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    shop.put("/api/settings/pharmacy", headers=H, json={"pharmacy_name": "Owner Test Pharmacy"})

    # Stock + sales the owner should see on the phone
    sup = shop.post("/api/suppliers/", headers=H, json={"name": "Dist"}).json()
    prod = shop.post("/api/inventory/products", headers=H, json={"name": "OWNERTEST TAB", "gst_rate": "5", "medicine_type": "TABLET"}).json()
    shop.post("/api/inventory/add-stock", headers=H, json={
        "product_id": prod["id"], "supplier_id": sup["id"], "supplier_invoice_number": "T-1",
        "supplier_invoice_date": str(date.today()), "batch_number": "OB1", "quantity": 100,
        "expiry_date": f"{date.today().year + 2}-12", "mrp": "10", "cost_price": "6",
        "payment_mode": "CASH", "supplier_invoice_total": "630.00", "amount_paid": "630.00"})
    for _ in range(3):
        shop.post("/api/billing/invoices", headers=H, json={"items": [{"product_id": prod["id"], "quantity": 2}],
                                                            "payment_method": "CASH"})

    print("[1] Cloud off: the screen says so, no code is made")
    agent.url = ""
    d = shop.get("/api/owner-app/devices", headers=H).json()
    check("cloud_enabled false", d["cloud_enabled"], False)
    check("Connect phone refused plainly", shop.post("/api/owner-app/pairings", headers=H).status_code, 503)

    agent.url, agent.transport = "http://cloud.test", transport
    check("first round joins the cloud", agent.run_once(), True)

    print("[2] Connecting a phone")
    r = shop.post("/api/owner-app/pairings", headers=H)
    check("QR made", r.status_code, 201)
    pid, qr = r.json()["pairing_id"], r.json()["qr"]
    q = json.loads(qr)
    check("QR names this cloud and shop", (q["c"], q["n"]), ("http://cloud.test", "Owner Test Pharmacy"))
    check("PC waits while nobody scanned", shop.get(f"/api/owner-app/pairings/{pid}", headers=H).json()["status"], "OPEN")

    p1 = Phone(cloud, "Zahid's phone", use_js=bool(NODE_OK))
    check("phone scan accepted by cloud", p1.scan(qr, use_js=bool(NODE_OK)).status_code, 201)
    check("phone waits for the PC", p1.status().json()["status"], "PENDING")
    check("waiting phone gets no summary", p1.summary().status_code, 403)
    r = shop.get(f"/api/owner-app/pairings/{pid}", headers=H).json()
    check("PC checks the proof and connects it", (r["status"], r["device_name"]), ("DONE", "Zahid's phone"))
    check("phone now ACTIVE", p1.status().json()["status"], "ACTIVE")
    check("code cannot be used twice", Phone(cloud, "Thief").scan(qr).status_code, 409)

    print("[3] Somebody who only knows the pairing id cannot connect")
    r = shop.post("/api/owner-app/pairings", headers=H).json()
    bad = Phone(cloud, "Intruder")
    check("cloud takes the claim", bad.scan(r["qr"], proof="00" * 32).status_code, 201)
    check("PC refuses the wrong proof", shop.get(f"/api/owner-app/pairings/{r['pairing_id']}", headers=H).json()["status"], "FAILED")

    check("intruder is locked out", bad.status().status_code, 401)

    print("[4] The summary: locked at the cloud, open on the phone")
    agent.run_once()
    from curavo_cloud.db import SessionLocal as CloudSession
    from curavo_cloud.models import OwnerSummary
    cdb = CloudSession()
    stored = cdb.query(OwnerSummary).first().locked
    cdb.close()
    check("cloud cannot read the shop name", "Owner Test Pharmacy" in stored, False)
    check("...or the medicine", "OWNERTEST" in stored, False)
    r = p1.summary()
    check("phone gets its copy", r.status_code, 200)
    locked = r.json()["locked"]
    check("only its own wrap is handed out", sorted(locked.keys()), ["ct", "nonce", "v", "wrap"])
    s = p1.open(locked)
    check("phone opens it", s is not None, True)
    check("shop name inside", s["shop"]["name"], "Owner Test Pharmacy")
    check("today's sales match (3 bills x 2 x Rs10)", (s["today"]["sales"], s["today"]["bills"]), (60.0, 3))
    check("cash split", s["today"]["cash"], 60.0)
    row = next((x for x in s["stock"] if x["n"] == "OWNERTEST TAB"), None)
    check("stock lookup has the medicine", row is not None and row["q"], 94)
    check("its batch", row and row["b"][0][0], "OB1")
    check("last bills listed", len(s["recent_bills"]), 3)
    if NODE_OK:
        js = phone_js({"mode": "unlock", "locked": locked, "device_id": p1.device_id, "private_key": p1.priv_b64})
        check("the PHONE'S OWN CODE opens it too", (js["ok"], js.get("summary", {}).get("today", {}).get("sales")), (True, 60.0))
        tampered = dict(locked, ct=locked["ct"][:-6] + ("AAAAAA" if not locked["ct"].endswith("AAAAAA") else "BBBBBB"))
        check("...and refuses a tampered copy", phone_js({"mode": "unlock", "locked": tampered,
                                                          "device_id": p1.device_id, "private_key": p1.priv_b64})["ok"], False)
    else:
        print("  SKIP  phone JavaScript check (run npm install in mobile/ first)")

    print("[5] A second phone; each opens only its own copy")
    r = shop.post("/api/owner-app/pairings", headers=H).json()
    p2 = Phone(cloud, "Manager phone")
    p2.scan(r["qr"])
    shop.get(f"/api/owner-app/pairings/{r['pairing_id']}", headers=H)
    agent.run_once()
    l2 = p2.summary().json()["locked"]
    check("second phone opens its copy", p2.open(l2) is not None, True)
    stolen = dict(l2)
    check("phone 1's key cannot open phone 2's copy", p1.open(stolen) is None or p1.device_id == p2.device_id, True)
    check("PC lists two phones", len(shop.get("/api/owner-app/devices", headers=H).json()["devices"]), 2)

    print("[6] Removing phones")
    shop.delete(f"/api/owner-app/devices/{p2.device_id}", headers=H)
    check("removed on PC -> locked out at cloud", p2.summary().status_code, 401)
    cloud.post("/mobile/v1/unlink", headers=p1.H)
    agent.run_once()
    check("unlinked on phone -> PC forgets it", shop.get("/api/owner-app/devices", headers=H).json()["devices"], [])

    print("[7] At most 5 phones")
    phones = []
    for i in range(5):
        r = shop.post("/api/owner-app/pairings", headers=H).json()
        ph = Phone(cloud, f"P{i}")
        ph.scan(r["qr"])
        shop.get(f"/api/owner-app/pairings/{r['pairing_id']}", headers=H)
        phones.append(ph)
    check("5 connected", len(shop.get("/api/owner-app/devices", headers=H).json()["devices"]), 5)
    check("a sixth code is refused", shop.post("/api/owner-app/pairings", headers=H).status_code, 400)
    for ph in phones[1:]:
        shop.delete(f"/api/owner-app/devices/{ph.device_id}", headers=H)

    print("[8] Expired code")
    r = shop.post("/api/owner-app/pairings", headers=H).json()
    db = SessionLocal()
    from app.models.cloud import OwnerPairing
    db.query(OwnerPairing).filter(OwnerPairing.pairing_id == r["pairing_id"]).update(
        {"expires_at": datetime.utcnow() - timedelta(minutes=1)})
    db.commit(); db.close()
    check("PC marks it expired", shop.get(f"/api/owner-app/pairings/{r['pairing_id']}", headers=H).json()["status"], "EXPIRED")

    print("[9] Morning notification: counts only, once a day")
    PUSHES.clear()
    cloud.post("/mobile/v1/push-token", headers=phones[0].H, json={"token": "ExponentPushToken[test]"})
    # A medicine that runs out soon, so there is something to say
    p_low = shop.post("/api/inventory/products", headers=H, json={"name": "LOWSTOCK SYR", "gst_rate": "5",
                                                                   "medicine_type": "SYRUP", "min_stock_level": 50}).json()
    db = SessionLocal()
    st = cloud_agent.get_state(db); st.owner_push_on = None; db.commit(); db.close()
    real_now = cloud_agent.datetime
    class FakeDT(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2030, 1, 1, 10, 0, tzinfo=tz)
    cloud_agent.datetime = FakeDT
    try:
        agent.run_once(); agent.run_once()
    finally:
        cloud_agent.datetime = real_now
    check("one notification sent", len(PUSHES), 1)
    body = PUSHES[0]["body"] if PUSHES else ""
    check("it says what needs attention", "low on stock" in body, True)
    check("it carries no money", "Rs" in body or "₹" in body, False)

    print("[10] Lapsed subscription pauses the app")
    db = SessionLocal()
    ls = licence.get_state(db)
    ls.trial_started_on = date.today() - timedelta(days=200)
    db.commit(); db.close()
    check("Connect phone refused (402)", shop.post("/api/owner-app/pairings", headers=H).status_code, 402)
    agent.run_once()
    s = phones[0].open(phones[0].summary().json()["locked"])
    check("phone told it is paused", s.get("restricted"), True)
    check("no sales sent", "today" in s, False)

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
