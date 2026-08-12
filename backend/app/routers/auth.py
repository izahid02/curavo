"""
Authentication API endpoints.

POST /api/auth/login  — accepts username+password, returns a JWT token
GET  /api/auth/me     — returns the currently logged-in user (token required)

"Thin routes": the actual work (password check, token creation) lives in
app/services/auth_service.py.  Routes just call those functions and return.
"""
import mimetypes
import os
import re

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_avatars_dir, get_db
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    LoginResponse,
    PasswordChange,
    ProfileOut,
    ProfileUpdate,
    TokenResponse,
    UserInfo,
)
from app.services.auth_service import (
    create_access_token,
    get_current_user,
    hash_password,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["Auth"])

# Which uploaded image types we accept for a profile photo, mapped to the
# file extension we store them under.  We keep the original format (no
# conversion) so we don't need an image library like Pillow installed.
AVATAR_TYPES = {
    "image/jpeg": "jpg",
    "image/jpg":  "jpg",   # some systems report JPGs with this non-standard type
    "image/png":  "png",
    "image/webp": "webp",
}
AVATAR_MAX_BYTES = 5 * 1024 * 1024  # 5 MB

# What a username may contain: letters, digits and underscore only.
# No spaces (they are invisible at the end of a typed name and would silently
# break sign-in) and no punctuation that could be confused with an email.
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")


def _build_profile(user: User, access_token: str | None = None) -> ProfileOut:
    """
    Assemble the ProfileOut payload for a user row.

    access_token is only filled in when the username just changed: the JWT
    identifies its holder by username, so the token the browser is holding
    stops resolving the instant the name does.  Handing back a fresh one lets
    the frontend swap it in without bouncing the pharmacist to the login screen
    mid-shift.
    """
    return ProfileOut(
        access_token = access_token,
        id         = user.id,
        username   = user.username,
        full_name  = user.full_name,
        email      = user.email,
        phone      = user.phone,
        role       = user.role.name if user.role else "Staff",
        # Only advertise an avatar URL when a photo is actually on file.
        avatar_url = "/api/auth/me/avatar" if user.avatar_path else None,
    )


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    """
    Validate credentials and return a JWT token.

    The frontend saves this token and sends it with every subsequent request.
    If credentials are wrong we always return the same vague "Invalid credentials"
    message — never say *which* field was wrong; that would help an attacker.

    The identifier field accepts EITHER a username OR an email address, because
    the person at the counter remembers one or the other and should not have to
    know which one the account was created with.  func.lower() on both sides
    makes the match case-insensitive: an email typed with a capital letter is
    the same address, and SQLite's default comparison would otherwise reject it.
    """
    identifier = (body.username or "").strip()
    user = (
        db.query(User)
        .filter(
            or_(
                func.lower(User.username) == identifier.lower(),
                # Users created before the email column existed have NULL here,
                # which simply never matches — no special case needed.
                func.lower(User.email) == identifier.lower(),
            )
        )
        .first()
    )

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )

    # The token payload identifies the user by username ("sub" = subject).
    token_str = create_access_token({"sub": user.username})

    return LoginResponse(
        token=TokenResponse(access_token=token_str),
        user=UserInfo(
            id=user.id,
            username=user.username,
            full_name=user.full_name,
            role_name=user.role.name,
        ),
    )


@router.get("/me", response_model=UserInfo)
def get_me(current_user: User = Depends(get_current_user)):
    """
    Return the currently logged-in user's profile.

    This endpoint is protected — the browser must send a valid JWT in the
    Authorization header, like:  Authorization: Bearer <token>
    """
    return UserInfo(
        id=current_user.id,
        username=current_user.username,
        full_name=current_user.full_name,
        role_name=current_user.role.name,
    )


# ---------------------------------------------------------------------------
# Account menu — full profile, edit details, avatar photo, change password
# ---------------------------------------------------------------------------

@router.get("/me/profile", response_model=ProfileOut)
def get_my_profile(current_user: User = Depends(get_current_user)):
    """Return the logged-in user's full profile for the account menu."""
    return _build_profile(current_user)


@router.put("/me/profile", response_model=ProfileOut)
def update_my_profile(
    body: ProfileUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Update the logged-in user's contact details, and optionally their username.

    Only fields that are actually sent (non-None) are changed, so a partial
    update never wipes an unrelated field.  Empty strings are treated as
    "clear this optional field" for email/phone.

    ⚠ CHANGING THE USERNAME CHANGES HOW YOU SIGN IN.  The old name stops
    working immediately, and the JWT identifies its holder by username ("sub"),
    so the current token is dead the moment the change commits.  The response
    carries a fresh token for exactly that reason — see below.
    """
    if body.username is not None:
        new_username = body.username.strip()
        # Validate before touching anything: a username is a login credential,
        # and a blank or duplicate one locks the user out of their own account.
        if len(new_username) < 3:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Username must be at least 3 characters.",
            )
        if not USERNAME_PATTERN.fullmatch(new_username):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Username may only contain letters, numbers and underscores — no spaces.",
            )
        # Case-insensitive uniqueness: "Admin" and "admin" must not both exist,
        # because login itself matches case-insensitively.
        taken = (
            db.query(User.id)
            .filter(
                func.lower(User.username) == new_username.lower(),
                User.id != current_user.id,
            )
            .first()
        )
        if taken:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Username already taken",
            )
        current_user.username = new_username

    if body.full_name is not None:
        # full_name is required at the DB level — ignore an empty value rather
        # than storing a blank name.
        new_name = body.full_name.strip()
        if new_name:
            current_user.full_name = new_name
    if body.email is not None:
        current_user.email = body.email.strip() or None
    if body.phone is not None:
        current_user.phone = body.phone.strip() or None

    db.commit()
    db.refresh(current_user)

    # Only mint a new token when the username actually moved — a name/phone
    # edit leaves the existing token perfectly valid.
    fresh_token = None
    if body.username is not None:
        fresh_token = create_access_token({"sub": current_user.username})

    return _build_profile(current_user, access_token=fresh_token)


@router.post("/me/avatar")
async def upload_my_avatar(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Upload / replace the logged-in user's profile photo.

    Validates the MIME type (JPEG / PNG / WebP) and a 5 MB size cap, then
    stores the image on disk as  avatars/{user_id}.{ext}.  Any previous photo
    for this user (possibly a different extension) is removed first so we never
    leave orphaned files behind.
    """
    # ---- Permissive validation: fall back to the file extension ------------
    # Browsers are inconsistent about the MIME type they attach to an upload.
    # Some send 'application/octet-stream' (a generic "just bytes" type) or an
    # empty string.  So instead of trusting the MIME type alone, we also look
    # at the file's extension and accept the file if EITHER agrees it's an image.
    ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''

    ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp'}
    MIME_TO_EXT = {
        'image/jpeg': 'jpg',
        'image/jpg':  'jpg',
        'image/png':  'png',
        'image/webp': 'webp',
        'application/octet-stream': ext,  # some browsers send this
        '': ext,                          # empty content type
    }

    # Decide which extension we'll store the file under.  If the MIME type is
    # one we know, use its mapping; otherwise fall back to the file extension.
    save_ext = MIME_TO_EXT.get(file.content_type, ext)

    if save_ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"File type not supported. Got: {file.content_type}, ext: {ext}. "
                "Use JPG, PNG, or WebP."
            ),
        )

    # 'jpeg' and 'jpg' are the same format — normalise to 'jpg' on disk so the
    # cleanup loop below (which iterates AVATAR_TYPES values) can find it later.
    if save_ext == 'jpeg':
        save_ext = 'jpg'

    # Read and check size.
    data = await file.read()
    if len(data) > AVATAR_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File too large ({len(data) // 1024} KB). Maximum is 5 MB.",
        )

    avatars_dir = get_avatars_dir()

    # Remove any existing avatar for this user (any extension) before saving,
    # so a PNG→JPG switch doesn't leave the old file lying around.
    for old_ext in AVATAR_TYPES.values():
        old_file = avatars_dir / f"{current_user.id}.{old_ext}"
        if old_file.exists():
            try:
                os.remove(old_file)
            except OSError:
                pass

    stored_name = f"{current_user.id}.{save_ext}"
    with open(avatars_dir / stored_name, "wb") as f:
        f.write(data)

    current_user.avatar_path = stored_name
    db.commit()

    return {"avatar_url": "/api/auth/me/avatar"}


@router.get("/me/avatar")
def get_my_avatar(current_user: User = Depends(get_current_user)):
    """
    Stream the logged-in user's profile photo back as an image.

    The frontend fetches this with its auth header and turns it into an
    object URL for the <img> tag.  Returns 404 when no photo is set or the
    file has gone missing from disk.
    """
    if not current_user.avatar_path:
        raise HTTPException(status_code=404, detail="No avatar set.")

    file_path = get_avatars_dir() / current_user.avatar_path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Avatar file is missing.")

    # Guess the content type from the stored extension (jpg/png/webp).
    media_type = mimetypes.guess_type(str(file_path))[0] or "image/jpeg"
    return FileResponse(path=str(file_path), media_type=media_type)


@router.put("/me/password")
def change_my_password(
    body: PasswordChange,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Change the logged-in user's password.

    Requires the current password to match before setting the new one, so a
    walk-up user at an unlocked counter cannot silently hijack the account.
    """
    if not verify_password(body.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    if len(body.new_password) < 6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be at least 6 characters.",
        )

    current_user.password_hash = hash_password(body.new_password)
    db.commit()
    return {"success": True}
