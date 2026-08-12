"""
Pydantic schemas for authentication.

Pydantic schemas define the SHAPE of data coming in from the browser
(requests) and going back out (responses). FastAPI uses them to validate
input and serialize output automatically.

These are different from the SQLAlchemy models in app/models/ — the models
describe database tables; these schemas describe JSON payloads.
"""
from typing import Optional

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    """
    What the browser sends when a user clicks 'Sign In'.

    `username` is a misnomer kept for backwards compatibility with the existing
    frontend: the login endpoint matches it against EITHER the username OR the
    email address, so the person at the counter can type whichever they
    remember.
    """
    username: str
    password: str


class TokenResponse(BaseModel):
    """The JWT token we send back after a successful login."""
    access_token: str
    token_type: str = "bearer"   # always "bearer" — this is the HTTP standard


class UserInfo(BaseModel):
    """Public information about the currently logged-in user."""
    id:        int
    username:  str
    full_name: str
    role_name: str   # the role's name string, e.g. "Owner"

    # from_attributes=True lets Pydantic read data from SQLAlchemy model
    # objects directly (instead of only from dicts).
    model_config = ConfigDict(from_attributes=True)


class LoginResponse(BaseModel):
    """The full response body for a successful login."""
    token: TokenResponse
    user:  UserInfo


class ProfileOut(BaseModel):
    """Full profile shown in the account menu / Edit Profile modal."""
    id:         int
    username:   str
    full_name:  Optional[str] = None
    email:      Optional[str] = None
    phone:      Optional[str] = None
    role:       str                       # the role's name string, e.g. "Owner"
    avatar_url: Optional[str] = None       # "/api/auth/me/avatar" or null
    # Only populated when the username was just changed.  The JWT identifies its
    # holder by username, so the token the browser holds dies with the old name;
    # this is its replacement, so the user is not thrown out mid-shift.
    access_token: Optional[str] = None


class ProfileUpdate(BaseModel):
    """
    Editable profile fields sent from the Edit Profile modal.

    username is a LOGIN CREDENTIAL, not a display name — changing it retires
    the old one immediately.  Validated in the route (length, allowed
    characters, uniqueness) rather than here, so the error messages can say
    exactly what is wrong.
    """
    username:  Optional[str] = None
    full_name: Optional[str] = None
    email:     Optional[str] = None
    phone:     Optional[str] = None


class PasswordChange(BaseModel):
    """Body for the Change Password action."""
    current_password: str
    new_password:     str
