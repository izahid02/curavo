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
# ENDPOINT 1 — Upload a prescription image
# ---------------------------------------------------------------------------

@router.post("/upload", status_code=201)
async def upload_prescription(
    file: UploadFile = File(...),
    patient_id: int = Form(...),
    invoice_id: Optional[int] = Form(None),
    notes: Optional[str] = Form(None),
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

    # Build a safe, unique filename
    ts = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    # Keep only safe characters from the original filename
    safe_original = "".join(
        c for c in (file.filename or "rx") if c.isalnum() or c in "._-"
    ) or "rx"
    stored_name = f"{patient_id}_{ts}_{safe_original}"

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
    )
    db.add(rx)
    db.commit()
    db.refresh(rx)

    return {
        "id":          rx.id,
        "file_name":   rx.file_name,
        "file_size":   rx.file_size,
        "uploaded_at": rx.uploaded_at.isoformat(),
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
    for rx in rows:
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
        }
        for rx in rows
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
