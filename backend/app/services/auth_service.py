"""
Authentication business logic.

This file handles three separate concerns:
  1. Password hashing/checking  (bcrypt via passlib)
  2. JWT token creation/decoding (python-jose)
  3. The FastAPI dependency that protects endpoints requiring login

Route functions in routers/auth.py stay thin by calling these functions
instead of doing the work themselves.
"""
from datetime import datetime, timedelta

import bcrypt as _bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User

# --- Password hashing -------------------------------------------------------
# We use the bcrypt library directly. passlib 1.7.4 is not compatible with
# bcrypt 4+ (the API for reading the version string changed). Using bcrypt
# directly avoids that dependency conflict while keeping the same algorithm.

ALGORITHM = "HS256"  # HMAC-SHA256 — the most common JWT signing algorithm

# OAuth2PasswordBearer tells FastAPI where the login endpoint is so that
# the Swagger UI (/docs) can show a login button. It also extracts the
# Bearer token from the Authorization header on protected routes.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def hash_password(plain: str) -> str:
    """Turn a plain-text password into a bcrypt hash.  Store the hash, never the original."""
    hashed = _bcrypt.hashpw(plain.encode("utf-8"), _bcrypt.gensalt())
    return hashed.decode("utf-8")   # store as a plain string in the DB column


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if plain matches the stored hash, False otherwise."""
    return _bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


# --- JWT token --------------------------------------------------------------

def create_access_token(data: dict) -> str:
    """
    Build a signed JWT token that expires after the configured shift length.

    The token is signed with the SECRET_KEY so the server can verify it
    wasn't tampered with — but anyone can READ the payload, so never put
    sensitive data (passwords, full card numbers) inside a JWT.
    """
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)
    to_encode["exp"] = expire
    return jwt.encode(to_encode, settings.secret_key, algorithm=ALGORITHM)


# --- Current-user dependency ------------------------------------------------

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db:    Session = Depends(get_db),
) -> User:
    """
    FastAPI dependency that decodes the JWT and returns the matching User row.

    Usage in a route:  current_user: User = Depends(get_current_user)
    FastAPI will call this automatically and inject the User object.
    If the token is missing, invalid, or the user is disabled, it raises 401.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload  = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
        username: str = payload.get("sub")   # "sub" is the standard JWT field for subject
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.username == username).first()
    if user is None or not user.is_active:
        raise credentials_exception

    return user
