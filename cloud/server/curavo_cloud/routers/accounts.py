"""
Customer accounts - the shop OWNER's sign-in for the website, the shop PC and
the phone (decided 4 Nov 2026).  Email + password, or Google.

  POST  /account/v1/signup               {email, password, name}
  POST  /account/v1/verify               {token}            (link in the email)
  POST  /account/v1/resend-verification  {email}
  POST  /account/v1/login                {email, password}
  POST  /account/v1/google               {credential}       (Google's button)
  POST  /account/v1/forgot               {email}
  POST  /account/v1/reset                {token, password}  (link in the email)
  GET   /account/v1/me
  PATCH /account/v1/me                   {name, shop_name, phone, town, gstin}
  POST  /account/v1/me/password          {current?, new}

A sign-in returns {"token": ...}: a signed session (30 days) the website,
PC or phone sends back as  Authorization: Bearer <token>.

Rules that keep accounts safe:
  * Passwords are bcrypt-hashed; at least 8 characters.
  * "Is this email registered?" is never revealed: sign-up, forgot-password and
    resend all give the same answer whether or not the address exists.
  * 10 wrong passwords lock the account for 15 minutes; one address (IP) gets
    30 tries per 10 minutes across all accounts.
  * Email links work once and expire (verify 3 days, reset 1 hour); the server
    stores only their sha256.  A password reset signs out every device.
"""
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from curavo_cloud import google_signin, mailer
from curavo_cloud.config import settings
from curavo_cloud.db import get_db
from curavo_cloud.models import Account, AccountToken
from curavo_cloud.security import check_password, hash_password, hash_token

router = APIRouter(prefix="/account/v1", tags=["Accounts"])

SESSION_DAYS = 30
VERIFY_HOURS = 72
RESET_MINUTES = 60
MAX_FAILED = 10
LOCK_MINUTES = 15
PER_IP_TRIES = 30
PER_IP_WINDOW = 600
MIN_PASSWORD = 8
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

SAME_ANSWER = {"ok": True, "message": "If that address can receive email, a message is on its way."}


# --------------------------------------------------------------- helpers

_ip_lock = threading.Lock()
_ip_hits = defaultdict(deque)


def _client_ip(request: Request) -> str:
    return request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else "?")


def _throttle(request: Request):
    """At most PER_IP_TRIES sign-in style requests per address per 10 minutes."""
    now = time.time()
    with _ip_lock:
        q = _ip_hits[_client_ip(request)]
        while q and now - q[0] > PER_IP_WINDOW:
            q.popleft()
        if len(q) >= PER_IP_TRIES:
            raise HTTPException(status_code=429, detail="Too many attempts. Please wait a few minutes and try again.")
        q.append(now)


def _email(raw: str) -> str:
    e = (raw or "").strip().lower()
    if not _EMAIL_RE.match(e) or len(e) > 254:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")
    return e


def _check_new_password(pw: str):
    if len(pw or "") < MIN_PASSWORD:
        raise HTTPException(status_code=400, detail=f"Use at least {MIN_PASSWORD} characters for the password.")
    if len(pw) > 200:
        raise HTTPException(status_code=400, detail="That password is too long.")


def make_session(acc: Account) -> str:
    exp = datetime.utcnow() + timedelta(days=SESSION_DAYS)
    return jwt.encode({"sub": str(acc.id), "sv": acc.session_version, "exp": exp, "aud": "curavo-account"},
                      settings.account_secret, algorithm="HS256")


def current_account(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> Account:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Please sign in.")
    try:
        p = jwt.decode(authorization[7:].strip(), settings.account_secret, algorithms=["HS256"],
                       audience="curavo-account")
    except JWTError:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    acc = db.get(Account, int(p.get("sub", 0)))
    if acc is None or acc.session_version != p.get("sv") or acc.disabled:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return acc


def _new_link_token(db, acc: Account, purpose: str, life: timedelta) -> str:
    raw = secrets.token_urlsafe(32)
    db.add(AccountToken(account_id=acc.id, purpose=purpose, token_hash=hash_token(raw),
                        expires_at=datetime.utcnow() + life))
    return raw


def _use_link_token(db, raw: str, purpose: str) -> Account:
    t = db.query(AccountToken).filter(AccountToken.token_hash == hash_token(raw or ""),
                                      AccountToken.purpose == purpose).first()
    if t is None or t.used_at is not None:
        raise HTTPException(status_code=400, detail="This link has already been used or is not valid.")
    if datetime.utcnow() > t.expires_at:
        raise HTTPException(status_code=400, detail="This link has expired. Please ask for a new one.")
    t.used_at = datetime.utcnow()
    acc = db.get(Account, t.account_id)
    if acc is None or acc.disabled:
        raise HTTPException(status_code=400, detail="This link is not valid.")
    return acc


def _send_verification(db, acc: Account):
    raw = _new_link_token(db, acc, "VERIFY", timedelta(hours=VERIFY_HOURS))
    mailer.send(acc.email, "Confirm your email for Curavo",
                f"Hello{(' ' + acc.name) if acc.name else ''},\n\n"
                f"Please confirm your email address to finish creating your Curavo account:\n\n"
                f"{settings.site_url}/account/verify?token={raw}\n\n"
                f"The link works once and for {VERIFY_HOURS // 24} days.\n"
                f"If you did not sign up for Curavo, you can ignore this email.\n\n- Curavo, by ARZ Solutions")


def _profile(acc: Account) -> dict:
    return {"id": acc.id, "email": acc.email, "name": acc.name or "", "email_verified": acc.email_verified,
            "has_password": bool(acc.password_hash), "google": bool(acc.google_sub),
            "shop": {"name": acc.shop_name or "", "phone": acc.phone or "", "town": acc.town or "",
                     "gstin": acc.gstin or ""},
            "subscription": {"plan": acc.plan, "paid_until": acc.paid_until,
                             "free_month": bool(acc.on_free_month),
                             "free_month_available": not acc.free_month_used,
                             "requested_plan": acc.requested_plan,
                             "requested_at": acc.requested_at.isoformat() + "Z" if acc.requested_at else None}}


def _signed_in(db, acc: Account) -> dict:
    acc.last_login_at = datetime.utcnow()
    acc.failed_logins = 0
    acc.locked_until = None
    db.commit()
    return {"token": make_session(acc), "account": _profile(acc)}


# --------------------------------------------------------------- sign up / verify

class SignupIn(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., max_length=200)
    name: str = Field(default="", max_length=120)


@router.post("/signup", status_code=201)
def signup(body: SignupIn, request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    email = _email(body.email)
    _check_new_password(body.password)
    acc = db.query(Account).filter(Account.email == email).first()
    if acc is not None:
        # Same answer as a new sign-up (nobody learns the address is taken);
        # the real owner gets an email that says so.
        mailer.send(email, "You already have a Curavo account",
                    "Someone (hopefully you) tried to create a Curavo account with this email address, "
                    "but you already have one.\n\nSign in at " + settings.site_url + "/account "
                    "- or use 'Forgot password' there if you need a new password.\n\n- Curavo, by ARZ Solutions")
        return SAME_ANSWER
    acc = Account(email=email, name=body.name.strip()[:120], password_hash=hash_password(body.password))
    db.add(acc)
    db.flush()
    _send_verification(db, acc)
    db.commit()
    return SAME_ANSWER


class TokenIn(BaseModel):
    token: str = Field(..., max_length=200)


@router.post("/verify")
def verify(body: TokenIn, db: Session = Depends(get_db)):
    acc = _use_link_token(db, body.token, "VERIFY")
    acc.email_verified = True
    return _signed_in(db, acc)


class EmailIn(BaseModel):
    email: str = Field(..., max_length=254)


@router.post("/resend-verification")
def resend_verification(body: EmailIn, request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    acc = db.query(Account).filter(Account.email == _email(body.email)).first()
    if acc is not None and not acc.email_verified and not acc.disabled:
        _send_verification(db, acc)
        db.commit()
    return SAME_ANSWER


# --------------------------------------------------------------- sign in

class LoginIn(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., max_length=200)


WRONG = "Wrong email or password."
# Checked against when the email is unknown, so a wrong address takes as long
# as a wrong password (timing would otherwise reveal which emails exist).
_DUMMY_HASH = hash_password(secrets.token_hex(16))


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    email = (body.email or "").strip().lower()
    acc = db.query(Account).filter(Account.email == email).first()
    now = datetime.utcnow()
    if acc is None or acc.disabled:
        check_password(body.password, _DUMMY_HASH)   # same time as a real check
        raise HTTPException(status_code=401, detail=WRONG)
    if acc.locked_until and now < acc.locked_until:
        raise HTTPException(status_code=429, detail="Too many wrong passwords. Try again in 15 minutes, "
                                                    "or use 'Forgot password'.")
    if not acc.password_hash or not check_password(body.password, acc.password_hash):
        acc.failed_logins = (acc.failed_logins or 0) + 1
        if acc.failed_logins >= MAX_FAILED:
            acc.locked_until = now + timedelta(minutes=LOCK_MINUTES)
            acc.failed_logins = 0
        db.commit()
        if not acc.password_hash:
            raise HTTPException(status_code=401, detail="This account signs in with Google. Use 'Continue with Google'.")
        raise HTTPException(status_code=401, detail=WRONG)
    if not acc.email_verified:
        raise HTTPException(status_code=403, detail="Please confirm your email first - we sent you a link. "
                                                    "No email? Use 'Send the link again'.")
    return _signed_in(db, acc)


class GoogleIn(BaseModel):
    credential: str = Field(..., max_length=4096)


@router.post("/google")
def google(body: GoogleIn, request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    try:
        g = google_signin.verify(body.credential)
    except google_signin.GoogleError as e:
        raise HTTPException(status_code=401, detail=str(e))
    acc = db.query(Account).filter(Account.google_sub == g["sub"]).first()
    if acc is None:
        # Same email signed up with a password before: Google has verified the
        # address, so it is the same person - link the two.
        acc = db.query(Account).filter(Account.email == g["email"]).first()
        if acc is None:
            acc = Account(email=g["email"], name=g["name"][:120])
            db.add(acc)
        acc.google_sub = g["sub"]
        acc.email_verified = True
        if not acc.name:
            acc.name = g["name"][:120]
    if acc.disabled:
        raise HTTPException(status_code=403, detail="This account has been disabled. Contact ARZ Solutions.")
    db.flush()
    return _signed_in(db, acc)


# --------------------------------------------------------------- forgot / reset

@router.post("/forgot")
def forgot(body: EmailIn, request: Request, db: Session = Depends(get_db)):
    _throttle(request)
    acc = db.query(Account).filter(Account.email == _email(body.email)).first()
    if acc is not None and not acc.disabled:
        raw = _new_link_token(db, acc, "RESET", timedelta(minutes=RESET_MINUTES))
        mailer.send(acc.email, "Reset your Curavo password",
                    "To choose a new password for your Curavo account, open this link:\n\n"
                    f"{settings.site_url}/account/reset?token={raw}\n\n"
                    f"It works once and for {RESET_MINUTES} minutes. If you did not ask for this, ignore this "
                    "email - your password stays as it is.\n\n- Curavo, by ARZ Solutions")
        db.commit()
    return SAME_ANSWER


class ResetIn(BaseModel):
    token: str = Field(..., max_length=200)
    password: str = Field(..., max_length=200)


@router.post("/reset")
def reset(body: ResetIn, db: Session = Depends(get_db)):
    _check_new_password(body.password)
    acc = _use_link_token(db, body.token, "RESET")
    acc.password_hash = hash_password(body.password)
    acc.email_verified = True             # they opened a link sent to it
    acc.session_version = (acc.session_version or 1) + 1   # sign out everywhere else
    return _signed_in(db, acc)


# --------------------------------------------------------------- my account

@router.get("/me")
def me(acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    """The profile, plus the shop PCs linked to this account (newest check-in first)."""
    from curavo_cloud.models import Shop
    shops = db.query(Shop).filter(Shop.account_id == acc.id).order_by(Shop.last_seen_at.desc()).all()
    return {**_profile(acc), "pcs": [
        {"shop_name": s.shop_name or "", "shop_code": f"{s.shop_code[:4]}-{s.shop_code[4:]}",
         "last_seen_at": s.last_seen_at.isoformat() + "Z" if s.last_seen_at else None,
         "app_version": s.app_version, "licence_state": s.licence_state, "licence_until": s.licence_until}
        for s in shops]}


class ProfileIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    shop_name: str | None = Field(default=None, max_length=150)
    phone: str | None = Field(default=None, max_length=20)
    town: str | None = Field(default=None, max_length=80)
    gstin: str | None = Field(default=None, max_length=20)


@router.patch("/me")
def update_me(body: ProfileIn, acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    for field in ("name", "shop_name", "phone", "town", "gstin"):
        v = getattr(body, field)
        if v is not None:
            setattr(acc, field, v.strip() or None)
    if acc.gstin:
        acc.gstin = acc.gstin.upper()
        if not re.match(r"^[0-9A-Z]{15}$", acc.gstin):
            raise HTTPException(status_code=400, detail="A GSTIN has 15 letters and digits.")
    db.commit()
    return _profile(acc)


class PasswordIn(BaseModel):
    current: str = Field(default="", max_length=200)
    new: str = Field(..., max_length=200)


@router.post("/me/password")
def change_password(body: PasswordIn, acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    if acc.password_hash and not check_password(body.current, acc.password_hash):
        raise HTTPException(status_code=400, detail="Your current password is not right.")
    _check_new_password(body.new)
    acc.password_hash = hash_password(body.new)     # a Google-only account may add one
    acc.session_version = (acc.session_version or 1) + 1
    db.commit()
    return {"token": make_session(acc), "account": _profile(acc)}


# --------------------------------------------------------------- choose a plan
# No online payment yet: the owner chooses a plan, ARZ phones them, collects
# the money by hand and switches the plan on in Curavo Control.

PLAN_NAMES = {"MONTHLY": ("Monthly", "Rs 589"), "HALF_YEARLY": ("Half-yearly", "Rs 2,899"),
              "YEARLY": ("Yearly", "Rs 4,999")}


class PlanRequestIn(BaseModel):
    plan: str = Field(..., max_length=20)


@router.post("/me/plan-request")
def request_plan(body: PlanRequestIn, acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    if body.plan not in PLAN_NAMES:
        raise HTTPException(status_code=400, detail="Please choose one of the plans.")
    if not (acc.shop_name and acc.phone):
        raise HTTPException(status_code=400, detail="Please fill in your shop name and phone number "
                                                    "under 'Your shop' first, so our team can reach you.")
    now = datetime.utcnow()
    repeat = (acc.requested_plan == body.plan and acc.requested_at
              and now - acc.requested_at < timedelta(hours=1))
    acc.requested_plan = body.plan
    acc.requested_at = now
    db.commit()
    if not repeat:                       # pressing it twice sends no second round of emails
        name, price = PLAN_NAMES[body.plan]
        first = not acc.free_month_used      # a new shop: activation starts the free month
        if settings.sales_email:
            todo = ("NEW SHOP - call them, then press 'Activate - start free month' in Curavo Control > Accounts. "
                    "Collect the plan's price before the free month ends."
                    if first else "Please call them to collect the payment, then save the subscription in Curavo Control > Accounts.")
            mailer.send(settings.sales_email, f"Curavo plan request: {name} - {acc.shop_name}",
                        f"A shop chose a plan on curavo.in. {todo}\n\n"
                        f"Plan:   {name} ({price}, GST included)\n"
                        f"Shop:   {acc.shop_name}{(', ' + acc.town) if acc.town else ''}\n"
                        f"Phone:  {acc.phone}\n"
                        f"Name:   {acc.name or '-'}\n"
                        f"Email:  {acc.email}\n"
                        f"GSTIN:  {acc.gstin or '-'}\n")
        mailer.send(acc.email, f"We got your request for Curavo {name}",
                    f"Hello{(' ' + acc.name) if acc.name else ''},\n\n"
                    f"Thank you for choosing Curavo {name} ({price}, GST included) for {acc.shop_name}.\n\n"
                    + (f"Our team will contact you soon on {acc.phone} to activate your account. Your first month "
                       f"is free: you pay for the plan only before it ends. Once activated, the download appears "
                       f"in your account.\n\n- Curavo, by ARZ Solutions" if first else
                       f"Our team will contact you soon on {acc.phone} to complete the payment. "
                       f"As soon as it is done, your subscription is extended and reaches your shop PC "
                       f"by itself - nothing to copy or type.\n\n- Curavo, by ARZ Solutions"))
    return _profile(acc)


@router.delete("/me/plan-request")
def cancel_plan_request(acc: Account = Depends(current_account), db: Session = Depends(get_db)):
    acc.requested_plan = None
    acc.requested_at = None
    db.commit()
    return _profile(acc)


# --------------------------------------------------------------- download
# The installer is offered only to an ACTIVE account (free month or paid).
# My account asks for a link; it works for 15 minutes.

DOWNLOAD_MINUTES = 15


def subscription_active(acc: Account) -> bool:
    from curavo_cloud.dates import today_ist
    return bool(acc.paid_until and acc.paid_until >= today_ist().isoformat())


def download_token_ok(t: str) -> bool:
    try:
        jwt.decode(t or "", settings.account_secret, algorithms=["HS256"], audience="curavo-download")
        return True
    except JWTError:
        return False


@router.get("/download")
def download_link(acc: Account = Depends(current_account)):
    if not subscription_active(acc):
        raise HTTPException(status_code=403, detail="The download is available once your account is activated.")
    t = jwt.encode({"sub": str(acc.id), "aud": "curavo-download",
                    "exp": datetime.utcnow() + timedelta(minutes=DOWNLOAD_MINUTES)},
                   settings.account_secret, algorithm="HS256")
    return {"url": f"/download/windows?t={t}", "minutes": DOWNLOAD_MINUTES}
