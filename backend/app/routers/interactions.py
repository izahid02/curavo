"""
Drug Interaction Checker — POST /api/interactions/check

Given a list of product IDs currently on an invoice, this endpoint
checks every pair of products against the drug_interactions table and
returns any matches found.

Matching rule: drug_a (e.g. "warfarin") must appear as a case-insensitive
substring of product A's name or generic_name, AND drug_b must appear
similarly in product B — or vice-versa.

The frontend calls this after each product is added to the bill so the
pharmacist is warned before completing the sale.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.models.inventory import Product
from app.models.drug_interactions import DrugInteraction
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/interactions", tags=["Interactions"])


# ── Request / Response schemas ────────────────────────────────────────────────

class CheckRequest(BaseModel):
    product_ids: List[int]


class InteractionHit(BaseModel):
    drug_a: str          # actual product name that matched drug_a pattern
    drug_b: str          # actual product name that matched drug_b pattern
    severity: str
    description: str
    recommendation: str | None


class CheckResponse(BaseModel):
    interactions: List[InteractionHit]
    has_high: bool
    has_moderate: bool


# ── Helper ────────────────────────────────────────────────────────────────────

def _matches(rule_fragment: str, product_name: str, generic_name: str | None) -> bool:
    """
    Return True if rule_fragment appears (case-insensitive) anywhere in
    the product's display name OR its generic name.

    Example: rule_fragment="warfarin", product_name="Warfarin 5mg Tablet"
             → "warfarin" in "warfarin 5mg tablet"  → True
    """
    fragment = rule_fragment.lower()
    if fragment in (product_name or "").lower():
        return True
    if fragment in (generic_name or "").lower():
        return True
    return False


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.post("/check", response_model=CheckResponse)
def check_interactions(
    body: CheckRequest,
    db: Session = Depends(get_db),
    _current_user=Depends(get_current_user),   # require login
):
    """
    Check every pair of products in the current bill against the
    drug_interactions table and return any dangerous combinations found.

    Steps:
      1. Fetch the Product rows for the given IDs.
      2. Load all interaction rules from the database once.
      3. For every unique pair of products, test both orderings of each rule.
      4. Return matched interactions + summary flags (has_high / has_moderate).
    """
    if len(body.product_ids) < 2:
        # Need at least two medicines to have an interaction
        return CheckResponse(interactions=[], has_high=False, has_moderate=False)

    # 1. Fetch products (filter out any IDs that don't exist)
    products = (
        db.query(Product)
        .filter(Product.id.in_(body.product_ids), Product.is_active == True)
        .all()
    )

    if len(products) < 2:
        return CheckResponse(interactions=[], has_high=False, has_moderate=False)

    # 2. Load all interaction rules once — the table is small, full scan is fine
    rules = db.query(DrugInteraction).all()

    hits: List[InteractionHit] = []

    # 3. Test every unique pair of products (combinations, not permutations)
    for i in range(len(products)):
        for j in range(i + 1, len(products)):
            pa = products[i]
            pb = products[j]

            for rule in rules:
                # Check: (rule.drug_a matches pa) AND (rule.drug_b matches pb)
                #     OR: (rule.drug_a matches pb) AND (rule.drug_b matches pa)
                forward = (
                    _matches(rule.drug_a, pa.name, pa.generic_name) and
                    _matches(rule.drug_b, pb.name, pb.generic_name)
                )
                reverse = (
                    _matches(rule.drug_a, pb.name, pb.generic_name) and
                    _matches(rule.drug_b, pa.name, pa.generic_name)
                )

                if forward or reverse:
                    # Use actual product names in the response so the pharmacist
                    # sees "Warfarin 5mg" rather than the raw rule fragment.
                    if forward:
                        name_a, name_b = pa.name, pb.name
                    else:
                        name_a, name_b = pb.name, pa.name

                    hits.append(InteractionHit(
                        drug_a=name_a,
                        drug_b=name_b,
                        severity=rule.severity,
                        description=rule.description,
                        recommendation=rule.recommendation,
                    ))

    has_high     = any(h.severity == "HIGH"     for h in hits)
    has_moderate = any(h.severity == "MODERATE" for h in hits)

    return CheckResponse(
        interactions=hits,
        has_high=has_high,
        has_moderate=has_moderate,
    )
