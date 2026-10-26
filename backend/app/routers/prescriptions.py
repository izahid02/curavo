"""
Prescription image upload & retrieval endpoints.

All routes are prefixed with /api/prescriptions and require a valid JWT login.

Endpoints:
  POST   /upload                      — upload a prescription image (multipart)
  GET    /patient/{patient_id}        — list all prescriptions for a patient
  GET    /invoice/{invoice_id}        — list prescriptions linked to an invoice
  GET    /{id}/image                  — stream the actual image file back
  DELETE /{id}                        — delete DB record + file from disk
"""
import os
from datetime import datetime
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.database import get_db, get_prescriptions_dir
from app.models.billing import Invoice, InvoiceItem
from app.models.inventory import Product
from app.models.prescription import Prescription
from app.services.auth_service import get_current_user

router = APIRouter(prefix="/prescriptions", tags=["prescriptions"])

# Allowed MIME types for uploaded files
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "application/pdf"}
MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


# ---------------------------------------------------------------------------
# Grouping — several uploaded sheets are ONE prescription
# ---------------------------------------------------------------------------

class _Grouped:
    """
    One prescription, presented as its first page plus the rest.

    Every attribute reads through to page one, so any caller that was written
    when a prescription meant a single row keeps working unchanged — it simply
    sees the first sheet.  `pages` is the whole set, in order.
    """
    __slots__ = ("pages",)

    def __init__(self, pages):
        self.pages = pages

    def __getattr__(self, item):
        return getattr(self.pages[0], item)


def _group_pages(rows):
    """
    Collapse prescription rows into one entry per prescription.

    Pages uploaded together share a group_id.  A row with NO group_id is a
    prescription of one page standing alone — which is exactly what every row
    written before multi-page existed is, so old uploads need no backfill and
    come back looking the same as they always did.

    Input order is preserved: whichever group's first page appeared first in
    `rows` comes first out, so a caller that sorted newest-first stays sorted.
    Within a group, pages are ordered by page_number, falling back to id for
    anything written without one.
    """
    order: list = []
    groups: dict = {}
    for rx in rows:
        # An ungrouped row keys on its own id, so it can never be merged with
        # another ungrouped row.
        key = ("g", rx.group_id) if rx.group_id else ("solo", rx.id)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(rx)

    out = []
    for key in order:
        pages = sorted(
            groups[key],
            key=lambda r: (r.page_number if r.page_number is not None else 10**6, r.id),
        )
        out.append(_Grouped(pages))
    return out


def _page_list(pages):
    """The per-page detail the viewer needs to flip through a prescription."""
    return [
        {
            "id":          p.id,
            "page_number": p.page_number if p.page_number is not None else i + 1,
            "file_name":   p.file_name,
            "file_size":   p.file_size,
            "mime_type":   p.mime_type,
        }
        for i, p in enumerate(pages)
    ]


# ---------------------------------------------------------------------------
# ENDPOINT 1 — Upload a prescription image
# ---------------------------------------------------------------------------

@router.post("/upload", status_code=201)
async def upload_prescription(
    file: UploadFile = File(...),
    patient_id: int = Form(...),
    invoice_id: Optional[int] = Form(None),
    notes: Optional[str] = Form(None),
    # One prescription, several sheets: the client sends the SAME group_id for
    # every page of one upload, with page_number counting from 1.  Both are
    # optional — an upload that sends neither is a single-page prescription,
    # exactly as before.
    group_id: Optional[str] = Form(None),
    page_number: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Accept a multipart upload of a prescription image.

    Steps:
      1. Validate MIME type and file size.
      2. Build a collision-safe filename: {patient_id}_{timestamp}_{original}.
      3. Save bytes to the prescriptions directory on disk.
      4. Insert a Prescription row pointing at that file.
      5. Return minimal info so the frontend can confirm the upload.
    """
    # Validate MIME type
    content_type = file.content_type or ""
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File type '{content_type}' not allowed. "
                   "Use JPEG, PNG, WebP, or PDF.",
        )

    # Read file bytes (validates size)
    data = await file.read()
    if len(data) > MAX_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File too large ({len(data) // 1024} KB). Maximum is 10 MB.",
        )

    # Build a safe, unique filename.
    #
    # The timestamp only resolves to the SECOND, which was fine while one
    # prescription meant one file.  Several pages now go up back to back, and a
    # scanner hands them over with identical names ("scan.jpg"), so two pages
    # of the same prescription could land on the same path and the second would
    # silently overwrite the first — losing a page of a legal document.  The
    # random suffix makes every stored name unique regardless.
    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    # Keep only safe characters from the original filename
    safe_original = "".join(
        c for c in (file.filename or "rx") if c.isalnum() or c in "._-"
    ) or "rx"
    unique = uuid4().hex[:8]
    stored_name = f"{patient_id}_{ts}_{unique}_{safe_original}"

    # Write to disk
    prescriptions_dir = get_prescriptions_dir()
    dest_path = prescriptions_dir / stored_name
    with open(dest_path, "wb") as f:
        f.write(data)

    # Insert DB record
    rx = Prescription(
        patient_id  = patient_id,
        invoice_id  = invoice_id,
        file_path   = stored_name,   # relative to prescriptions dir
        file_name   = file.filename or safe_original,
        file_size   = len(data),
        mime_type   = content_type,
        uploaded_by = current_user.id,
        notes       = notes,
        group_id    = group_id,
        page_number = page_number,
    )
    db.add(rx)
    db.commit()
    db.refresh(rx)

    return {
        "id":          rx.id,
        "file_name":   rx.file_name,
        "file_size":   rx.file_size,
        "uploaded_at": rx.uploaded_at.isoformat(),
        "group_id":    rx.group_id,
        "page_number": rx.page_number,
    }


# ---------------------------------------------------------------------------
# ENDPOINT 2 — List all prescriptions for a patient
# ---------------------------------------------------------------------------

@router.get("/patient/{patient_id}")
def list_patient_prescriptions(
    patient_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Return all prescription uploads for a patient, newest first.

    Each item includes the invoice number and a list of medicine names
    that were dispensed on that invoice (via prescriptions → invoice → items).
    This lets the pharmacist see "what was prescribed last time" at a glance.
    """
    rows = (
        db.query(Prescription)
        .filter(Prescription.patient_id == patient_id)
        .order_by(Prescription.uploaded_at.desc())
        .all()
    )

    result = []
    for rx in _group_pages(rows):
        # Fetch the linked invoice number (if any)
        invoice_number = None
        dispensed_medicines = []

        if rx.invoice_id:
            inv = db.query(Invoice).filter(Invoice.id == rx.invoice_id).first()
            if inv:
                invoice_number = inv.invoice_number
                # Collect medicine names from invoice items
                items = (
                    db.query(InvoiceItem)
                    .filter(InvoiceItem.invoice_id == rx.invoice_id)
                    .all()
                )
                seen = set()
                for item in items:
                    prod = db.query(Product).filter(Product.id == item.product_id).first()
                    if prod and prod.name not in seen:
                        dispensed_medicines.append(prod.name)
                        seen.add(prod.name)

        result.append({
            "id":                  rx.id,
            "file_name":           rx.file_name,
            "file_size":           rx.file_size,
            "mime_type":           rx.mime_type,
            "uploaded_at":         rx.uploaded_at.isoformat(),
            "invoice_id":          rx.invoice_id,
            "invoice_number":      invoice_number,
            "dispensed_medicines": dispensed_medicines,
            "notes":               rx.notes,
            # One prescription, however many sheets it took.  The fields above
            # describe PAGE ONE, so anything that only ever showed a single
            # thumbnail keeps working untouched and simply shows the first page.
            "page_count":          len(rx.pages),
            "pages":               _page_list(rx.pages),
        })

    return result


# ---------------------------------------------------------------------------
# ENDPOINT 3 — List prescriptions linked to a specific invoice
# ---------------------------------------------------------------------------

@router.get("/invoice/{invoice_id}")
def list_invoice_prescriptions(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Return all prescription uploads that reference a specific invoice."""
    rows = (
        db.query(Prescription)
        .filter(Prescription.invoice_id == invoice_id)
        .order_by(Prescription.uploaded_at.desc())
        .all()
    )
    return [
        {
            "id":          rx.id,
            "file_name":   rx.file_name,
            "file_size":   rx.file_size,
            "mime_type":   rx.mime_type,
            "uploaded_at": rx.uploaded_at.isoformat(),
            "notes":       rx.notes,
            "page_count":  len(rx.pages),
            "pages":       _page_list(rx.pages),
        }
        for rx in _group_pages(rows)
    ]


# ---------------------------------------------------------------------------
# ENDPOINT 4 — Stream the image file back to the browser
# ---------------------------------------------------------------------------

@router.get("/{rx_id}/image")
def get_prescription_image(
    rx_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Stream the actual image file back to the client.

    The browser opens this URL (e.g. in a new tab) to view the prescription.
    Returns 404 if the DB record does not exist or the file is missing on disk.
    """
    rx = db.query(Prescription).filter(Prescription.id == rx_id).first()
    if not rx:
        raise HTTPException(status_code=404, detail="Prescription not found.")

    prescriptions_dir = get_prescriptions_dir()
    file_path = prescriptions_dir / rx.file_path

    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Prescription file is missing from disk.",
        )

    return FileResponse(
        path=str(file_path),
        media_type=rx.mime_type or "application/octet-stream",
        filename=rx.file_name,
    )


# ---------------------------------------------------------------------------
# ENDPOINT 5 — Delete a prescription (DB + disk)
# ---------------------------------------------------------------------------

@router.delete("/{rx_id}", status_code=204)
def delete_prescription(
    rx_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Permanently remove a prescription upload.

    Only Owner or Admin roles may delete prescriptions — a counter-person
    should not be able to erase prescription evidence.

    Deletes:
      1. The file from disk (silent if already missing)
      2. The DB row
    """
    # Role check — only Owner/Admin may delete prescription records
    role_name = current_user.role.name if current_user.role else ""
    if role_name not in ("Owner", "Admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Admin can delete prescription records.",
        )

    rx = db.query(Prescription).filter(Prescription.id == rx_id).first()
    if not rx:
        raise HTTPException(status_code=404, detail="Prescription not found.")

    # Remove file from disk (don't raise if already gone)
    try:
        prescriptions_dir = get_prescriptions_dir()
        file_path = prescriptions_dir / rx.file_path
        if file_path.exists():
            os.remove(file_path)
    except OSError:
        pass  # file already missing — carry on and clean up the DB row

    db.delete(rx)
    db.commit()
