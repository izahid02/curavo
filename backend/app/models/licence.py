"""
SQLAlchemy model for this installation's Curavo subscription.

ONE ROW, EVER (same idea as pharmacy_settings).  It holds:

  shop_code        A random code made the first time the app runs, e.g.
                   "7K3P9QXM" (shown as 7K3P-9QXM).  The shop sends it to ARZ
                   with the UPI payment, and the licence key ARZ sends back is
                   signed FOR THAT CODE, so a key cannot simply be passed on to
                   another shop.
  trial_started_on The day the free trial began (the first day this version
                   ran).  The trial length lives in services/licence.py.
  licence_key      The last key that was accepted, exactly as pasted.  The key
                   is re-checked from scratch on every status read: nothing
                   about it (expiry date, shop name) is trusted from a column.
  last_seen_on     The latest date the app has ever seen.  If the PC clock is
                   turned BACK, the app keeps using this date instead, so
                   rolling the clock back cannot stretch a trial or licence.

It lives INSIDE pharmacy.db on purpose: a backup carries it, so restoring a
backup onto a replacement PC keeps the same shop code and the same key.
It is a brand-new TABLE, so database.init_db() creates it (create_all) — no
ALTER in main.py is needed.
"""
from sqlalchemy import Column, Date, DateTime, Integer, String, Text

from app.database import Base


class LicenceState(Base):
    """This shop's subscription state.  Read and written ONLY by services/licence.py."""
    __tablename__ = "licence_state"

    id               = Column(Integer, primary_key=True)
    shop_code        = Column(String(16), nullable=False)
    trial_started_on = Column(Date, nullable=False)
    licence_key      = Column(Text, nullable=True)
    activated_at     = Column(DateTime, nullable=True)
    last_seen_on     = Column(Date, nullable=False)
