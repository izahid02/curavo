"""
The shop's own identity, as patient messages need it.

WHY THIS EXISTS: follow-up, refill, credit-reminder and marketing messages
used to have HCC's name and phone number (6001666271) typed into the code and
the seeded templates, in English AND Assamese.  Every other shop on Curavo
would have sent its patients messages from the wrong pharmacy.  Templates now
carry placeholders, and this is the ONE place that fills them:

    {shop_name}     the shop name                      (English messages)
    {shop_name_as}  the shop name in Assamese script   (Assamese messages)
                    - falls back to {shop_name} when not set
    {shop_phone}    the shop phone number
                    - falls back to the shop name when not set, so a message
                      reads "call Sunrise Medicos" rather than "call ."

Read fresh on every call (one tiny query): a rename in Pharmacy Settings shows
up in the very next message, with nothing to restart or cache-bust.
"""
from sqlalchemy.orm import Session

from app.models.settings import PharmacySettings


def shop_vars(db: Session) -> dict:
    """Placeholder values for patient-facing messages.  Never raises."""
    row = db.query(PharmacySettings).order_by(PharmacySettings.id).first()
    name    = ((row.pharmacy_name    if row else None) or "").strip() or "your pharmacy"
    name_as = ((row.pharmacy_name_as if row else None) or "").strip() or name
    phone   = ((row.pharmacy_phone   if row else None) or "").strip() or name
    return {"shop_name": name, "shop_name_as": name_as, "shop_phone": phone}
