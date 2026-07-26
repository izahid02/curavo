"""
Drug Interactions model.

Stores known dangerous combinations between two generic drug names.
Matching is done by substring: drug_a="warfarin" will match a product
named "Warfarin 5mg Tablet" because "warfarin" is a substring of the
product name (case-insensitive).

Severity levels:
  HIGH     — potentially life-threatening; pharmacist should flag immediately
  MODERATE — clinically significant; counsel patient / consider alternative
  LOW      — mild interaction; document if needed
"""
from sqlalchemy import Column, Integer, String, Text
from app.database import Base


class DrugInteraction(Base):
    __tablename__ = "drug_interactions"

    id             = Column(Integer, primary_key=True)
    # Generic name fragments to match against product names, e.g. "warfarin"
    drug_a         = Column(String(100), nullable=False, index=True)
    drug_b         = Column(String(100), nullable=False, index=True)
    severity       = Column(String(10), nullable=False)   # HIGH / MODERATE / LOW
    description    = Column(Text, nullable=False)         # "May increase bleeding risk"
    recommendation = Column(Text, nullable=True)          # "Avoid combination"
