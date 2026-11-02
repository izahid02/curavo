"""
Tables of the Curavo cloud server.

Everything here is ABOUT shops, never patient data: the backups themselves are
stored as locked files on disk (see storage.py) that this server cannot open.
"""
from datetime import datetime

from sqlalchemy import (Boolean, Column, DateTime, ForeignKey, Integer, String,
                        Text, UniqueConstraint, BigInteger)

from curavo_cloud.db import Base


def utcnow():
    return datetime.utcnow()


class Shop(Base):
    """One Curavo installation, known by its shop code (e.g. 7K3P9QXM)."""
    __tablename__ = "shops"

    id              = Column(Integer, primary_key=True)
    shop_code       = Column(String(16), unique=True, nullable=False, index=True)
    shop_name       = Column(String(150))
    # sha256 of the secret the shop PC sends with every request.  NULL after
    # "Reset device" in the panel: the next PC to register takes the shop over.
    token_hash      = Column(String(64))
    registered_at   = Column(DateTime, default=utcnow)
    disabled        = Column(Boolean, default=False, nullable=False)
    notes           = Column(Text)

    # Latest heartbeat, copied out so the shops list is one cheap query.
    last_seen_at    = Column(DateTime)
    app_version     = Column(String(20))
    os_name         = Column(String(80))
    machine_fp      = Column(String(64))
    # Two different PCs reporting under one shop code within a day = a copied
    # install (or a second counter PC - Curavo is single-PC for now).
    machine_conflict_at = Column(DateTime)
    other_machine_fp    = Column(String(64))

    licence_state   = Column(String(10))      # TRIAL / ACTIVE / GRACE / EXPIRED
    licence_until   = Column(String(10))      # YYYY-MM-DD (paid) or trial end
    licence_serial  = Column(Integer)
    licence_days_left = Column(Integer)

    last_backup_at  = Column(DateTime)
    last_backup_size = Column(BigInteger)
    heartbeat_json  = Column(Text)            # the full last heartbeat, for the panel

    # A renewed licence key waiting to be delivered on the next heartbeat.
    pending_licence_key   = Column(Text)
    pending_licence_until = Column(String(10))
    pending_licence_set_at = Column(DateTime)

    # A PILOT shop gets a new release first (status PILOT); everyone else only
    # once ARZ moves it to ALL.  Set from the shop's page in the panel.
    pilot = Column(Boolean, default=False, nullable=False, server_default="0")


class Heartbeat(Base):
    """A shop checking in (every ~15 minutes).  Kept 30 days."""
    __tablename__ = "heartbeats"

    id          = Column(Integer, primary_key=True)
    shop_id     = Column(Integer, ForeignKey("shops.id"), index=True, nullable=False)
    at          = Column(DateTime, default=utcnow, index=True)
    app_version = Column(String(20))
    payload     = Column(Text)


class Backup(Base):
    """One locked backup file on disk."""
    __tablename__ = "backups"

    id          = Column(Integer, primary_key=True)
    shop_id     = Column(Integer, ForeignKey("shops.id"), index=True, nullable=False)
    uploaded_at = Column(DateTime, default=utcnow, index=True)
    created_at  = Column(String(32))          # when the shop PC took it (its clock)
    size        = Column(BigInteger)
    sha256      = Column(String(64))
    app_version = Column(String(20))
    filename    = Column(String(200))         # inside settings.backup_dir/<shop_code>/


class ErrorGroup(Base):
    """
    One kind of error at one shop.  The same crash happening 40 times is ONE
    row with count=40, so the panel shows problems, not noise.
    """
    __tablename__ = "error_groups"
    __table_args__ = (UniqueConstraint("shop_id", "fingerprint"),)

    id          = Column(Integer, primary_key=True)
    shop_id     = Column(Integer, ForeignKey("shops.id"), index=True, nullable=False)
    fingerprint = Column(String(64), nullable=False)
    source      = Column(String(20))          # backend / screen / startup
    kind        = Column(String(120))         # e.g. KeyError, TypeError
    message     = Column(Text)
    stack       = Column(Text)
    route       = Column(String(200))         # API path or screen
    app_version = Column(String(20))          # version when last seen
    first_seen  = Column(DateTime)
    last_seen   = Column(DateTime, index=True)
    count       = Column(Integer, default=0)
    resolved_at = Column(DateTime)
    # Marked fixed, then it happened again.
    regressed   = Column(Boolean, default=False, nullable=False)


class AdminUser(Base):
    __tablename__ = "admin_users"

    id            = Column(Integer, primary_key=True)
    username      = Column(String(50), unique=True, nullable=False)
    password_hash = Column(String(100), nullable=False)
    created_at    = Column(DateTime, default=utcnow)


class AdminAudit(Base):
    """Who did what in the control panel - resets, keys sent, notes."""
    __tablename__ = "admin_audit"

    id      = Column(Integer, primary_key=True)
    at      = Column(DateTime, default=utcnow, index=True)
    admin   = Column(String(50))
    action  = Column(String(50))
    shop_id = Column(Integer, ForeignKey("shops.id"))
    detail  = Column(Text)


class Release(Base):
    """
    One version of the Windows installer that shops can update to.

    status:
      PILOT   only shops marked "pilot" are offered it
      ALL     every shop is offered it
      PAUSED  nobody is offered it (a bad release, held back)
    The installer file sits in <data>/releases/; `signature` is the .sig file
    the build made with ARZ's UPDATE key - the shop PC refuses the installer
    if it does not match.
    """
    __tablename__ = "releases"

    id          = Column(Integer, primary_key=True)
    version     = Column(String(30), unique=True, nullable=False)
    notes       = Column(Text)
    critical    = Column(Boolean, default=False, nullable=False)
    status      = Column(String(10), default="PILOT", nullable=False)
    filename    = Column(String(200), nullable=False)
    signature   = Column(Text, nullable=False)
    size        = Column(BigInteger)
    sha256      = Column(String(64))
    created_at  = Column(DateTime, default=utcnow)
    status_changed_at = Column(DateTime, default=utcnow)


class Lead(Base):
    """
    A pharmacy that asked for a demo on the website.  ARZ works through them in
    the panel: NEW -> CONTACTED -> TRIAL -> CUSTOMER (or NOT_INTERESTED).
    Only what the form asks is stored - no IP address, nothing hidden.
    """
    __tablename__ = "leads"

    id         = Column(Integer, primary_key=True)
    created_at = Column(DateTime, default=utcnow, index=True)
    name       = Column(String(120), nullable=False)
    phone      = Column(String(20), nullable=False)
    shop       = Column(String(150), nullable=False)
    town       = Column(String(80))
    current_software = Column(String(60))
    source     = Column(String(30), default="website")
    status     = Column(String(20), default="NEW", nullable=False, index=True)
    notes      = Column(Text)
    updated_at = Column(DateTime, default=utcnow)


class OwnerPairingCloud(Base):
    """
    A "Connect phone" QR code shown on a shop PC.  The cloud only relays:
    it holds the phone's claim until the shop PC checks the proof (the secret
    that proves it is in the QR never reaches this server).
    """
    __tablename__ = "owner_pairings"

    id         = Column(Integer, primary_key=True)
    shop_id    = Column(Integer, ForeignKey("shops.id"), index=True, nullable=False)
    pairing_id = Column(String(40), unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    status     = Column(String(12), default="OPEN", nullable=False)   # OPEN/CLAIMED/APPROVED/REJECTED
    claim_json = Column(Text)
    reason     = Column(Text)


class MobileDevice(Base):
    """An owner's phone.  Its token is how it signs in; ACTIVE once the shop PC approved it."""
    __tablename__ = "mobile_devices"

    id           = Column(Integer, primary_key=True)
    device_id    = Column(String(40), unique=True, nullable=False)
    shop_id      = Column(Integer, ForeignKey("shops.id"), index=True, nullable=False)
    name         = Column(String(80))
    token_hash   = Column(String(64), nullable=False)
    status       = Column(String(10), default="PENDING", nullable=False)   # PENDING/ACTIVE/REMOVED
    created_at   = Column(DateTime, default=utcnow)
    last_seen_at = Column(DateTime)
    push_token   = Column(String(200))


class OwnerSummary(Base):
    """The newest LOCKED summary from a shop PC (one row per shop).  Unreadable here."""
    __tablename__ = "owner_summaries"

    shop_id    = Column(Integer, ForeignKey("shops.id"), primary_key=True)
    locked     = Column(Text, nullable=False)
    updated_at = Column(DateTime, default=utcnow)
    size       = Column(Integer)
