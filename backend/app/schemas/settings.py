"""
Pydantic schemas for shop-wide pharmacy settings.

PharmacySettingsOut is deliberately readable WITHOUT a login: the login screen
and the printed receipt both need the shop's name, and neither has a token in
hand at the moment it renders.  Nothing sensitive lives here — every field is
already printed on the shop's own bills and signboard.
"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class PharmacySettingsOut(BaseModel):
    """The shop's identity, as returned by GET /api/settings/pharmacy."""
    id:                 int
    pharmacy_name:      str
    pharmacy_name_as:   Optional[str] = None
    invoice_name:       Optional[str] = None
    pharmacy_tagline:   Optional[str] = None
    pharmacy_address:   Optional[str] = None
    pharmacy_phone:     Optional[str] = None
    pharmacy_email:     Optional[str] = None
    pharmacy_gstin:     Optional[str] = None
    pharmacy_dl_number: Optional[str] = None
    updated_at:         Optional[datetime] = None

    model_config = {"from_attributes": True}


class PharmacySettingsUpdate(BaseModel):
    """
    What the Pharmacy Settings modal sends to PUT /api/settings/pharmacy.

    Only pharmacy_name is required — a shop with no name is not a shop, and it
    is the field every screen falls back on.  Everything else may be blank, and
    an empty string means "clear this", which is why they are Optional rather
    than defaulted to the current value.
    """
    pharmacy_name:      str = Field(..., min_length=1, max_length=150)
    pharmacy_name_as:   Optional[str] = Field(default=None, max_length=150)
    invoice_name:       Optional[str] = Field(default=None, max_length=150)
    pharmacy_tagline:   Optional[str] = Field(default=None, max_length=150)
    pharmacy_address:   Optional[str] = None
    pharmacy_phone:     Optional[str] = Field(default=None, max_length=40)
    pharmacy_email:     Optional[str] = Field(default=None, max_length=120)
    pharmacy_gstin:     Optional[str] = Field(default=None, max_length=20)
    pharmacy_dl_number: Optional[str] = Field(default=None, max_length=60)
