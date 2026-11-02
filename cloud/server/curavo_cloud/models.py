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
