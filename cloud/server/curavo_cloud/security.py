"""
Who is calling: a shop PC (device token) or ARZ (control-panel login).

SHOP PCs: on first contact a PC registers its shop code and receives a random
device token.  The server keeps only the token's sha256, so a leaked server
database cannot be used to impersonate a shop.  Every later request carries
    X-Shop-Code: 7K3P9QXM
    Authorization: Bearer <device token>

ARZ: username + password (bcrypt) -> a signed login token valid 12 hours.
"""
import hashlib
import hmac
from datetime import datetime, timedelta

import bcrypt
from fastapi import Depends, Header, HTTPException
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from curavo_cloud.config import settings
from curavo_cloud.db import get_db
from curavo_cloud.models import AdminUser, Shop

ADMIN_TOKEN_HOURS = 12


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def check_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode("utf-8"), hashed.encode("ascii"))
    except ValueError:
        return False


def _bearer(authorization: str) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing credentials.")
    return authorization[7:].strip()


def current_shop(
    x_shop_code: str = Header(default=""),
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
) -> Shop:
    token = _bearer(authorization)
    shop = db.query(Shop).filter(Shop.shop_code == x_shop_code.upper()).first()
    if shop is None or not shop.token_hash or not hmac.compare_digest(shop.token_hash, hash_token(token)):
        raise HTTPException(status_code=401, detail="Unknown shop or device.")
    if shop.disabled:
        raise HTTPException(status_code=403, detail="This shop has been disabled by ARZ Solutions.")
    return shop


def make_admin_token(username: str) -> str:
    exp = datetime.utcnow() + timedelta(hours=ADMIN_TOKEN_HOURS)
    return jwt.encode({"sub": username, "exp": exp, "aud": "curavo-panel"}, settings.secret, algorithm="HS256")


def current_admin(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> AdminUser:
    token = _bearer(authorization)
    try:
        payload = jwt.decode(token, settings.secret, algorithms=["HS256"], audience="curavo-panel")
    except JWTError:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    user = db.query(AdminUser).filter(AdminUser.username == payload.get("sub")).first()
    if user is None:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return user
