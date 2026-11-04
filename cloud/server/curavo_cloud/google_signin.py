"""
"Sign in with Google": checking the credential Google hands the website.

The website (Google's button) receives an ID token - a JWT signed by Google -
and posts it here.  We accept it only if Google really signed it (their public
keys, fetched from Google and cached for an hour), it was issued for OUR
client id, it has not expired, and Google says the email is verified.
"""
import json
import threading
import time
import urllib.request

from jose import JWTError, jwt

from curavo_cloud.config import settings

CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("accounts.google.com", "https://accounts.google.com")
_cache = {"at": 0.0, "keys": None}
_lock = threading.Lock()


class GoogleError(Exception):
    pass


def _fetch_certs() -> dict:
    with urllib.request.urlopen(CERTS_URL, timeout=10) as r:
        return json.loads(r.read())


# Replaced by the guard test with a test key set.
fetch_certs = _fetch_certs


def _keys() -> dict:
    with _lock:
        if _cache["keys"] is None or time.time() - _cache["at"] > 3600:
            _cache["keys"] = fetch_certs()
            _cache["at"] = time.time()
        return _cache["keys"]


def verify(credential: str) -> dict:
    """-> {"sub", "email", "name"} or raises GoogleError with a plain reason."""
    if not settings.google_client_ids:
        raise GoogleError("Google sign-in is not switched on yet.")
    try:
        header = jwt.get_unverified_header(credential)
        keyset = _keys()
        key = next((k for k in keyset.get("keys", []) if k.get("kid") == header.get("kid")), None)
        if key is None:                      # Google rotated its keys: fetch once more
            with _lock:
                _cache["keys"] = None
            keyset = _keys()
            key = next((k for k in keyset.get("keys", []) if k.get("kid") == header.get("kid")), None)
        if key is None:
            raise GoogleError("Google sign-in could not be checked. Please try again.")
        # The library checks one audience at a time; we may have several
        # client ids (website, phone), so the audience is checked just below.
        claims = jwt.decode(credential, key, algorithms=["RS256"],
                            options={"verify_aud": False, "verify_at_hash": False})
    except JWTError:
        raise GoogleError("Google sign-in could not be checked. Please try again.")
    aud = claims.get("aud")
    audiences = aud if isinstance(aud, list) else [aud]
    if not set(audiences) & set(settings.google_client_ids):          # issued for someone else's app
        raise GoogleError("Google sign-in could not be checked. Please try again.")
    if claims.get("iss") not in ISSUERS:
        raise GoogleError("Google sign-in could not be checked. Please try again.")
    if not claims.get("email") or not claims.get("email_verified"):
        raise GoogleError("Your Google account has no verified email address.")
    return {"sub": str(claims["sub"]), "email": claims["email"].strip().lower(), "name": claims.get("name") or ""}
