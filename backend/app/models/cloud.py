"""
SQLAlchemy model for this installation's link to the Curavo cloud.

ONE ROW (like licence_state).  Lives inside pharmacy.db on purpose: when a
shop's database is restored onto a replacement PC, the new PC carries on as
the same shop - same device link, same backup key - with nothing to set up.

  device_token   the secret the cloud gave this shop on first contact; sent
                 with every request.  NULL = not registered yet.
  backup_key     the shop's own random key; one of the two keys that can
                 unlock its cloud backups (the other is ARZ's - see
                 services/backup_crypto.py).
  last_*         what the Backup page and the sidebar card show.
  last_error     the last thing that went wrong talking to the cloud, in
                 plain English (ASCII), or NULL when the last attempt worked.

A brand-new TABLE, so database.init_db() creates it - no ALTER needed.
"""
from sqlalchemy import BigInteger, Boolean, Column, Date, DateTime, Integer, String, Text

from app.database import Base


class CloudState(Base):
    __tablename__ = "cloud_state"

    id                = Column(Integer, primary_key=True)
    device_token      = Column(String(100), nullable=True)
    backup_key        = Column(String(64), nullable=False)
    registered_at     = Column(DateTime, nullable=True)
    last_contact_at   = Column(DateTime, nullable=True)
    last_contact_ok   = Column(Boolean, nullable=True)
    last_backup_at    = Column(DateTime, nullable=True)
    last_backup_size  = Column(BigInteger, nullable=True)
    last_error        = Column(Text, nullable=True)
    last_error_at     = Column(DateTime, nullable=True)
    # Owner app: last summary sent, and the day the morning notification went.
    owner_summary_at  = Column(DateTime, nullable=True)
    owner_push_on     = Column(Date, nullable=True)
    # The owner's Curavo account this PC is linked to (routers/account_link.py),
    # and which LOCAL user signing in with that account becomes.
    account_id        = Column(Integer, nullable=True)
    account_email     = Column(String(254), nullable=True)
    account_name      = Column(String(120), nullable=True)
    account_linked_at = Column(DateTime, nullable=True)
    account_user_id   = Column(Integer, nullable=True)


class ErrorReport(Base):
    """
    One kind of error on THIS PC, waiting to be sent to the cloud.

    The same crash 40 times is one row with count=40 (fingerprint = what kind
    of error, where in the code, which screen/API).  sent_count is how many of
    those the cloud already knows about, so only the difference is sent.
    Written by services/error_reports.py, sent by services/cloud_agent.py.
    """
    __tablename__ = "error_reports"

    id          = Column(Integer, primary_key=True)
    fingerprint = Column(String(64), unique=True, nullable=False)
    source      = Column(String(20))        # backend / screen / log
    kind        = Column(String(120))
    message     = Column(Text)
    stack       = Column(Text)
    route       = Column(String(200))
    app_version = Column(String(20))
    count       = Column(Integer, default=0, nullable=False)
    sent_count  = Column(Integer, default=0, nullable=False)
    first_seen  = Column(DateTime)
    last_seen   = Column(DateTime)


class OwnerDevice(Base):
    """
    A phone connected to the owner app (frontend: Connect phone).

    public_key is the phone's own X25519 key: every summary sent to the cloud
    is locked so that only the phones listed here can open it.  Removing a row
    stops that phone from reading anything sent afterwards.
    """
    __tablename__ = "owner_devices"

    id          = Column(Integer, primary_key=True)
    device_id   = Column(String(40), unique=True, nullable=False)   # given by the cloud
    name        = Column(String(80))
    public_key  = Column(String(64), nullable=False)
    added_at    = Column(DateTime)


class OwnerPairing(Base):
    """
    A "Connect phone" QR code waiting to be scanned (valid 10 minutes).

    secret travels only inside the QR code shown on this PC's screen.  A phone
    proves it scanned the code by sending HMAC(secret, its public key); the
    cloud never sees the secret, so it cannot pair a phone on its own.
    """
    __tablename__ = "owner_pairings"

    id          = Column(Integer, primary_key=True)
    pairing_id  = Column(String(40), unique=True, nullable=False)
    secret      = Column(String(64), nullable=False)
    created_at  = Column(DateTime)
    expires_at  = Column(DateTime)
    status      = Column(String(12), default="OPEN")    # OPEN / DONE / EXPIRED / FAILED
    device_name = Column(String(80))
