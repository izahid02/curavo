"""
Regression test: connecting the OWNER APP by SIGNING IN with the Curavo
account (no QR), then Allow / Refuse on the shop PC.

Run:  python3 backend/scripts/test_phone_connect.py
Shop app and cloud server run in one process on a throwaway folder; the
phone's own JavaScript (mobile/src/lockbox.js) is run with Node when
mobile/node_modules exists.

What it holds the system to:
  * A phone signed in with the shop's account can ask; any other account
    cannot even see the shop.
  * Nothing connects until the owner presses Allow on the shop PC; Refuse
    tells the phone why.
  * The 6-digit check code is the same on the phone (its real JS), the cloud
    and the PC - and a key swapped on the way gives a DIFFERENT code, which is
    what lets the owner catch it.
  * After Allow, the figures are locked for that phone and it opens them.
  * "Continue with Google" through curavo.in: only the phone that started it
    (holding the poll secret) receives the sign-in, and only once.
  * At most 3 phones wait at once; only the owner/admin is asked.
"""
import base64, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_phone_connect"
shutil.rmtree(sandbox, ignore_errors=True)
(sandbox / "shop").mkdir(parents=True)
(sandbox / "cloud").mkdir(parents=True)
os.environ["HCC_DATA_DIR"] = str(sandbox / "shop")          # BEFORE any app import
os.environ["CURAVO_CLOUD_DATA"] = str(sandbox / "cloud")
os.environ["CURAVO_ADMIN_PASSWORD"] = "test-panel-password"
os.environ["CURAVO_SITE_URL"] = "https://curavo.test"
os.environ.pop("CURAVO_CLOUD_URL", None)
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "cloud" / "server"))

from cryptography.hazmat.primitives import serialization                         # noqa: E402
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey    # noqa: E402
from fastapi.testclient import TestClient                                        # noqa: E402

from app.main import app as shop_app                                             # noqa: E402
from app.services import cloud_agent, licence, owner_app                         # noqa: E402
from app.routers import owner_app as owner_router                                # noqa: E402
from curavo_cloud import mailer                                                  # noqa: E402
from curavo_cloud.db import SessionLocal as CloudSession                         # noqa: E402
from curavo_cloud.main import app as cloud_app                                   # noqa: E402
from curavo_cloud.models import Account, PhoneRequest, Shop                      # noqa: E402
from curavo_cloud.routers.phone_connect import check_code as cloud_check_code    # noqa: E402
from curavo_cloud.security import hash_password                                  # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

mailer.sender = lambda msg: None
NODE_OK = bool((ROOT / "mobile" / "node_modules" / "@noble").exists() and shutil.which("node"))

def phone_js(job):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(job, f)
    try:
        out = subprocess.run(["node", str(ROOT / "mobile" / "scripts" / "check_lockbox.mjs"), f.name],
                             capture_output=True, text=True, timeout=30)
        return json.loads(out.stdout)
    finally:
        os.unlink(f.name)

def new_key():
    if NODE_OK:
        kp = phone_js({"mode": "keypair"})
        return kp["privateKey"], kp["publicKey"]
    k = X25519PrivateKey.generate()
    priv = base64.b64encode(k.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                            serialization.NoEncryption())).decode()
    pub = base64.b64encode(k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    return priv, pub

def make_account(email, password):
    db = CloudSession()
    a = Account(email=email, name="Owner", password_hash=hash_password(password), email_verified=True)
    db.add(a)
    db.commit()
    aid = a.id
    db.close()
    return aid


with TestClient(cloud_app) as cloud, TestClient(shop_app, raise_server_exceptions=False) as shop:

    def transport(method, url, body, headers, timeout):
        path = url.split("://", 1)[1].split("/", 1)[1]
        r = cloud.request(method, "/" + path, content=body, headers=headers)
        return r.status_code, r.content

    agent = cloud_agent.agent
    agent.run_in_background = lambda force_backup=False: agent.run_once(force_backup=force_backup)
    owner_router._REQ_SECONDS = 0            # no caching in the test: every ask goes to the cloud
    tok = shop.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    shop.put("/api/settings/pharmacy", headers=H, json={"pharmacy_name": "Phone Test Pharmacy"})
    agent.url, agent.transport = "http://cloud.test", transport
    agent.run_once()

    owner_id = make_account("owner@example.com", "medicine-123")
    other_id = make_account("someone@example.com", "medicine-123")
    db = CloudSession()
    shop_row = db.query(Shop).first()
    shop_row.account_id = owner_id
    shop_code = shop_row.shop_code
    db.commit()
    db.close()

    def login(email):
        return cloud.post("/account/v1/login", json={"email": email, "password": "medicine-123"},
                          headers={"X-Forwarded-For": "198.51.100.7"}).json()["token"]
    OT, XT = login("owner@example.com"), login("someone@example.com")
    A = lambda t: {"Authorization": f"Bearer {t}"}

    print("[1] Signed in on the phone: the account's shops")
    r = cloud.get("/mobile/v1/my-shops", headers=A(OT))
    check("owner sees the shop", [s["shop_name"] for s in r.json()["shops"]], ["Phone Test Pharmacy"])
    check("another account sees none", cloud.get("/mobile/v1/my-shops", headers=A(XT)).json()["shops"], [])
    check("not signed in -> refused", cloud.get("/mobile/v1/my-shops").status_code, 401)
    code_fmt = r.json()["shops"][0]["shop_code"]
    priv, pub = new_key()
    check("another account cannot ask this shop",
          cloud.post("/mobile/v1/connect", headers=A(XT), json={"shop_code": code_fmt, "public_key": pub, "name": "X"}).status_code, 404)
    check("a bad key is refused",
          cloud.post("/mobile/v1/connect", headers=A(OT), json={"shop_code": code_fmt, "public_key": "A" * 44, "name": "X"}).status_code, 400)

    print("[2] Ask -> the PC shows it -> Refuse")
    r = cloud.post("/mobile/v1/connect", headers=A(OT), json={"shop_code": code_fmt, "public_key": pub, "name": "Spare phone"})
    check("request accepted", r.status_code, 201)
    dev1 = r.json()
    D1 = {"X-Device-Id": dev1["device_id"], "Authorization": f"Bearer {dev1['device_token']}"}
    check("phone waits", cloud.get("/mobile/v1/status", headers=D1).json()["status"], "PENDING")
    check("no figures while waiting", cloud.get("/mobile/v1/summary", headers=D1).status_code, 403)
    reqs = shop.get("/api/owner-app/phone-requests", headers=H).json()["requests"]
    check("the PC is asked", [(x["name"], x["account_email"]) for x in reqs], [("Spare phone", "owner@example.com")])
    code_phone = phone_js({"mode": "check", "public_key": pub})["code"] if NODE_OK else owner_app.check_code(pub)
    check("check code: phone == PC", reqs[0]["check_code"], code_phone)
    check("check code: cloud == PC", dev1["check_code"], reqs[0]["check_code"])
    check("check code looks like '123 456'", len(reqs[0]["check_code"]) == 7 and reqs[0]["check_code"][3] == " ", True)
    r = shop.post(f"/api/owner-app/phone-requests/{reqs[0]['request_id']}", headers=H, json={"allow": False})
    check("Refuse", r.json()["status"], "REFUSED")
    st = cloud.get("/mobile/v1/status", headers=D1).json()
    check("phone is told", (st["status"], bool(st["reason"])), ("REMOVED", True))
    check("nothing was added on the PC", shop.get("/api/owner-app/devices", headers=H).json()["devices"], [])

    print("[3] A key swapped on the way shows a different check code")
    priv2, pub2 = new_key()
    r = cloud.post("/mobile/v1/connect", headers=A(OT), json={"shop_code": code_fmt, "public_key": pub2, "name": "Zahid's phone"})
    dev2 = r.json()
    phone_code = phone_js({"mode": "check", "public_key": pub2})["code"] if NODE_OK else owner_app.check_code(pub2)
    _, evil_pub = new_key()
    db = CloudSession()
    req = db.query(PhoneRequest).filter(PhoneRequest.device_id == dev2["device_id"]).first()
    real_pub, req.public_key = req.public_key, evil_pub          # what a dishonest server could do
    db.commit()
    pc_code = shop.get("/api/owner-app/phone-requests", headers=H).json()["requests"][0]["check_code"]
    check("PC's code differs from the phone's -> owner refuses", pc_code != phone_code, True)
    req = db.query(PhoneRequest).filter(PhoneRequest.device_id == dev2["device_id"]).first()
    req.public_key = real_pub                                     # put it back: the honest case
    db.commit()
    db.close()
    reqs = shop.get("/api/owner-app/phone-requests", headers=H).json()["requests"]
    check("honest key -> codes match", reqs[0]["check_code"], phone_code)

    print("[4] Allow -> connected -> the phone opens the figures")
    r = shop.post(f"/api/owner-app/phone-requests/{reqs[0]['request_id']}", headers=H, json={"allow": True})
    check("Allow", r.json()["status"], "APPROVED")
    D2 = {"X-Device-Id": dev2["device_id"], "Authorization": f"Bearer {dev2['device_token']}"}
    check("phone ACTIVE", cloud.get("/mobile/v1/status", headers=D2).json()["status"], "ACTIVE")
    check("listed on the PC", [d["name"] for d in shop.get("/api/owner-app/devices", headers=H).json()["devices"]], ["Zahid's phone"])
    check("no longer waiting", shop.get("/api/owner-app/phone-requests", headers=H).json()["requests"], [])
    agent.run_once()
    r = cloud.get("/mobile/v1/summary", headers=D2)
    check("figures locked for it", r.status_code, 200)
    locked = r.json()["locked"]
    if NODE_OK:
        out = phone_js({"mode": "unlock", "locked": locked, "device_id": dev2["device_id"], "private_key": priv2})
        check("the phone's real code opens them", (out.get("ok"), (out.get("summary") or {}).get("shop", {}).get("name")),
              (True, "Phone Test Pharmacy"))
    else:
        full = {"nonce": locked["nonce"], "ct": locked["ct"], "wraps": {dev2["device_id"]: locked["wrap"]}}
        s = owner_app.unlock_summary(full, dev2["device_id"], X25519PrivateKey.from_private_bytes(base64.b64decode(priv2)))
        check("the phone opens them (Python; no Node here)", s["shop"]["name"], "Phone Test Pharmacy")
    check("answering twice changes nothing",
          shop.post(f"/api/owner-app/phone-requests/{reqs[0]['request_id']}", headers=H, json={"allow": False}).status_code, 404)

    print("[5] Continue with Google, through curavo.in")
    r = cloud.post("/mobile/v1/sign-in-link", headers={"X-Forwarded-For": "198.51.100.8"})
    check("code made", r.status_code, 201)
    sl = r.json()
    check("...on the website", sl["url"].startswith("https://curavo.test/link?code="), True)
    check("waiting", cloud.get(f"/mobile/v1/sign-in-link/{sl['code']}?poll={sl['poll']}").json()["status"], "PENDING")
    check("without the poll secret: nothing", cloud.get(f"/mobile/v1/sign-in-link/{sl['code']}?poll=guess").status_code, 404)
    d = cloud.get(f"/account/v1/link/{sl['code']}", headers=A(OT)).json()
    check("the website knows it is the phone", d["purpose"], "PHONE")
    check("owner allows", cloud.post(f"/account/v1/link/{sl['code']}", headers=A(OT), json={"allow": True}).json()["status"], "APPROVED")
    r = cloud.get(f"/mobile/v1/sign-in-link/{sl['code']}?poll={sl['poll']}").json()
    check("phone receives the sign-in", (r["status"], r["account"]["email"], bool(r.get("token"))), ("APPROVED", "owner@example.com", True))
    check("...which works", cloud.get("/mobile/v1/my-shops", headers=A(r["token"])).status_code, 200)
    check("only once", cloud.get(f"/mobile/v1/sign-in-link/{sl['code']}?poll={sl['poll']}").json()["status"], "USED")
    sl2 = cloud.post("/mobile/v1/sign-in-link", headers={"X-Forwarded-For": "198.51.100.9"}).json()
    cloud.post(f"/account/v1/link/{sl2['code']}", headers=A(OT), json={"allow": False})
    check("Don't allow -> refused", cloud.get(f"/mobile/v1/sign-in-link/{sl2['code']}?poll={sl2['poll']}").json()["status"], "REFUSED")

    print("[6] Limits")
    for i in range(3):
        _, p = new_key()
        cloud.post("/mobile/v1/connect", headers=A(OT), json={"shop_code": code_fmt, "public_key": p, "name": f"P{i}"})
    _, p = new_key()
    check("a 4th waiting phone is refused",
          cloud.post("/mobile/v1/connect", headers=A(OT), json={"shop_code": code_fmt, "public_key": p, "name": "P4"}).status_code, 429)
    # A staff member is never asked.
    from app.database import SessionLocal
    from app.models.user import Role, User
    from app.services.auth_service import hash_password as shop_hash
    sdb = SessionLocal()
    role = sdb.query(Role).filter(Role.name.notin_(["Owner", "Administrator"])).first()
    if role is None:
        role = Role(name="Pharmacist"); sdb.add(role); sdb.flush()
    sdb.add(User(username="staff1", full_name="Staff", password_hash=shop_hash("staff-pass-1"), role_id=role.id))
    sdb.commit()
    sdb.close()
    st_tok = shop.post("/api/auth/login", json={"username": "staff1", "password": "staff-pass-1"}).json()["token"]["access_token"]
    SH = {"Authorization": f"Bearer {st_tok}"}
    check("staff are not shown the requests", shop.get("/api/owner-app/phone-requests", headers=SH).json()["requests"], [])
    rid = shop.get("/api/owner-app/phone-requests", headers=H).json()["requests"][0]["request_id"]
    check("...and cannot allow one", shop.post(f"/api/owner-app/phone-requests/{rid}", headers=SH, json={"allow": True}).status_code, 403)

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
