"""
Regression test: "SIGN IN WITH YOUR CURAVO ACCOUNT" on a shop PC.

Run:  python3 backend/scripts/test_account_link.py
Shop app + cloud server in one process, on a throwaway folder.  The cloud's
online licence key is a throwaway key the PC is told to trust.

What it holds the system to:
  * The PC gets a short code; only a SIGNED-IN, confirmed account can answer
    it, once, within 10 minutes.  The PC is then linked to that account.
  * Linking needs the owner/administrator on the PC; staff cannot.
  * A PC linked to one account cannot be taken by another.
  * A paid account -> the cloud makes the licence key by itself, signed with
    its OWN key (never the master key), and the PC activates it.  No shop
    codes or keys copied by hand.
  * Signing in on the PC with the account gives the linked PC user's normal
    session - and only for the linked account.  Offline, the PC user's own
    username/password still works (the cloud is never needed to bill).
"""
import base64, os, re, shutil, sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_account_link"
shutil.rmtree(sandbox, ignore_errors=True)
(sandbox / "shop").mkdir(parents=True)
(sandbox / "cloud").mkdir(parents=True)
os.environ["HCC_DATA_DIR"] = str(sandbox / "shop")
os.environ["CURAVO_CLOUD_DATA"] = str(sandbox / "cloud")
os.environ["CURAVO_ADMIN_PASSWORD"] = "test-panel-password"
os.environ["CURAVO_CLOUD_URL"] = ""
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "cloud" / "server"))

from cryptography.hazmat.primitives import serialization                      # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from fastapi.testclient import TestClient                                     # noqa: E402

# The cloud's online licence key for this run (written where the server looks)
ONLINE = Ed25519PrivateKey.generate()
(sandbox / "cloud" / "online_licence_key.pem").write_bytes(ONLINE.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
MASTER = Ed25519PrivateKey.generate()
def pub(k):
    return base64.b64encode(k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()

from app.main import app as shop_app                                          # noqa: E402
from app.database import SessionLocal                                         # noqa: E402
from app.services import cloud_agent, licence                                 # noqa: E402
from curavo_cloud import mailer                                               # noqa: E402
from curavo_cloud.main import app as cloud_app                                # noqa: E402

licence.PUBLIC_KEYS = [pub(MASTER), pub(ONLINE)]

FAILS = []
def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

OUTBOX = []
mailer.sender = lambda m: OUTBOX.append(m.get_content())

with TestClient(cloud_app) as cloud, TestClient(shop_app, raise_server_exceptions=False) as shop:
    def transport(method, url, body, headers, timeout):
        path = url.split("://", 1)[1].split("/", 1)[1]
        r = cloud.request(method, "/" + path, content=body, headers=headers)
        return r.status_code, r.content
    agent = cloud_agent.agent
    agent.url, agent.transport = "http://cloud.test", transport
    agent.run_in_background = lambda force_backup=False: agent.run_once(force_backup=force_backup)

    tok = shop.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["token"]["access_token"]
    H = {"Authorization": f"Bearer {tok}"}
    shop.put("/api/settings/pharmacy", headers=H, json={"pharmacy_name": "Link Test Pharmacy"})
    check("PC joins the cloud", agent.run_once(), True)
    A = {"Authorization": "Bearer " + cloud.post("/admin/api/login", json={
        "username": "arz", "password": "test-panel-password"}).json()["token"]}

    n = {"ip": 0}
    def account(email, password="owner-pass-1"):
        n["ip"] += 1
        hdr = {"X-Forwarded-For": f"198.51.100.{n['ip']}"}
        cloud.post("/account/v1/signup", json={"email": email, "password": password}, headers=hdr)
        link = re.search(r"token=([A-Za-z0-9_\-]+)", OUTBOX[-1]).group(1)
        return {"Authorization": "Bearer " + cloud.post("/account/v1/verify", json={"token": link}, headers=hdr).json()["token"]}

    OWNER = account("owner@example.com")
    OTHER = account("someone.else@example.com")

    print("[1] Status before linking")
    st = shop.get("/api/account", headers=H).json()
    check("not linked yet", (st["cloud_enabled"], st["linked"]), (True, False))
    check("account sign-in on the login screen refused until linked", shop.post("/api/auth/account-login").status_code, 409)

    print("[2] Linking the PC to the owner's account")
    r = shop.post("/api/account/link", headers=H)
    check("PC gets a code", r.status_code, 201)
    code, url = r.json()["code"], r.json()["url"]
    check("code looks like ABCD-2345", bool(re.match(r"^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$", code)), True)
    check("...and a link to open on curavo.in", url.endswith(f"/link?code={code}"), True)
    check("PC waits", shop.get(f"/api/account/link/{code}", headers=H).json()["status"], "PENDING")
    check("nobody signed in cannot see it", cloud.get(f"/account/v1/link/{code}").status_code, 401)
    d = cloud.get(f"/account/v1/link/{code}", headers=OWNER).json()
    check("owner sees which shop is asking", (d["shop_name"], d["purpose"]), ("Link Test Pharmacy", "LINK"))
    check("owner allows", cloud.post(f"/account/v1/link/{code}", headers=OWNER, json={"allow": True}).json()["status"], "APPROVED")
    r = shop.get(f"/api/account/link/{code}", headers=H).json()
    check("PC sees it is linked", (r["status"], r["account"]["email"]), ("APPROVED", "owner@example.com"))
    st = shop.get("/api/account", headers=H).json()
    check("PC remembers the account and its offline user", (st["linked"], st["email"], st["offline_user"]),
          (True, "owner@example.com", "admin"))
    check("the code works only once", cloud.post(f"/account/v1/link/{code}", headers=OWNER, json={"allow": True}).status_code, 409)
    check("panel shows the owner on the shop page",
          cloud.get(f"/admin/api/shops/{licence.get_state(SessionLocal()).shop_code}", headers=A).json()["account"]["email"],
          "owner@example.com")

    print("[3] Another account cannot take this PC")
    code2 = shop.post("/api/account/link", headers=H).json()["code"]
    check("someone else is told it belongs to another account",
          cloud.get(f"/account/v1/link/{code2}", headers=OTHER).json()["linked_to_other_account"], True)
    check("...and cannot allow it", cloud.post(f"/account/v1/link/{code2}", headers=OTHER, json={"allow": True}).status_code, 409)
    code3 = shop.post("/api/account/link", headers=H).json()["code"]
    cloud.post(f"/account/v1/link/{code3}", headers=OWNER, json={"allow": False})
    check("the owner can refuse a code", shop.get(f"/api/account/link/{code3}", headers=H).json()["status"], "REFUSED")
    from curavo_cloud.db import SessionLocal as CloudSession
    from curavo_cloud.models import DeviceLink
    code4 = shop.post("/api/account/link", headers=H).json()["code"]
    cdb = CloudSession(); cdb.query(DeviceLink).filter(DeviceLink.code == code4.replace("-", "")).update(
        {"expires_at": datetime.utcnow() - timedelta(minutes=1)}); cdb.commit(); cdb.close()
    check("an expired code is refused", cloud.post(f"/account/v1/link/{code4}", headers=OWNER, json={"allow": True}).status_code, 410)

    print("[4] Staff cannot link the account")

    from app.models.user import Role, User
    from app.services.auth_service import hash_password
    db = SessionLocal()
    role = db.query(Role).filter(Role.name.notin_(["Owner", "Administrator"])).first()
    if role is None:
        role = Role(name="Pharmacist"); db.add(role); db.flush()
    db.add(User(username="counter1", full_name="Counter Staff", password_hash=hash_password("staff-pass1"), role_id=role.id))
    db.commit(); db.close()
    stok = shop.post("/api/auth/login", json={"username": "counter1", "password": "staff-pass1"}).json()["token"]["access_token"]
    check("a Pharmacist gets 403", shop.post("/api/account/link", headers={"Authorization": f"Bearer {stok}"}).status_code, 403)

    print("[5] Paid account -> the cloud sends the licence by itself")
    check("trial before payment", licence.licence_status(SessionLocal())["state"], "TRIAL")
    acc_id = cloud.get("/account/v1/me", headers=OWNER).json()["id"]
    until = (date.today() + timedelta(days=365)).isoformat()
    r = cloud.patch(f"/admin/api/accounts/{acc_id}", headers=A, json={"plan": "YEARLY", "paid_until": until})
    check("ARZ marks the account paid -> a key is queued", (r.status_code, r.json()["keys_sent"]), (200, 1))
    agent.run_once()
    st = licence.licence_status(SessionLocal())
    check("PC is now ACTIVE until the paid date", (st["state"], str(st.get("valid_until"))), ("ACTIVE", until))
    check("...signed by the cloud's own key (serial 100001+)", int(st.get("serial") or 0) > 100000, True)
    check("marking it paid again sends nothing new",
          cloud.patch(f"/admin/api/accounts/{acc_id}", headers=A, json={"paid_until": until}).json()["keys_sent"], 0)
    licence.PUBLIC_KEYS = [pub(MASTER)]
    check("a PC that does not trust the cloud key would refuse it", licence.licence_status(SessionLocal())["state"] != "ACTIVE", True)
    licence.PUBLIC_KEYS = [pub(MASTER), pub(ONLINE)]

    print("[6] Signing in on the PC with the account")
    r = shop.post("/api/auth/account-login")
    check("login screen gets a code (no PC login needed)", r.status_code, 201)
    lcode = r.json()["code"]
    check("waits for the owner", shop.get(f"/api/auth/account-login/{lcode}").json()["status"], "PENDING")
    check("another account cannot approve it", cloud.post(f"/account/v1/link/{lcode}", headers=OTHER, json={"allow": True}).status_code, 409)
    cloud.post(f"/account/v1/link/{lcode}", headers=OWNER, json={"allow": True})
    r = shop.get(f"/api/auth/account-login/{lcode}").json()
    check("approved -> a normal PC session for the linked user", (r["status"], r["user"]["username"]), ("APPROVED", "admin"))
    me = shop.get("/api/auth/me", headers={"Authorization": f"Bearer {r['token']['access_token']}"})
    check("...which works like any login", me.status_code, 200)
    check("the same code cannot sign in twice", shop.get(f"/api/auth/account-login/{lcode}").json()["status"], "USED")

    print("[7] No internet: the PC still works with its own login")
    agent.url = ""
    check("account sign-in explains it needs internet", shop.post("/api/auth/account-login").status_code, 503)
    check("PC username + password still works",
          shop.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).status_code, 200)
    check("licence still ACTIVE offline", licence.licence_status(SessionLocal())["state"], "ACTIVE")

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
