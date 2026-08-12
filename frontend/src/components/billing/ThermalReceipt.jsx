/**
 * ThermalReceipt — the 80mm (3-inch) thermal-printer receipt.
 *
 * This is the ONE element that actually gets printed. It is rendered with
 * id="thermal-receipt" as a direct child of <body> (see Billing.jsx), and
 * thermal-print.css shows only this element when the user hits Print.
 *
 * The visual layout is a faithful copy of the old on-screen receipt — we keep
 * it looking exactly the same. Only the plumbing changed.
 *
 * ── Props ────────────────────────────────────────────────────────────────
 * We take a single `receipt` object: the invoice returned by the backend right
 * after a sale (`POST /api/billing/invoices`). Everything the receipt needs is
 * already on that object, so passing it whole keeps the call site simple.
 *
 *   receipt.invoice_number   e.g. "HCC-2026-000042"
 *   receipt.invoice_date     ISO date string
 *   receipt.patient_name     patient name (or null / "Walk-in")
 *   receipt.items[]          { product_name, batch_number, gst_rate,
 *                              quantity, unit_price, line_total }
 *   receipt.subtotal         subtotal EXCLUDING gst
 *   receipt.gst_amount       gst extracted from the MRP
 *   receipt.discount_amount  discount (0 if none)
 *   receipt.total_amount     grand total (MRP inclusive)
 *   receipt.payment_method   "CASH" | "UPI" | "CREDIT"
 *   receipt.amount_paid      amount paid today (used for CREDIT)
 *   receipt.credit_amount    outstanding credit (CREDIT only)
 *   receipt.credit_due_date  when the credit is due (CREDIT only)
 *
 * NOTE: thermal-print.css is imported here so the print rules load whenever a
 * receipt is on screen. The @media print block has no effect on the display.
 */
import '../../styles/thermal-print.css';
import { formatDateTime as fmtDateTimeIST, formatDateOnly as fmtDateIST } from '../../lib/datetime';
import { usePharmacy } from '../../lib/pharmacy.jsx';
import ARZLogo from '../shared/ARZLogo';

// ─── Small formatting helpers ────────────────────────────────────────────────

/** Format money with two decimals, e.g. 12.5 → "12.50". Falls back to 0.00. */
function money(value) {
  return Number(value || 0).toFixed(2);
}

// Backend timestamps are UTC; render them in IST so the printed receipt shows
// the correct local date/time (see lib/datetime.js). Empty → blank on paper.
function formatDateTime(value) {
  if (!value) return '';
  return fmtDateTimeIST(value);
}

function formatDate(value) {
  if (!value) return '';
  return fmtDateIST(value);
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ThermalReceipt({ receipt }) {
  // The shop's own name/address/GSTIN for the header, from Pharmacy Settings.
  // ⚠ This hook MUST come before the early return below — React requires the
  // same hooks to run on every render, and `receipt` is null between sales.
  const { pharmacy } = usePharmacy();

  // Nothing to show until a sale has been completed.
  if (!receipt) return null;

  const items = receipt.items || [];
  const isCredit = receipt.payment_method === 'CREDIT';

  return (
    <div id="thermal-receipt">

      {/* Header — the shop's own identity, from Pharmacy Settings.
          Uppercased for the thermal printer, which has no bold and relies on
          caps for the one line that has to stand out. */}
      <div className="receipt-header">
        <img src="/HCC_LOGO.png" alt="Logo" className="receipt-logo" />
        <div className="receipt-shop-name">{pharmacy.pharmacy_name.toUpperCase()}</div>
        {pharmacy.pharmacy_tagline && (
          <div className="receipt-tagline">{pharmacy.pharmacy_tagline}</div>
        )}
        {pharmacy.pharmacy_address && (
          <div className="receipt-tagline">{pharmacy.pharmacy_address}</div>
        )}
        {pharmacy.pharmacy_phone && (
          <div className="receipt-tagline">Ph: {pharmacy.pharmacy_phone}</div>
        )}
        {/* GSTIN and the Drug Licence number are legally required on a
            pharmacy's bill, so they print whenever they have been entered. */}
        {pharmacy.pharmacy_gstin && (
          <div className="receipt-tagline">GSTIN: {pharmacy.pharmacy_gstin}</div>
        )}
        {pharmacy.pharmacy_dl_number && (
          <div className="receipt-tagline">DL No: {pharmacy.pharmacy_dl_number}</div>
        )}
      </div>

      <hr className="receipt-divider" />
      <div style={{ textAlign: 'center', fontWeight: 'bold', fontSize: '11px' }}>
        TAX INVOICE
      </div>
      <hr className="receipt-divider" />

      {/* Invoice meta */}
      <div className="receipt-meta">
        <div>Invoice No: {receipt.invoice_number}</div>
        <div>Date: {formatDateTime(receipt.invoice_date)}</div>
        {receipt.patient_name && <div>Patient: {receipt.patient_name}</div>}
      </div>

      <hr className="receipt-divider" />

      {/* Items */}
      <table className="receipt-items">
        <thead>
          <tr>
            <th className="item-name">ITEM</th>
            <th className="item-qty">QTY</th>
            <th className="item-price">PRICE</th>
            <th className="item-total">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td className="item-name">
                <div>{item.product_name}</div>
                <div className="item-batch">
                  Batch: {item.batch_number || '-'} | GST: {item.gst_rate}%
                </div>
              </td>
              <td className="item-qty">{item.quantity}</td>
              <td className="item-price">₹{money(item.unit_price)}</td>
              <td className="item-total">₹{money(item.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <hr className="receipt-divider" />

      {/* Totals */}
      <div className="receipt-totals">
        <div className="receipt-total-row">
          <span>Subtotal (excl. GST)</span>
          <span>₹{money(receipt.subtotal)}</span>
        </div>
        <div className="receipt-total-row">
          <span>GST included</span>
          <span>₹{money(receipt.gst_amount)}</span>
        </div>
        {/* Home visit / drip fee — a SERVICE charge, so it is listed
            separately and carries no GST (Feature 4). */}
        {Number(receipt.home_visit_charge) > 0 && (
          <div className="receipt-total-row">
            <span>Home Visit Charge</span>
            <span>₹{money(receipt.home_visit_charge)}</span>
          </div>
        )}
        {Number(receipt.discount_amount) > 0 && (
          <div className="receipt-total-row">
            <span>Discount</span>
            <span>-₹{money(receipt.discount_amount)}</span>
          </div>
        )}
        <div className="receipt-total-row receipt-grand-total">
          <span>TOTAL</span>
          <span>₹{money(receipt.total_amount)}</span>
        </div>
      </div>

      {/* Payment info */}
      <div className="receipt-payment">
        <div style={{ textAlign: 'center' }}>
          All prices are MRP inclusive of taxes
        </div>
        {isCredit ? (
          <div style={{ textAlign: 'center', marginTop: '3px' }}>
            Payment: <strong>CREDIT</strong> ·
            Paid: ₹{money(receipt.amount_paid)} ·
            Credit: ₹{money(receipt.credit_amount)}
            {receipt.credit_due_date && <> · Due: {formatDate(receipt.credit_due_date)}</>}
          </div>
        ) : (
          <div style={{ textAlign: 'center', marginTop: '3px' }}>
            Payment: <strong>{receipt.payment_method}</strong> ·
            Paid: ₹{money(receipt.total_amount)}
          </div>
        )}
      </div>

      <hr className="receipt-divider" />

      {/* Footer */}
      <div className="receipt-footer">
        <div>Thank you for your visit!</div>
        <div>Your health is our priority</div>
        <hr className="receipt-divider" />
        <div>{pharmacy.pharmacy_name} © {new Date().getFullYear()}</div>

        {/* ── "Powered by" ARZ Technologies logo ──────────────────────────
            Replaces the old plain-text line. Kept small (28px) so it fits
            neatly across 80mm thermal paper. */}
        <div style={{
          textAlign: 'center',
          marginTop: '8px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '4px',
        }}>
          <span style={{
            fontSize: '8px',
            letterSpacing: '0.08em',
            color: '#666',
          }}>
            Powered by
          </span>
          <ARZLogo size="lg" />
        </div>
      </div>

    </div>
  );
}
