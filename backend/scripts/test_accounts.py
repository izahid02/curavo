"""
Regression test: CUSTOMER ACCOUNTS on the Curavo cloud (the shop owner's
sign-in for the website, the shop PC and the phone).

Run:  python3 backend/scripts/test_accounts.py
Runs only the cloud server, on a throwaway folder.  Emails are captured, not
sent; Google is replaced by a test key that signs fake Google credentials.

What it holds the system to:
  * Sign up -> a confirmation email -> the link signs you in.  Before that, no
    sign-in.  The link works once.
  * Nobody can learn whether an email is registered (sign-up, forgot and
    resend all answer the same).
  * Wrong passwords are refused; 10 in a row lock the account for a while.
  * Forgot password: the link works once, expires, and signs out every other
    device.
  * Google: only a credential Google really signed, for OUR client id, with a
    verified email, is accepted.  The same email signed up with a password is
    the same account.
  * The profile (shop details) can be read and changed only by its owner.
"""
import os, re, shutil, sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sandbox = Path(os.path.expanduser("~")) / ".hcc_test_accounts"
shutil.rmtree(sandbox, ignore_errors=True)
sandbox.mkdir(parents=True)
os.environ["CURAVO_CLOUD_DATA"] = str(sandbox)
os.environ["CURAVO_ADMIN_PASSWORD"] = "test-panel-password"
os.environ["CURAVO_GOOGLE_CLIENT_IDS"] = "test-client.apps.googleusercontent.com"
os.environ["CURAVO_SITE_URL"] = "https://curavo.test"
sys.path.insert(0, str(ROOT / "cloud" / "server"))

from cryptography.hazmat.primitives import serialization               # noqa: E402
from cryptography.hazmat.primitives.asymmetric import rsa               # noqa: E402
from fastapi.testclient import TestClient                               # noqa: E402
from jose import jwk, jwt                                               # noqa: E402

from curavo_cloud import google_signin, mailer                          # noqa: E402
from curavo_cloud.main import app                                       # noqa: E402

FAILS = []

def check(label, got, want):
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + ("" if ok else f"\n        got:  {got!r}\n        want: {want!r}"))
    if not ok:
        FAILS.append(label)

# Captured email
OUTBOX = []
mailer.sender = lambda msg: OUTBOX.append({"to": msg["To"], "subject": msg["Subject"], "body": msg.get_content()})

def last_link(kind):
    for m in reversed(OUTBOX):
        hit = re.search(rf"/account/{kind}\?token=([A-Za-z0-9_\-]+)", m["body"])
        if hit:
            return hit.group(1)
    return None

# A pretend Google: our own key, published as Google's key set
GKEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
GPEM = GKEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
GPUB = GKEY.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
JWK = {**jwk.construct(GPUB, "RS256").to_dict(), "kid": "test-kid", "use": "sig", "alg": "RS256"}
google_signin.fetch_certs = lambda: {"keys": [JWK]}

def google_cred(sub, email, verified=True, aud="test-client.apps.googleusercontent.com", key=GPEM, exp_min=60):
    now = datetime.utcnow()
    return jwt.encode({"iss": "https://accounts.google.com", "aud": aud, "sub": sub, "email": email,
                       "email_verified": verified, "name": "Rupam Das",
                       "iat": now, "exp": now + timedelta(minutes=exp_min)},
                      key, algorithm="RS256", headers={"kid": "test-kid"})

IP = {"n": 0}
def fresh_ip():
    IP["n"] += 1
    return {"X-Forwarded-For": f"198.51.100.{IP['n']}"}

with TestClient(app) as c:
    def post(path, body, ip=None, token=None):
        h = dict(ip or fresh_ip())
        if token:
            h["Authorization"] = f"Bearer {token}"
        return c.post(f"/account/v1{path}", json=body, headers=h)

    def me(token):
        return c.get("/account/v1/me", headers={"Authorization": f"Bearer {token}"})

    print("[1] Sign up and confirm the email")
    r = post("/signup", {"email": "  Owner@Example.com ", "password": "medicine-123", "name": "Zahid"})
    check("sign-up accepted", r.status_code, 201)
    check("a confirmation email went out", OUTBOX[-1]["subject"], "Confirm your email for Curavo")
    check("...to the address, lower-cased", OUTBOX[-1]["to"], "owner@example.com")
    check("...with a link on the website", "https://curavo.test/account/verify?token=" in OUTBOX[-1]["body"], True)
    check("short password refused", post("/signup", {"email": "x@example.com", "password": "short"}).status_code, 400)
    check("bad email refused", post("/signup", {"email": "not-an-email", "password": "medicine-123"}).status_code, 400)
    check("cannot sign in before confirming",
          post("/login", {"email": "owner@example.com", "password": "medicine-123"}).status_code, 403)
    link = last_link("verify")
    r = post("/verify", {"token": link})
    check("the link confirms and signs in", (r.status_code, bool(r.json().get("token"))), (200, True))
    tok = r.json()["token"]
    check("...verified", me(tok).json()["email_verified"], True)
    check("the link works only once", post("/verify", {"token": link}).status_code, 400)
    check("a made-up link is refused", post("/verify", {"token": "nope"}).status_code, 400)

    print("[2] Nobody can tell which emails are registered")
    n = len(OUTBOX)
    a = post("/signup", {"email": "owner@example.com", "password": "another-pass1"})
    b = post("/signup", {"email": "brand-new@example.com", "password": "another-pass1"})
    check("sign-up: same answer for taken and new", (a.status_code, a.json()) == (b.status_code, b.json()), True)
    check("...the real owner is told by email", OUTBOX[n]["subject"], "You already have a Curavo account")
    a = post("/forgot", {"email": "owner@example.com"})
    b = post("/forgot", {"email": "nobody@example.com"})
    check("forgot: same answer either way", (a.status_code, a.json()) == (b.status_code, b.json()), True)
    a = post("/resend-verification", {"email": "brand-new@example.com"})
    b = post("/resend-verification", {"email": "nobody@example.com"})
    check("resend: same answer either way", (a.status_code, a.json()) == (b.status_code, b.json()), True)
    w1 = post("/login", {"email": "owner@example.com", "password": "wrong-pass1"})
    w2 = post("/login", {"email": "nobody@example.com", "password": "wrong-pass1"})
    check("sign-in: same message for unknown email and wrong password",
          (w1.status_code, w1.json()["detail"]) == (w2.status_code, w2.json()["detail"]), True)

    print("[3] Wrong passwords and lock-out")
    check("right password signs in", post("/login", {"email": "OWNER@example.com", "password": "medicine-123"}).status_code, 200)
    for i in range(10):
        post("/login", {"email": "owner@example.com", "password": f"wrong-{i}-xx"})
    r = post("/login", {"email": "owner@example.com", "password": "medicine-123"})
    check("after 10 wrong tries even the right one waits", r.status_code, 429)
    from curavo_cloud.db import SessionLocal
    from curavo_cloud.models import Account
    db = SessionLocal(); acc = db.query(Account).filter(Account.email == "owner@example.com").first()
    acc.locked_until = datetime.utcnow() - timedelta(seconds=1); db.commit(); db.close()
    check("...and works again after the wait", post("/login", {"email": "owner@example.com", "password": "medicine-123"}).status_code, 200)
    same_ip = {"X-Forwarded-For": "203.0.113.77"}
    codes = [post("/login", {"email": f"guess{i}@example.com", "password": "guess-pass1"}, ip=same_ip).status_code
             for i in range(32)]
    check("one address cannot guess forever (30 per 10 min)", codes[-1], 429)

    print("[4] Forgot password")
    other = post("/login", {"email": "owner@example.com", "password": "medicine-123"}).json()["token"]
    post("/forgot", {"email": "owner@example.com"})
    link = last_link("reset")
    check("a reset email went out", OUTBOX[-1]["subject"], "Reset your Curavo password")
    check("new password too short refused", post("/reset", {"token": link, "password": "short"}).status_code, 400)
    r = post("/reset", {"token": link, "password": "brand-new-pass9"})
    check("the link sets a new password and signs in", r.status_code, 200)
    check("other devices are signed out", me(other).status_code, 401)
    check("the reset link works only once", post("/reset", {"token": link, "password": "again-pass99"}).status_code, 400)
    check("old password no longer works", post("/login", {"email": "owner@example.com", "password": "medicine-123"}).status_code, 401)
    check("new one does", post("/login", {"email": "owner@example.com", "password": "brand-new-pass9"}).status_code, 200)
    post("/forgot", {"email": "owner@example.com"})
    link = last_link("reset")
    from curavo_cloud.models import AccountToken
    db = SessionLocal()
    db.query(AccountToken).filter(AccountToken.purpose == "RESET", AccountToken.used_at.is_(None)).update(
        {"expires_at": datetime.utcnow() - timedelta(minutes=1)})
    db.commit(); db.close()
    check("an expired reset link is refused", post("/reset", {"token": link, "password": "late-pass999"}).status_code, 400)

    print("[5] Continue with Google")
    r = post("/google", {"credential": google_cred("g-111", "Shop.Owner@gmail.com")})
    check("a genuine Google credential signs in", r.status_code, 200)
    gtok = r.json()["token"]
    p = me(gtok).json()
    check("...a new, verified account", (p["email"], p["email_verified"], p["google"], p["has_password"]),
          ("shop.owner@gmail.com", True, True, False))
    check("same Google person -> same account", post("/google", {"credential": google_cred("g-111", "shop.owner@gmail.com")}).json()["account"]["id"], p["id"])
    check("Google-only account: password sign-in explains",
          "Google" in post("/login", {"email": "shop.owner@gmail.com", "password": "whatever-1"}).json()["detail"], True)
    r = post("/google", {"credential": google_cred("g-222", "owner@example.com")})
    check("same email as a password account -> linked, not duplicated", r.json()["account"]["id"], me(
        post("/login", {"email": "owner@example.com", "password": "brand-new-pass9"}).json()["token"]).json()["id"])
    forged = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    check("a credential NOT signed by Google is refused", post("/google", {"credential": google_cred("g-9", "evil@gmail.com", key=forged)}).status_code, 401)
    check("a credential for another app is refused", post("/google", {"credential": google_cred("g-9", "evil@gmail.com", aud="someone-else")}).status_code, 401)
    check("an expired credential is refused", post("/google", {"credential": google_cred("g-9", "evil@gmail.com", exp_min=-5)}).status_code, 401)
    check("an unverified Google email is refused", post("/google", {"credential": google_cred("g-9", "evil@gmail.com", verified=False)}).status_code, 401)

    print("[6] My account")
    check("needs a sign-in", c.get("/account/v1/me").status_code, 401)
    check("a forged session is refused", me("eyJhbGciOiJIUzI1NiJ9.e30.x").status_code, 401)
    r = c.patch("/account/v1/me", headers={"Authorization": f"Bearer {gtok}"},
                json={"shop_name": "Brahmaputra Pharmacy", "town": "Dhubri", "phone": "9864012345", "gstin": "18aewph3140n1zz"})
    check("shop details saved", (r.status_code, r.json()["shop"]["name"], r.json()["shop"]["gstin"]),
          (200, "Brahmaputra Pharmacy", "18AEWPH3140N1ZZ"))
    check("bad GSTIN refused", c.patch("/account/v1/me", headers={"Authorization": f"Bearer {gtok}"}, json={"gstin": "123"}).status_code, 400)
    r = c.post("/account/v1/me/password", headers={"Authorization": f"Bearer {gtok}"}, json={"new": "offline-pass1"})
    check("a Google account can add a password", r.status_code, 200)
    check("...and then sign in with it", post("/login", {"email": "shop.owner@gmail.com", "password": "offline-pass1"}).status_code, 200)
    check("changing it needs the current one", c.post("/account/v1/me/password",
          headers={"Authorization": f"Bearer {r.json()['token']}"}, json={"current": "wrong", "new": "next-pass123"}).status_code, 400)

    print("[7] The website may call it; other sites may not")
    pre = c.options("/account/v1/login", headers={"Origin": "https://curavo.in", "Access-Control-Request-Method": "POST",
                                                   "Access-Control-Request-Headers": "content-type,authorization"})
    check("curavo.in allowed", pre.headers.get("access-control-allow-origin"), "https://curavo.in")
    pre = c.options("/account/v1/login", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    check("other sites not allowed", pre.headers.get("access-control-allow-origin"), None)

shutil.rmtree(sandbox, ignore_errors=True)
print("\n" + "=" * 58)
print("ALL PASSED" if not FAILS else f"{len(FAILS)} FAILED: {FAILS}")
sys.exit(1 if FAILS else 0)
