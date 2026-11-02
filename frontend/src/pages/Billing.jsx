/**
 * Billing & POS Screen
 *
 * The most-used screen in the system.  Design goals:
 *   - Barcode-scanner-first: scan = instant add, no mouse needed
 *   - Keyboard shortcuts: F2 = focus search, Enter = add first result, F10 = complete sale
 *   - Fast entry: after adding a product, focus immediately returns to the search box
 *
 * Layout: two side-by-side panels
 *   LEFT  (60%) — product search and results
 *   RIGHT (40%) — current bill, totals, payment, complete-sale button
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { usePharmacy } from '../lib/pharmacy';
import { loadBrandingImage } from '../lib/branding';
import MedicineSearchBox from '../components/shared/MedicineSearchBox';
import PrescriptionUpload from '../components/billing/PrescriptionUpload';
import PatientHistoryPanel from '../components/billing/PatientHistoryPanel';
import CameraScanner from '../components/billing/CameraScanner';
import ThermalReceipt from '../components/billing/ThermalReceipt';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import { formatDateOnly, formatDateTimeShort, getTodayIST } from '../lib/datetime';

// ─── Small helpers ────────────────────────────────────────────────────────────

/** Format a number as Indian currency: ₹1,234.56 */
function inr(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Round to paise.  JS floats drift (0.1 + 0.2 !== 0.3), so every money step
 * rounds explicitly rather than hoping the display hides it.
 *
 * HALF-UP for positive amounts, matching the backend's ROUND_HALF_UP, so the
 * screen and the stored invoice land on the same paisa.
 */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Format a date (or ISO date string) as "10 Jan 2025" in IST. '' if empty. */
function fmtDate(d) {
  if (!d) return '';
  return formatDateOnly(d);
}

/**
 * Pick which due date to show on the amber "existing credit" banner.
 *
 * If anything is overdue we show that (it is the most urgent). Otherwise we
 * look through the patient's open CREDIT transactions and return the earliest
 * due date — i.e. the next payment they owe.
 */
function nextDueDate(credit) {
  if (!credit) return null;
  if (credit.oldest_overdue_date) return credit.oldest_overdue_date;
  const open = (credit.transactions || []).filter(
    t => t.type === 'CREDIT' && t.due_date && Number(t.balance) > 0
  );
  if (open.length === 0) return null;
  return open.reduce((earliest, t) => (t.due_date < earliest ? t.due_date : earliest), open[0].due_date);
}

/**
 * Compute GST-inclusive line totals for a single bill item.
 * unit_price IS the MRP (total incl. GST) — GST is extracted, not added.
 *   total   = qty × MRP
 *   gst     = total × rate / (100 + rate)   ← extracted from MRP
 *   taxable = total − gst
 */
function lineCalc(item) {
  // ROUND EACH LINE TO PAISE, in the same order the server does it.
  //
  // Per-unit prices carry FOUR decimals, because a Rs.100 strip of 15 tablets
  // is Rs.6.6667 a tablet and nothing else divides cleanly.  So the raw
  // multiplication here lands on Rs.100.0005 for one strip, and an unrounded
  // bill would show a total a fraction of a paisa away from the invoice the
  // server stores -- the same screen-versus-server mismatch, one tier smaller.
  //
  // billing_service quantizes the line total FIRST and then extracts GST from
  // that rounded figure, so this does the two steps in that order too.  Do not
  // reorder them: GST taken from the unrounded total can differ by a paisa.
  const total = round2(item.qty * item.unit_price);
  const gst = round2(total * item.gst_rate / (100 + item.gst_rate));
  const taxable = round2(total - gst);
  return { taxable, gst, total };
}

/**
 * The identity of one bill row: medicine + the physical batch it came from.
 *
 * The search dropdown lists one row per batch, so a pharmacist can legitimately
 * put two boxes of DOLO 650 with different expiry dates on the same bill.  They
 * share a product_id, so product_id alone would make the two rows collide —
 * editing one would edit the other.  This key keeps them apart.
 *
 * 'auto' covers rows added without a batch (nothing selected a specific box);
 * those fall back to server-side FEFO at checkout.
 */
function lineKeyOf(product) {
  return `${product.id}::${product.batch_id ?? 'auto'}`;
}

// ─── Main component ───────────────────────────────────────────────────────────

/**
 * Inter (regular + semibold), trimmed to the characters an invoice needs and
 * served from /fonts.  Loaded on the first PDF only, then kept for the
 * session.  jsPDF wants each font as a base64 string.
 */
let invoiceFontsPromise = null;
function loadInvoiceFonts() {
  if (!invoiceFontsPromise) {
    const toBase64 = async (path) => {
      const res = await fetch(path);
      if (!res.ok) throw new Error('Invoice font missing: ' + path);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(bin);
    };
    invoiceFontsPromise = Promise.all([
      toBase64('/fonts/Inter-Regular.ttf'),
      toBase64('/fonts/Inter-SemiBold.ttf'),
    ]).then(([regular, semibold]) => ({ regular, semibold }))
      .catch((e) => { invoiceFontsPromise = null; throw e; });   // retry next time
  }
  return invoiceFontsPromise;
}

export default function Billing() {
  // The shop's own identity (Pharmacy Settings) — printed on the A4 invoice.
  const { pharmacy } = usePharmacy();
  const searchRef = useRef(null);   // keeps a pointer to the search <input>
  const completeSaleRef = useRef(); // ref so F10 always calls the latest version
  // The scrolling bill-items pane in the left panel.  The search box is pinned
  // above it, so a long bill scrolls underneath rather than pushing the search
  // box off-screen — and we scroll this to the bottom after each new item.
  const billContainerRef = useRef(null);

  // Bill state — each item:
  //   { line_key, product_id, batch_id, batch_number, name, qty, unit_price,
  //     gst_rate, unit, current_stock, …strip fields }
  //
  // WHY line_key AND product_id: the medicine search now returns one row per
  // BATCH, so the same medicine can legitimately appear twice in one bill —
  // two boxes with different batch numbers and expiry dates.  product_id can
  // therefore no longer identify a row.  line_key (product + batch) can.
  const [bill, setBill] = useState([]);

  // Payment + optional patient link
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [discount, setDiscount] = useState('');
  // How to read the number in `discount`: as rupees off, or as a percentage of
  // the bill.  The number typed is kept as-is when switching modes, so "10"
  // becomes ₹10 off or 10% off depending on which button is active.
  const [discountMode, setDiscountMode] = useState('AMOUNT'); // 'AMOUNT' | 'PERCENT'
  // Credit-specific fields (only relevant when paymentMethod === 'CREDIT')
  const [amountPaidToday, setAmountPaidToday] = useState('');
  const [creditDueDate, setCreditDueDate] = useState('');

  // ── Home visit / drip charge (Feature 4) ──────────────────────────────────
  // A flat SERVICE fee for administering a drip or injection at the patient's
  // home.  It is not a medicine: no batch, no stock movement, and no GST.
  const [homeVisitOn,      setHomeVisitOn]      = useState(false);
  const [homeVisitAmount,  setHomeVisitAmount]  = useState('100.00');
  const [homeVisitNotes,   setHomeVisitNotes]   = useState('');
  const [homeVisitDefault, setHomeVisitDefault] = useState(100);
  const [creditNotes, setCreditNotes] = useState('');
  const [patientSearch, setPatientSearch] = useState('');
  const [patientResults, setPatientResults] = useState([]);
  const [selectedPatient, setSelectedPatient] = useState(null);
  // showAddForm opens the full patient-registration modal (same fields as the
  // Patients page) pre-filled with whatever the pharmacist typed in the search.
  const [showAddForm, setShowAddForm] = useState(false);
  const [isPrescription, setIsPrescription] = useState(false);
  const [referredBy, setReferredBy] = useState('');
  const [referredByAutoFilled, setReferredByAutoFilled] = useState(false);
  // The prescriber's ADDRESS.  The Schedule H1 register asks for "name and
  // address of the prescriber", not the name alone, so a bill containing a
  // regulated medicine cannot be completed without it.
  const [referredByAddress, setReferredByAddress] = useState('');
  const [availableTags, setAvailableTags] = useState([]);
  const [departments, setDepartments] = useState([]);
  // Short-lived green confirmation message in the bottom-right corner
  const [toast, setToast] = useState('');

  // Credit status of the selected patient — the response of
  // GET /api/credit/patient/{id}.  Drives the two banners under the patient
  // card: red for defaulters, amber for any outstanding balance.
  const [patientCredit, setPatientCredit] = useState(null);

  // Prescription upload state
  // prescriptionFiles holds the chosen PAGES, in order, until the invoice is
  // saved; after saving each one is uploaded with the real invoice_id and the
  // list is reset.  A prescription is routinely two or three sheets, so this
  // is a list rather than a single file.
  const [prescriptionFiles, setPrescriptionFiles] = useState([]);
  // historyPatient = { id, name } for the Patient History panel on the right.
  // It is separate from selectedPatient so the pharmacist can close the panel
  // (× button) without unlinking the patient from the bill.
  const [historyPatient, setHistoryPatient] = useState(null);
  // uploadWarning = yellow toast shown when the prescription upload fails after bill save
  const [uploadWarning, setUploadWarning] = useState('');

  // Drug interaction state
  // `interactionResult` is null (no check yet) or the API response object.
  const [interactionResult, setInteractionResult] = useState(null);
  // Dismissed = user clicked X on the banner; resets whenever a new item is added.
  const [interactionDismissed, setInteractionDismissed] = useState(false);
  // Acknowledged = pharmacist checked the override checkbox.
  const [interactionAcknowledged, setInteractionAcknowledged] = useState(false);
  // Track previous bill length so we know when a NEW item was added vs qty changed.
  const prevBillLengthRef = useRef(0);
  // Same idea, but owned by the auto-scroll effect below.  It gets its own ref
  // rather than sharing the one above, because that one is reset inside the
  // interaction effect — whichever effect ran second would see it already
  // updated and never fire.
  const scrolledBillLengthRef = useRef(0);

  // UI state
  const [completing, setCompleting] = useState(false);
  const [receipt, setReceipt] = useState(null);   // set = show receipt modal
  const [showPrinterSetup, setShowPrinterSetup] = useState(false); // printer help modal
  const [error, setError] = useState(null);

  // Barcode scanner state
  // scanFlash: briefly flashes the search box border green when USB scanner fires
  // lastScannedId: line_key (product + batch) of the most recently scanned item
  //                — that row flashes green for a second
  // cameraOpen: controls the camera scanner modal
  // scanNotification: {type:'success'|'warning'|'error', message} shown near search box
  const [scanFlash, setScanFlash]           = useState(false);
  const [lastScannedId, setLastScannedId]   = useState(null);
  const [cameraOpen, setCameraOpen]         = useState(false);
  const [scanNotification, setScanNotification] = useState(null);

  // ── Load patient tags + departments on mount ────────────────────────────────
  // Both feed the "create new patient" modal, so we fetch them once up front
  // rather than when the modal opens — that keeps the modal instant to open.
  useEffect(() => {
    api.get('/patients/tags')
      .then(r => setAvailableTags(r.data))
      .catch(() => { });
    api.get('/inventory/departments')
      .then(r => setDepartments(r.data))
      .catch(() => { });
  }, []);

  // ── Toast helper ────────────────────────────────────────────────────────────
  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  // ── Debounced patient search ────────────────────────────────────────────────
  useEffect(() => {
    if (patientSearch.length < 2) { setPatientResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await api.get('/patients/', { params: { query: patientSearch, limit: 5 } });
        setPatientResults(res.data.items || res.data);
      } catch {
        setPatientResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  // ── Drug interaction check ──────────────────────────────────────────────────
  // Runs automatically every time the bill changes.
  // When a NEW product is added (bill grows longer), the banner is un-dismissed
  // so the pharmacist cannot miss it.
  useEffect(() => {
    // De-duplicated: two batches of the same medicine are two bill rows but
    // only one drug as far as an interaction check is concerned.
    const ids = [...new Set(bill.map(i => i.product_id))];

    // A new item was added — lift dismissal so the banner re-shows
    if (bill.length > prevBillLengthRef.current) {
      setInteractionDismissed(false);
      setInteractionAcknowledged(false);
    }
    prevBillLengthRef.current = bill.length;

    if (ids.length < 2) {
      setInteractionResult(null);  // nothing to check with only 0 or 1 item
      return;
    }

    api.post('/interactions/check', { product_ids: ids })
      .then(r => setInteractionResult(r.data))
      .catch(() => { /* non-fatal — silently skip if backend is unreachable */ });
  }, [bill]);

  // ── Keep the newest bill row in view ────────────────────────────────────────
  // The bill items pane scrolls independently now, so on a long bill a freshly
  // added medicine lands below the fold and the pharmacist gets no feedback
  // that the scan worked.  Scroll the pane to the bottom whenever a row is
  // ADDED (not when a quantity changes, and not when a row is removed).
  //
  // ⚠ This has to be an effect, not a line inside addToBill().  addToBill only
  // queues the state update — the new <tr> does not exist yet at that point, so
  // scrollHeight would still be the OLD height and we would stop one row short.
  // By the time an effect runs, React has committed the row to the DOM.
  useEffect(() => {
    if (bill.length > scrolledBillLengthRef.current) {
      const pane = billContainerRef.current;
      pane?.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' });
    }
    scrolledBillLengthRef.current = bill.length;
  }, [bill.length]);

  // ── Add a product to the bill ───────────────────────────────────────────────
  // `product` is a MedicineSearchResult from MedicineSearchBox — ONE BATCH of
  // one medicine:
  //   { id, batch_id, batch_number, name, selling_price, gst_rate, unit,
  //     available_stock, rack_location, ... }
  // MedicineSearchBox clears the input and returns focus by itself after
  // calling onSelect, so we only need to update bill state here.
  function addToBill(product) {
    // Identity of a bill row = medicine + batch.  Picking the same batch twice
    // bumps the quantity; picking a DIFFERENT batch of the same medicine adds
    // a second row, because the two boxes have different expiry dates and the
    // invoice has to record which one actually left the shelf.
    const lineKey = lineKeyOf(product);

    setBill(prev => {
      const existing = prev.find(i => i.line_key === lineKey);
      if (existing) {
        return prev.map(i =>
          i.line_key === lineKey ? { ...i, qty: i.qty + 1 } : i
        );
      }
      // Strip medicines (Feature 3) can be billed either as whole strips or as
      // loose tablets.  We default to STRIP because that is how most tablet
      // sales happen; the pharmacist can flip the row to units in one click.
      const isStrip  = Boolean(product.is_strip && product.units_per_strip);
      const perStrip = Number(product.units_per_strip) || 1;
      const unitMrp  = product.unit_mrp != null
        ? parseFloat(product.unit_mrp)
        : parseFloat(product.selling_price);
      const stripMrp = product.strip_mrp != null
        ? parseFloat(product.strip_mrp)
        : unitMrp * perStrip;

      return [...prev, {
        line_key:      lineKey,
        product_id:    product.id,
        // The exact batch the pharmacist picked.  Sent with the invoice so the
        // server deducts THIS box rather than guessing via FEFO.  null only for
        // rows that came from somewhere without batch information.
        batch_id:      product.batch_id ?? null,
        batch_number:  product.batch_number ?? null,
        name:          product.name,
        // Carried so the bill can auto-detect drip/injection items and only
        // then offer the home-visit charge (Feature 4).
        medicine_type: product.medicine_type || null,
        qty:           1,
        // unit_price is the price of ONE of whatever is being sold — one strip
        // in strip mode, one tablet in unit mode.  lineCalc just multiplies.
        unit_price:    isStrip ? stripMrp : parseFloat(product.selling_price),
        gst_rate:      parseFloat(product.gst_rate),
        unit:          product.unit || 'unit',
        current_stock: product.available_stock,
        // Strip metadata — carried on the row so the selector can switch modes
        // without another API call.
        is_strip:        isStrip,
        units_per_strip: isStrip ? perStrip : null,
        strip_mrp:       isStrip ? stripMrp : null,
        unit_mrp:        isStrip ? unitMrp  : null,
        sell_mode:       isStrip ? 'strip' : 'unit',
        // 'H1' | 'MTP' | null — drives the register warning on this screen.
        register_category: product.register_category || null,
      }];
    });
  }

  function updateQty(line_key, newQty) {
    const n = parseInt(newQty, 10);
    if (isNaN(n) || n < 1) {
      removeFromBill(line_key);
    } else {
      setBill(prev => prev.map(i => i.line_key === line_key ? { ...i, qty: n } : i));
    }
  }

  /**
   * Switch one bill row between selling whole strips and loose tablets.
   *
   * Changing the mode also changes what "1" means, so the unit price is
   * swapped to match.  The quantity is deliberately LEFT ALONE — "3" means
   * 3 strips or 3 tablets depending on the mode, and silently converting it
   * would change the customer's bill without them asking.
   */
  function setSellMode(line_key, mode) {
    setBill(prev => prev.map(i => {
      if (i.line_key !== line_key || !i.is_strip) return i;
      return {
        ...i,
        sell_mode:  mode,
        unit_price: mode === 'strip' ? i.strip_mrp : i.unit_mrp,
      };
    }));
  }

  function removeFromBill(line_key) {
    setBill(prev => prev.filter(i => i.line_key !== line_key));
  }

  // ── Barcode scanner ─────────────────────────────────────────────────────────

  // showScanNotification: displays a short banner near the search box, auto-hides
  function showScanNotification(type, message) {
    setScanNotification({ type, message });
    setTimeout(() => setScanNotification(null), 2500);
  }

  // handleBarcodeScan: called by both USB hook and camera scanner on a successful scan.
  // 1. Flash the search box border green so the pharmacist gets visual feedback.
  // 2. Look up the product via the barcode endpoint.
  // 3. If out of stock: show a warning — do NOT add to bill.
  // 4. Otherwise: addToBill handles dedup (increments qty if already in bill).
  // 5. Flash the added row green for 1 second.
  const handleBarcodeScan = useCallback(async (barcode) => {
    // Brief green flash on the search box
    setScanFlash(true);
    setTimeout(() => setScanFlash(false), 300);

    try {
      const res     = await api.get(`/search/barcode/${barcode}`);
      const product = res.data;

      // Two different reasons the scan can't be billed, and the pharmacist
      // needs different actions for each: near-expiry stock goes back to the
      // supplier, an empty shelf gets reordered.
      if (product.out_of_stock) {
        showScanNotification(
          'warning',
          product.all_batches_near_expiry
            ? `${product.name} — all batches expire within 30 days, return to supplier`
            : `${product.name} — out of stock`,
        );
        return;
      }

      // addToBill already handles dedup: if this exact batch is already in the
      // bill, it increments qty by 1 instead of adding a new row.
      addToBill(product);

      // Flash the row green briefly.  Matched on the line key (medicine +
      // batch) so only the row that actually changed lights up, even when the
      // bill holds two batches of the same medicine.
      setLastScannedId(lineKeyOf(product));
      setTimeout(() => setLastScannedId(null), 1000);

    } catch (err) {
      if (err.response?.status === 404) {
        showScanNotification('error', 'Barcode not found — medicine not in system');
      } else {
        showScanNotification('error', 'Scanner error — please try again');
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // USB scanner hook — listens on the window for fast keystroke bursts.
  // Disabled while the camera modal is open so the two inputs don't conflict.
  useBarcodeScanner({
    onScan:  handleBarcodeScan,
    enabled: !cameraOpen,
  });

  // ── Patient helpers ─────────────────────────────────────────────────────────

  function handleSelectPatient(patient) {
    setSelectedPatient(patient);
    // Open the Patient History panel on the right for this patient.
    setHistoryPatient({ id: patient.id, name: patient.name });
    setPatientSearch('');
    setPatientResults([]);
    setShowAddForm(false);
    // Switching patients must not carry the previous patient's prescription
    // image over to the new one.
    setPrescriptionFiles([]);
    // Auto-set prescription toggle based on patient type
    if (patient.patient_type === 'PRESCRIPTION') {
      setIsPrescription(true);
    } else {
      setIsPrescription(false);
      setReferredBy('');
    }
    // Try to get the last doctor name from OPD visits
    api.get(`/billing/patient/${patient.id}/last-doctor`)
      .then(r => {
        if (r.data.doctor_name) {
          setReferredBy(r.data.doctor_name);
          setReferredByAutoFilled(true);
        } else {
          setReferredBy('');
          setReferredByAutoFilled(false);
        }
      })
      .catch(() => { });

    // Look up their credit standing so the banners can render immediately.
    // A brand-new patient has no credit account — the backend returns an
    // empty account with all flags false, so nothing is shown.
    setPatientCredit(null);
    api.get(`/credit/patient/${patient.id}`)
      .then(r => setPatientCredit(r.data))
      .catch(() => setPatientCredit(null));   // never block the sale on this
  }

  function clearPatient() {
    setSelectedPatient(null);
    setHistoryPatient(null);
    setIsPrescription(false);
    setReferredBy('');
    setReferredByAutoFilled(false);
    setPatientSearch('');
    setPatientResults([]);
    setPrescriptionFiles([]);
    setPatientCredit(null);
  }

  // Called by PatientRegisterModal after POST /api/patients succeeds.
  function handlePatientCreated(patient) {
    handleSelectPatient(patient);   // also closes the modal
    showToast('Patient created and selected');
  }

  // Fetch the shop's default home visit charge once, to pre-fill the amount.
  // A failure here is harmless — the field just keeps its ₹100 fallback.
  useEffect(() => {
    api.get('/billing/home-visit-charge')
      .then(({ data }) => {
        const amt = Number(data.default_amount) || 100;
        setHomeVisitDefault(amt);
        setHomeVisitAmount(amt.toFixed(2));
      })
      .catch(() => { /* keep the fallback default */ });
  }, []);

  // ── Compute bill totals ─────────────────────────────────────────────────────
  /**
   * Does this bill need a register entry?
   *
   * True as soon as one Schedule H1 medicine or MTP kit is on it.  Used to
   * warn the pharmacist WHILE they build the bill, rather than letting them
   * reach the end and be refused — the customer is still standing there at
   * that point, which is the only moment the details can be collected.
   *
   * The server enforces this regardless; this is courtesy, not security.
   */
  const needsRegister = useMemo(
    () => bill.some((i) => i.register_category),
    [bill],
  );

  const totals = useMemo(() => {
    let subtotal = 0, gstTotal = 0, mrpTotal = 0;
    for (const item of bill) {
      const { taxable, gst, total } = lineCalc(item);
      subtotal += taxable;   // excl-GST sum
      gstTotal += gst;       // GST extracted from MRP
      mrpTotal += total;     // sum of MRPs (what customer pays per line)
    }
    const typed = parseFloat(discount) || 0;

    // In PERCENT mode the typed number is a share of the bill, so convert it to
    // rupees here.  Everything downstream (the TOTAL line, the invoice we POST,
    // the printed receipt) only ever deals in rupees — the percentage is purely
    // a convenience for the person at the counter.
    // The percentage is capped at 100 so a stray "1000" cannot invert the bill.
    const discountAmt = discountMode === 'PERCENT'
      ? mrpTotal * Math.min(Math.max(typed, 0), 100) / 100
      : Math.max(typed, 0);

    // Never discount below zero, and never more than the bill is worth.
    // NOTE: the discount applies to the MEDICINES only — the home visit fee is
    // a service the pharmacist performed, so it is added after the discount.
    const appliedDiscount = Math.min(discountAmt, mrpTotal);

    const homeVisit = homeVisitOn ? Math.max(parseFloat(homeVisitAmount) || 0, 0) : 0;

    return {
      subtotal: subtotal.toFixed(2),
      gstTotal: gstTotal.toFixed(2),
      discountAmount: appliedDiscount.toFixed(2),
      homeVisit: homeVisit.toFixed(2),
      // Medicines (incl. GST) − discount + service fee
      total: Math.max(0, mrpTotal - appliedDiscount + homeVisit).toFixed(2),
    };
  }, [bill, discount, discountMode, homeVisitOn, homeVisitAmount]);

  // ── Home-visit relevance (Feature 4) ────────────────────────────────────────
  // The home-visit / drip charge only makes sense when the bill actually
  // contains something administered on-site (a drip or an injection).  We infer
  // that from the medicine_type OR the product name, so it works even for items
  // that were not explicitly typed as "INJECTION".
  const hasDripOrInjection = useMemo(() => bill.some(item => {
    const name = (item.name || '').toLowerCase();
    const type = (item.medicine_type || '').toLowerCase();
    return (
      type === 'injection' ||
      name.includes('drip') ||
      name.includes('infusion') ||
      name.includes('injection') ||
      name.includes('saline') ||
      name.includes(' iv ') ||
      name.includes('intravenous') ||
      name.includes('dextrose') ||
      name.includes('ringer')
    );
  }), [bill]);

  // When the last drip/injection leaves the bill, the section disappears — so
  // clear the charge too, otherwise a now-hidden fee would still hit the total.
  useEffect(() => {
    if (!hasDripOrInjection && homeVisitOn) {
      setHomeVisitOn(false);
      setHomeVisitAmount(homeVisitDefault.toFixed(2));
      setHomeVisitNotes('');
    }
  }, [hasDripOrInjection, homeVisitOn, homeVisitDefault]);

  // ── Credit helpers ──────────────────────────────────────────────────────────

  // Default due date = today (IST) + 30 days (ISO string for the date input)
  function defaultCreditDueDate() {
    const d = new Date(getTodayIST() + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 30);
    return d.toISOString().split('T')[0];
  }

  // creditAmount = total bill − amount paid today
  const creditAmount = (() => {
    if (paymentMethod !== 'CREDIT') return 0;
    const paid = parseFloat(amountPaidToday) || 0;
    const total = parseFloat(totals.total) || 0;
    return Math.max(0, total - paid);
  })();

  // ── Complete sale ───────────────────────────────────────────────────────────
  const completeSale = useCallback(async () => {
    if (bill.length === 0 || completing) return;

    // --- Credit mode validation -----------------------------------------
    if (paymentMethod === 'CREDIT') {
      if (!selectedPatient) {
        setError('Please select a patient to give credit.');
        return;
      }
      const paid  = parseFloat(amountPaidToday) || 0;
      const total = parseFloat(totals.total) || 0;
      if (paid < 0) {
        setError('Amount paid today cannot be negative.');
        return;
      }
      if (paid >= total) {
        setError('Amount paid today must be less than the total (otherwise use Cash or UPI).');
        return;
      }
      const dueDate = creditDueDate || defaultCreditDueDate();
      if (dueDate < getTodayIST()) {   // compare YYYY-MM-DD strings in IST
        setError('Due date must be today or in the future.');
        return;
      }
    }

    setCompleting(true);
    setError(null);
    setUploadWarning('');

    // Build due date string (use default if not set)
    const effectiveDueDate = paymentMethod === 'CREDIT'
      ? (creditDueDate || defaultCreditDueDate())
      : null;

    try {
      const res = await api.post('/billing/invoices', {
        // Stock is tracked in individual UNITS, so a row being sold as strips
        // is multiplied out here.  The backend never sees "strips".
        items: bill.map(i => ({
          product_id: i.product_id,
          quantity:   i.sell_mode === 'strip' ? i.qty * i.units_per_strip : i.qty,
          // The batch the pharmacist actually picked.  The server deducts this
          // one first and only spills into FEFO order if it runs short.
          batch_id:   i.batch_id ?? null,
        })),
        patient_id: selectedPatient?.id || null,
        payment_method: paymentMethod,
        // Always the resolved RUPEE figure — the backend never sees a
        // percentage, so a 10% bill and a ₹10 bill store identically.
        discount_amount: parseFloat(totals.discountAmount) || 0,
        referred_by: isPrescription && referredBy.trim() ? referredBy.trim() : null,
        referred_by_address: referredByAddress.trim() || null,
        amount_paid: paymentMethod === 'CREDIT' ? (parseFloat(amountPaidToday) || 0) : undefined,
        credit_due_date: effectiveDueDate,
        // Home visit / drip service charge (Feature 4) — no GST applies.
        home_visit_charge: homeVisitOn ? (parseFloat(homeVisitAmount) || 0) : 0,
        home_visit_notes:  homeVisitOn && homeVisitNotes.trim() ? homeVisitNotes.trim() : null,
      });
      const savedInvoice = res.data;
      setReceipt(savedInvoice);

      // Upload prescription silently after the bill is saved, now that we
      // have the real invoice_id to link it to.
      if (prescriptionFiles.length > 0 && selectedPatient?.id) {
        // One row per PAGE, uploaded in order, each carrying its position in
        // its notes.  The prescriptions table already allowed many rows per
        // invoice, so a three-page prescription needs no schema change — only
        // three uploads instead of one.
        //
        // Sequential, not Promise.all: the pages must land in order, and ten
        // simultaneous multipart posts to a local server is a worse bet than
        // ten quick ones.
        const total = prescriptionFiles.length;
        // One id shared by every page of THIS upload — it is the only thing
        // that later ties the sheets back together as one prescription.
        // Not the invoice id: a patient can legitimately have two separate
        // prescriptions against one bill, and a prescription can be uploaded
        // before any bill exists.
        const groupId = (crypto?.randomUUID?.() ?? `rx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        let failed = 0;
        for (let i = 0; i < total; i += 1) {
          try {
            const form = new FormData();
            form.append('file',        prescriptionFiles[i]);
            form.append('patient_id',  selectedPatient.id);
            form.append('invoice_id',  savedInvoice.id);
            form.append('group_id',    groupId);
            form.append('page_number', String(i + 1));
            form.append('notes',       `Page ${i + 1} of ${total}`);
            await api.post('/prescriptions/upload', form, {
              headers: { 'Content-Type': 'multipart/form-data' },
            });
          } catch {
            failed += 1;
          }
        }
        // The bill is already saved, so a failed page is a warning, never an
        // error — and it says HOW MANY failed, because "some pages are
        // missing" is a different problem from "nothing uploaded".
        if (failed > 0) {
          setUploadWarning(
            failed === total
              ? 'Bill saved, but the prescription did not upload — please add it again from Patient History.'
              : `Bill saved, but ${failed} of ${total} prescription pages did not upload — please add them again from Patient History.`
          );
        }
        setPrescriptionFiles([]);
      }
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to create invoice. Please try again.');
    } finally {
      setCompleting(false);
    }
  }, [bill, completing, selectedPatient, paymentMethod, discount, isPrescription, referredBy, referredByAddress, prescriptionFiles, amountPaidToday, creditDueDate, totals]);

  // Keep the ref up to date so the F10 handler always calls the latest version
  completeSaleRef.current = completeSale;

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'F2') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'F10') {
        e.preventDefault();
        completeSaleRef.current?.();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // ── Reset everything for a new sale ────────────────────────────────────────
  function newSale() {
    setBill([]);
    setDiscount('');
    // Back to rupees, so a percentage used on one sale is not silently
    // reapplied to the next customer's bill.
    setDiscountMode('AMOUNT');
    setPaymentMethod('CASH');
    setAmountPaidToday('');
    setCreditDueDate('');
    setCreditNotes('');
    // Clear the home visit fee — it applies to one specific visit, so leaving
    // it ticked would silently charge the next customer for a service that
    // never happened.
    setHomeVisitOn(false);
    setHomeVisitAmount(homeVisitDefault.toFixed(2));
    setHomeVisitNotes('');
    setSelectedPatient(null);
    setIsPrescription(false);
    setReferredBy('');
    setReferredByAutoFilled(false);
    setPatientSearch('');
    setPatientResults([]);
    setShowAddForm(false);
    setPatientCredit(null);
    setReceipt(null);
    setError(null);
    setScanFlash(false);
    setLastScannedId(null);
    setCameraOpen(false);
    setScanNotification(null);
    setInteractionResult(null);
    setInteractionDismissed(false);
    setInteractionAcknowledged(false);
    prevBillLengthRef.current = 0;
    setPrescriptionFiles([]);
    setHistoryPatient(null);
    setUploadWarning('');
    // Small timeout lets the modal unmount before we try to focus
    setTimeout(() => searchRef.current?.focus(), 50);
  }

  // ── Print the 80mm thermal receipt ───────────────────────────────────────────
  // window.print() opens the browser's print dialog. thermal-print.css (an
  // @media print stylesheet) then hides everything on the page except the
  // #thermal-receipt element and formats it for 80mm thermal paper. The cashier
  // just picks their thermal printer in the dialog and prints.
  function handlePrint() {
    window.print();
  }

  // ── A4 Tax Invoice PDF — Curavo design "A, Clean ledger" (Nov 2026) ─────────
  //
  // White page, one thin accent line, light-grey table header: it reads well
  // in colour AND on a black-and-white laser printer, and uses little toner
  // (the old design had a full navy header and a filled green total box).
  //
  // Every figure comes from the server's own numbers for this bill
  // (taxable_amount / gst_amount / line_total per line, totals on the
  // invoice) — the PDF never re-derives a price, so it cannot disagree with
  // what was charged.  Shop identity comes from Pharmacy Settings; the logo
  // and signature are the shop's own uploads (lib/branding.js).
  //
  // Text uses Inter (frontend/public/fonts, SIL Open Font Licence), embedded
  // because jsPDF's built-in Helvetica has no ₹ sign — the old invoice had to
  // print "Rs.".
  async function printReceipt(invoice) {
    if (!invoice) return;

    // Name printed on this tax invoice (header + "For …" signatory line).
    const invoiceShopName = (pharmacy.invoice_name || '').trim()
      || (pharmacy.pharmacy_name || '').toUpperCase();

    // Colours — ink first; the accent is only ever a thin line or a word.
    const INK    = [17, 24, 39];
    const MUTED  = [75, 85, 99];
    const HINT   = [107, 114, 128];
    const RULE   = [229, 231, 235];
    const HEADBG = [243, 244, 246];
    const ACCENT = [79, 70, 229];

    // Money: always 2 decimals, Indian grouping, real ₹ sign.
    const rs = (v) => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Round half-up to paise (same rule billing_service uses).
    const paise = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
    // "2027-08-31" -> "08/27"
    const mmyy = (d) => (d ? `${d.slice(5, 7)}/${d.slice(2, 4)}` : '—');

    try {
      const jsPDF = (await import('jspdf')).default;
      const { default: autoTable } = await import('jspdf-autotable');
      const [fonts, logo, signature] = await Promise.all([
        loadInvoiceFonts(), loadBrandingImage('logo'), loadBrandingImage('signature'),
      ]);

      const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      doc.addFileToVFS('Inter-Regular.ttf', fonts.regular);
      doc.addFont('Inter-Regular.ttf', 'Inter', 'normal');
      doc.addFileToVFS('Inter-SemiBold.ttf', fonts.semibold);
      doc.addFont('Inter-SemiBold.ttf', 'Inter', 'bold');
      const font = (style, size, color = INK) => {
        doc.setFont('Inter', style); doc.setFontSize(size); doc.setTextColor(...color);
      };
      // Fit an image inside a w×h box, keeping its shape; returns the drawn size.
      const placeImage = (img, x, y, w, h, align = 'left') => {
        const scale = Math.min(w / img.width, h / img.height);
        const dw = img.width * scale, dh = img.height * scale;
        const dx = align === 'center' ? x + (w - dw) / 2 : align === 'right' ? x + w - dw : x;
        doc.addImage(img.dataUrl, 'PNG', dx, y + (h - dh) / 2, dw, dh);
        return { dw, dh };
      };
      // One line of text, cut with "…" if it would not fit in `w` mm.
      const fit = (text, w) => {
        let t = String(text ?? '');
        if (doc.getTextWidth(t) <= w) return t;
        while (t.length > 1 && doc.getTextWidth(t + '…') > w) t = t.slice(0, -1);
        return t + '…';
      };

      const PW = 210, PH = 297, ML = 14, MR = 14, CW = PW - ML - MR;
      let y = 13;

      // ── 1. Shop identity (left) + TAX INVOICE / GSTIN / DL (right) ────────
      const LOGO = 15;
      let textX = ML;
      if (logo) {
        doc.setDrawColor(...RULE); doc.setLineWidth(0.3);
        doc.roundedRect(ML, y, LOGO, LOGO, 3, 3, 'S');
        placeImage(logo, ML + 1.2, y + 1.2, LOGO - 2.4, LOGO - 2.4, 'center');
        textX = ML + LOGO + 4;
      }
      const RIGHT_W = 64;                              // right-hand column
      const LEFT_W  = PW - MR - RIGHT_W - 6 - textX;

      font('bold', 15);
      doc.text(fit(invoiceShopName, LEFT_W), textX, y + 5.2);
      font('normal', 8, MUTED);
      let addr = (pharmacy.pharmacy_address || '').split('\n').map((l) => l.trim()).filter(Boolean);
      if (addr.length === 1) addr = doc.splitTextToSize(addr[0], LEFT_W);
      if (addr.length > 2) addr = [addr[0], addr.slice(1).join(', ')];
      let ly = y + 10.2;
      addr.forEach((line) => { doc.text(fit(line, LEFT_W), textX, ly); ly += 3.9; });
      if (pharmacy.pharmacy_phone) { doc.text('Ph: ' + pharmacy.pharmacy_phone, textX, ly); ly += 3.9; }

      // Letter-spaced title: jsPDF's right-align ignores charSpace, so place
      // it from the left using its true spaced width.
      font('bold', 9.5, ACCENT);
      const TITLE = 'TAX INVOICE', SPACE = 0.9;
      const titleW = doc.getTextWidth(TITLE) + SPACE * (TITLE.length - 1);
      doc.text(TITLE, PW - MR - titleW, y + 4, { charSpace: SPACE });
      let ry = y + 9.6;
      const labelled = (label, value) => {
        font('bold', 8, INK);
        const vw = doc.getTextWidth(value);
        doc.text(value, PW - MR, ry, { align: 'right' });
        font('normal', 8, MUTED);
        doc.text(label + '  ', PW - MR - vw, ry, { align: 'right' });
        ry += 4.4;
      };
      if (pharmacy.pharmacy_gstin)     labelled('GSTIN', pharmacy.pharmacy_gstin);
      if (pharmacy.pharmacy_dl_number) labelled('DL', fit(pharmacy.pharmacy_dl_number, RIGHT_W - 8));

      y = Math.max(ly, ry, logo ? y + LOGO + 2 : 0) + 2;
      doc.setDrawColor(...ACCENT); doc.setLineWidth(0.6);
      doc.line(ML, y, PW - MR, y);
      y += 4.5;

      // ── 2. Invoice details: four boxes in one bordered strip ──────────────
      const META_H = 16, colW = CW / 4;
      doc.setDrawColor(...RULE); doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, CW, META_H, 2, 2, 'S');
      for (let i = 1; i < 4; i++) doc.line(ML + colW * i, y, ML + colW * i, y + META_H);
      const isCredit = (invoice.payment_method || '').toUpperCase() === 'CREDIT';
      const meta = [
        ['INVOICE NO.', invoice.invoice_number, null],
        ['DATE', formatDateTimeShort(invoice.invoice_date), null],
        ['PATIENT', invoice.patient_name || 'Walk-in Customer', invoice.patient_mobile || null],
        ['PAYMENT', invoice.payment_method || 'CASH',
          isCredit && invoice.credit_due_date ? 'Due ' + formatDateOnly(invoice.credit_due_date)
            : invoice.referred_by ? 'Ref. by ' + invoice.referred_by : null],
      ];
      meta.forEach(([label, value, sub], i) => {
        const x = ML + colW * i + 3.2, w = colW - 6.4;
        font('bold', 6.3, HINT);
        doc.text(label, x, y + 4.6, { charSpace: 0.35 });
        font('bold', 8.6);
        doc.text(fit(value, w), x, y + 9.4);
        if (sub) { font('normal', 7.3, MUTED); doc.text(fit(sub, w), x, y + 13.2); }
      });
      y += META_H + 5;

      // ── 3. Items ───────────────────────────────────────────────────────────
      const items = invoice.items || [];
      autoTable(doc, {
        startY: y,
        margin: { left: ML, right: MR, top: 16, bottom: 34 },
        head: [['#', 'MEDICINE', 'BATCH', 'EXP', 'HSN', 'QTY', 'TAXABLE', 'GST', 'AMOUNT']],
        body: items.map((it, i) => [
          i + 1,
          it.product_name,
          it.batch_number || '—',
          mmyy(it.expiry_date),
          it.hsn_code || '—',
          it.quantity,
          rs(it.taxable_amount),
          Number(it.gst_rate) + '%',
          rs(it.line_total),
        ]),
        theme: 'plain',
        showHead: 'everyPage',
        styles: {
          font: 'Inter', fontStyle: 'normal', fontSize: 8, textColor: INK,
          cellPadding: { top: 2.4, bottom: 2.4, left: 1.6, right: 1.6 },
        },
        headStyles: { fillColor: HEADBG, textColor: [55, 65, 81], fontStyle: 'bold', fontSize: 6.5 },
        columnStyles: {
          0: { cellWidth: 7, textColor: HINT },
          1: { cellWidth: 'auto', fontStyle: 'bold' },
          2: { cellWidth: 19 },
          3: { cellWidth: 12 },
          4: { cellWidth: 19.5, textColor: MUTED },
          5: { cellWidth: 11, halign: 'right' },
          6: { cellWidth: 22, halign: 'right' },
          7: { cellWidth: 11, halign: 'right', textColor: MUTED },
          8: { cellWidth: 23, halign: 'right', fontStyle: 'bold' },
        },
        didParseCell(d) {           // right-align the money/qty headers too
          if (d.section === 'head' && d.column.index >= 5) d.cell.styles.halign = 'right';
        },
        didDrawCell(d) {            // hairline under every body row, nothing else
          if (d.section === 'body') {
            doc.setDrawColor(...RULE); doc.setLineWidth(0.25);
            doc.line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
          }
        },
      });
      y = doc.lastAutoTable.finalY + 6;

      // ── 4. GST summary + words (left) and totals (right) ──────────────────
      // Group by rate.  CGST is half the GST rounded half-up; SGST is the rest,
      // so the two always add back to exactly the GST on the lines.
      const byRate = {};
      items.forEach((it) => {
        const r = Number(it.gst_rate);
        byRate[r] = byRate[r] || { taxable: 0, gst: 0 };
        byRate[r].taxable += Number(it.taxable_amount);
        byRate[r].gst += Number(it.gst_amount);
      });
      const gstRows = Object.keys(byRate).map(Number).sort((a, b) => a - b).map((r) => {
        const taxable = paise(byRate[r].taxable), gst = paise(byRate[r].gst);
        const cgst = paise(gst / 2);
        return { r, taxable, cgst, sgst: paise(gst - cgst) };
      });

      const itemsTotal = paise(items.reduce((s, it) => s + Number(it.line_total), 0));
      const homeVisit  = Number(invoice.home_visit_charge || 0);
      const discount   = Number(invoice.discount_amount || 0);
      const grandTotal = Number(invoice.total_amount);

      const SUMMARY_H = 12 + gstRows.length * 4.4 + (gstRows.length > 1 ? 4.4 : 0);
      const blockH = Math.max(SUMMARY_H + 10, 30 + (homeVisit > 0 ? 5 : 0) + (discount > 0 ? 10 : 0));
      if (y + blockH > PH - 36) { doc.addPage(); y = 18; }

      // GST summary box
      const TOT_W = 66, LBOX_W = CW - TOT_W - 10;
      doc.setDrawColor(...RULE); doc.setLineWidth(0.3);
      doc.roundedRect(ML, y, LBOX_W, SUMMARY_H, 2, 2, 'S');
      font('bold', 6.3, HINT);
      doc.text('GST SUMMARY', ML + 3.2, y + 4.8, { charSpace: 0.35 });
      const gx = [ML + 3.2, ML + LBOX_W * 0.45, ML + LBOX_W * 0.7, ML + LBOX_W - 3.2];   // right edges for numbers
      let gy = y + 9.2;
      font('bold', 7.5, [55, 65, 81]);
      doc.text('Rate', gx[0], gy);
      doc.text('Taxable', gx[1], gy, { align: 'right' });
      doc.text('CGST', gx[2], gy, { align: 'right' });
      doc.text('SGST', gx[3], gy, { align: 'right' });
      font('normal', 7.5, [55, 65, 81]);
      const sumRow = (label, t, c, s) => {
        gy += 4.4;
        doc.text(label, gx[0], gy);
        doc.text(rs(t), gx[1], gy, { align: 'right' });
        doc.text(rs(c), gx[2], gy, { align: 'right' });
        doc.text(rs(s), gx[3], gy, { align: 'right' });
      };
      gstRows.forEach((g) => sumRow(`${g.r}%  (${g.r / 2}% + ${g.r / 2}%)`, g.taxable, g.cgst, g.sgst));
      if (gstRows.length > 1) {
        font('bold', 7.5, INK);
        sumRow('Total',
          paise(gstRows.reduce((s, g) => s + g.taxable, 0)),
          paise(gstRows.reduce((s, g) => s + g.cgst, 0)),
          paise(gstRows.reduce((s, g) => s + g.sgst, 0)));
      }
      font('bold', 8, [55, 65, 81]);
      const wordsY = y + SUMMARY_H + 6;
      doc.text('Amount in words:', ML, wordsY);
      const lw = doc.getTextWidth('Amount in words: ');
      font('normal', 8, [55, 65, 81]);
      // The totals column ends above this line, so the words may use the full width.
      doc.text(doc.splitTextToSize(numberToWords(grandTotal) + ' Only', CW - lw), ML + lw, wordsY);

      // Totals column
      const tx = PW - MR - TOT_W;
      let ty = y + 3.5;
      const totalLine = (label, value) => {
        font('normal', 8.3, MUTED);
        doc.text(label, tx, ty);
        doc.text(value, PW - MR, ty, { align: 'right' });
        ty += 5;
      };
      totalLine('Items total (incl. GST)', rs(itemsTotal));
      if (homeVisit > 0) totalLine('Home visit (no GST)', rs(homeVisit));
      if (discount > 0)  totalLine('Discount', '−' + rs(discount));
      ty += 0.5;
      doc.setDrawColor(...INK); doc.setLineWidth(0.55);
      doc.line(tx, ty - 2.2, PW - MR, ty - 2.2);
      font('bold', 10);
      doc.text('TOTAL', tx, ty + 4.2);
      font('bold', 17);
      doc.text(rs(grandTotal), PW - MR, ty + 5, { align: 'right' });
      if (discount > 0) {
        font('bold', 8, ACCENT);
        doc.text('You saved ' + rs(discount), PW - MR, ty + 11, { align: 'right' });
      }

      // ── 5. Footer: notes (left), signature (right) — on the last page ─────
      const fy = PH - 30;
      doc.setDrawColor(...RULE); doc.setLineWidth(0.3);
      doc.line(ML, fy, PW - MR, fy);
      font('normal', 7, HINT);
      doc.text('Prices are MRP, inclusive of GST.', ML, fy + 5);
      doc.text('Computer-generated invoice · Curavo', ML, fy + 9);

      const SIG_W = 60, sx = PW - MR - SIG_W;
      if (signature) placeImage(signature, sx + 8, fy + 2, SIG_W - 16, 11, 'center');
      font('bold', 8);
      doc.text(fit('For ' + invoiceShopName, SIG_W), sx + SIG_W / 2, fy + 17, { align: 'center' });
      font('normal', 7, HINT);
      doc.text('Authorised signatory', sx + SIG_W / 2, fy + 21, { align: 'center' });

      // Page numbers, only when the bill ran past one page.
      const pages = doc.getNumberOfPages();
      if (pages > 1) {
        for (let p = 1; p <= pages; p++) {
          doc.setPage(p);
          font('normal', 7, HINT);
          doc.text(`${invoice.invoice_number} · Page ${p} of ${pages}`, PW / 2, PH - 8, { align: 'center' });
        }
      }

      doc.save('Invoice-' + invoice.invoice_number + '.pdf');

    } catch (err) {
      console.error('printReceipt failed:', err);
      alert('Could not generate PDF: ' + err.message);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', height: '100%' }}>

        {/* ===== LEFT PANEL: Product Search ===== */}
        {/*
          A FIXED-HEIGHT FLEX COLUMN, in two parts: the search box is pinned at
          the top and the bill items scroll underneath it.

          Why: the search dropdown opens directly below the input.  When the
          whole panel was one long document, the dropdown and the bill items
          table competed for the same space and the table won — bill rows were
          painted over the results (see MedicineSearchBox for the stacking-
          context reason).  Giving the list its own scroll pane means the
          dropdown always has empty room to open into, no matter how many
          medicines are on the bill.

          The height is the viewport minus the app chrome around it:
            68px  Layout's topbar
            48px  <main>'s 24px padding, top + bottom
          = calc(100vh - 116px), which exactly fills main's content box so the
          page itself never gains a second scrollbar.
        */}
        <div style={{
          flex:          '0 0 60%',
          display:       'flex',
          flexDirection: 'column',
          height:        'calc(100vh - 116px)',
          overflow:      'hidden',
        }}>

          {/* ── Search area — pinned, never scrolls ── */}
          <div style={{ flexShrink: 0 }}>
          <div className="card" style={{ padding: 20 }}>
            {/* Header row: title on left, "Scanner active" indicator on right */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ fontSize: 18, margin: 0, fontFamily: 'var(--font-display)' }}>
                Add Items
              </h2>
              {/* Green dot indicator — reassures the pharmacist the USB scanner is listening */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--ok)' }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: 'var(--ok)', display: 'inline-block',
                  boxShadow: '0 0 4px rgba(5,150,105,0.5)',
                }} />
                Scanner active
              </div>
            </div>

            {/* Search row: [search box (with flash outline)] [camera button] */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              {/* Flash wrapper — border turns green for 300ms when USB scanner fires */}
              <div style={{
                flex: 1,
                borderRadius: 'var(--radius)',
                outline: scanFlash ? '3px solid var(--ok)' : '3px solid transparent',
                transition: 'outline 0.15s ease',
              }}>
                <MedicineSearchBox
                  inputRef={searchRef}
                  onSelect={addToBill}
                  placeholder="Scan barcode or type medicine name…"
                  autoFocus={true}
                />
              </div>

              {/* Camera scan button */}
              <button
                onClick={() => setCameraOpen(true)}
                title="Open camera to scan barcode"
                style={{
                  flexShrink: 0,
                  height: 48,
                  width: 48,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--glass)',
                  backdropFilter: 'blur(12px)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                  fontSize: 20,
                  transition: 'background 0.15s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-light)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--glass)'}
              >
                📷
              </button>
            </div>

            {/* Scan notification banner — success/warning/error from scanner */}
            {scanNotification && (
              <div style={{
                marginTop: 8,
                padding: '8px 12px',
                borderRadius: 'var(--radius)',
                fontSize: 13,
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: scanNotification.type === 'warning'
                  ? 'rgba(245,158,11,0.12)'
                  : scanNotification.type === 'error'
                    ? 'var(--danger-bg)'
                    : 'rgba(16,185,129,0.12)',
                color: scanNotification.type === 'warning'
                  ? 'var(--warn)'
                  : scanNotification.type === 'error'
                    ? 'var(--danger)'
                    : 'var(--ok)',
                border: `1px solid ${
                  scanNotification.type === 'warning'
                    ? 'rgba(217,119,6,0.25)'
                    : scanNotification.type === 'error'
                      ? 'rgba(225,29,72,0.2)'
                      : 'rgba(5,150,105,0.2)'
                }`,
              }}>
                {scanNotification.type === 'warning' ? '⚠️' : scanNotification.type === 'error' ? '✕' : '✓'}
                {scanNotification.message}
              </div>
            )}

            {/* Hint row */}
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span><kbd style={kbdStyle}>Enter</kbd> Add first result</span>
              <span><kbd style={kbdStyle}>F2</kbd> Focus search</span>
              <span><kbd style={kbdStyle}>F10</kbd> Complete sale</span>
              <span style={{ color: 'var(--text-hint)' }}>📷 Camera scan button →</span>
            </div>
          </div>

          {/* ── Drug Interaction Warning Banner ── */}
          {/* Show when: check returned interactions AND user hasn't dismissed it */}
          {interactionResult && !interactionDismissed &&
           (interactionResult.has_high || interactionResult.has_moderate) && (() => {
            const isHigh = interactionResult.has_high;
            // HIGH → red danger colours, MODERATE → amber warning colours
            const bg     = isHigh ? 'rgba(244,63,94,0.10)'  : 'rgba(245,158,11,0.10)';
            const border = isHigh ? 'rgba(225,29,72,0.30)'  : 'rgba(217,119,6,0.30)';
            const color  = isHigh ? 'var(--danger)'         : 'var(--warn)';
            const icon   = isHigh ? '🚨' : '⚠️';

            return (
              <div style={{
                marginTop: 12,
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: 'var(--radius-lg)',
                padding: '14px 16px',
                position: 'relative',
                // The banner sits in the PINNED part of the panel so a safety
                // warning can never be scrolled out of sight.  That makes its
                // height everyone else's problem, so it is capped: a bill with
                // several interactions would otherwise squeeze the items list
                // down to nothing.  Past the cap the banner scrolls itself.
                maxHeight: '32vh',
                overflowY: 'auto',
              }}>
                {/* Header row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {icon} Drug Interaction Warning
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '2px 7px',
                      borderRadius: 20, background: color, color: '#fff',
                      marginLeft: 4, letterSpacing: '0.05em',
                    }}>
                      {isHigh ? 'HIGH RISK' : 'MODERATE'}
                    </span>
                  </span>
                  {/* Dismiss button — banner reappears when next item is added */}
                  <button
                    onClick={() => setInteractionDismissed(true)}
                    title="Dismiss (reappears if more items are added)"
                    style={{
                      background: 'transparent', border: 'none', cursor: 'pointer',
                      color, fontSize: 18, lineHeight: 1, padding: '0 4px',
                    }}>
                    ×
                  </button>
                </div>

                {/* Interaction list */}
                {interactionResult.interactions.map((hit, i) => (
                  <div key={i} style={{
                    marginBottom: i < interactionResult.interactions.length - 1 ? 10 : 0,
                    paddingBottom: i < interactionResult.interactions.length - 1 ? 10 : 0,
                    borderBottom: i < interactionResult.interactions.length - 1
                      ? `1px solid ${border}` : 'none',
                  }}>
                    <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                      <strong>{hit.drug_a}</strong>
                      <span style={{ color: 'var(--text-hint)', margin: '0 6px' }}>+</span>
                      <strong>{hit.drug_b}</strong>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {hit.description}
                    </div>
                    {hit.recommendation && (
                      <div style={{ fontSize: 11, marginTop: 3, color, fontWeight: 500 }}>
                        Recommendation: {hit.recommendation}
                      </div>
                    )}
                  </div>
                ))}

                {/* Override acknowledgement checkbox */}
                <label style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  marginTop: 12, fontSize: 12, color: 'var(--text-secondary)',
                  cursor: 'pointer', userSelect: 'none',
                }}>
                  <input
                    type="checkbox"
                    checked={interactionAcknowledged}
                    onChange={e => setInteractionAcknowledged(e.target.checked)}
                    style={{ marginTop: 2, accentColor: color, flexShrink: 0 }}
                  />
                  <span>
                    <strong style={{ color: 'var(--text)' }}>Override by Owner / Pharmacist</strong>
                    {' '}— I have reviewed this interaction and take clinical responsibility for
                    dispensing these medicines together.
                  </span>
                </label>
              </div>
            );
          })()}
          </div>
          {/* ── end pinned search area ── */}

          {/* ── Bill items — scrolls, takes whatever height is left ──
              flex: 1 makes this pane absorb the remaining space, and
              overflowY: auto keeps its scrollbar inside the pane instead of
              growing the page.  billContainerRef is what the auto-scroll
              effect drives after each new item. */}
          <div
            ref={billContainerRef}
            style={{ flex: 1, overflowY: 'auto', marginTop: 12 }}
          >
          {bill.length > 0 && (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                    {['Medicine', 'Qty', 'MRP/unit', 'Total', ''].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bill.map(item => {
                    const { total } = lineCalc(item);
                    // Flash the row green for 1 second after it is scanned
                    const isJustScanned = item.line_key === lastScannedId;
                    return (
                      <tr key={item.line_key} style={{
                        borderBottom: '1px solid var(--border)',
                        background: isJustScanned ? 'rgba(16,185,129,0.10)' : 'transparent',
                        transition: 'background 0.3s ease',
                      }}>
                        <td style={{ padding: '8px 12px' }}>
                          <div style={{ fontWeight: 500 }}>{item.name}</div>
                          {/* Which physical box this line came from.  With two
                              batches of the same medicine on one bill, this is
                              the only thing telling the rows apart. */}
                          {item.batch_number && (
                            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>
                              Batch: {item.batch_number}
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            GST @ {item.gst_rate}% incl.
                            {/* For strip medicines, spell out what the quantity
                                actually means so "2" is never ambiguous. */}
                            {item.is_strip && (
                              <> · × {item.qty}{' '}
                                {item.sell_mode === 'strip'
                                  ? `strip${item.qty === 1 ? '' : 's'} (${item.qty * item.units_per_strip} tabs)`
                                  : `tablet${item.qty === 1 ? '' : 's'}`}
                              </>
                            )}
                          </div>

                          {/* Strip / unit selector (Feature 3) */}
                          {item.is_strip && (
                            <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                              {[['strip', 'Strip'], ['unit', 'Unit']].map(([mode, label]) => {
                                const active = item.sell_mode === mode;
                                return (
                                  <button
                                    key={mode} type="button"
                                    onClick={() => setSellMode(item.line_key, mode)}
                                    style={{
                                      padding: '2px 9px', borderRadius: 999, fontSize: 10.5, fontWeight: 600,
                                      cursor: 'pointer',
                                      border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
                                      background: active ? 'var(--accent-light)' : 'transparent',
                                      color: active ? 'var(--accent-dark)' : 'var(--text-muted)',
                                    }}
                                    title={
                                      mode === 'strip'
                                        ? `Sell whole strips at ${inr(item.strip_mrp)} each`
                                        : `Sell loose tablets at ${inr(item.unit_mrp)} each`
                                    }
                                  >
                                    {label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '8px 12px', width: 100 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <button
                              onClick={() => updateQty(item.line_key, item.qty - 1)}
                              style={{ ...qtyBtnStyle }}>−</button>
                            <input
                              type="number"
                              value={item.qty}
                              min={1}
                              onChange={e => updateQty(item.line_key, e.target.value)}
                              style={{ width: 48, textAlign: 'center', padding: '4px 6px', fontSize: 13 }}
                            />
                            <button
                              onClick={() => updateQty(item.line_key, item.qty + 1)}
                              style={{ ...qtyBtnStyle }}>+</button>
                          </div>
                        </td>
                        <td style={{ padding: '8px 12px' }}>{inr(item.unit_price)}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 600 }}>{inr(total)}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <button
                            onClick={() => removeFromBill(item.line_key)}
                            style={{ background: 'transparent', border: 'none', color: 'var(--danger)', fontSize: 18, padding: '2px 6px' }}
                            title="Remove">×</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          </div>
          {/* ── end bill items pane ── */}
        </div>

        {/* ===== RIGHT PANEL: Current Bill + Totals ===== */}
        <div style={{ flex: '0 0 calc(40% - 20px)', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Patient section */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.07em', color: 'var(--text-hint)', marginBottom: 8,
            }}>
              Patient (optional)
            </div>

            {selectedPatient ? (
              /* ── SELECTED STATE ── */
              <div>
                {/* Patient card */}
                <div style={{
                  background: 'var(--glass)', border: '1px solid var(--glass-border)',
                  borderRadius: 'var(--radius)', padding: '10px 12px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                      {selectedPatient.name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {selectedPatient.mobile}
                    </div>
                  </div>
                  <button
                    onClick={clearPatient}
                    style={{ background: 'none', border: 'none', color: 'var(--text-hint)', fontSize: 16, cursor: 'pointer', padding: '0 4px' }}>
                    ×
                  </button>
                </div>

                {/* ── Red DEFAULTER banner ──
                    Shown when the patient has at least one credit transaction
                    past its due date and still unpaid.  It is informational —
                    the pharmacist can still complete the sale. */}
                {patientCredit?.is_defaulter && (
                  <div style={{
                    marginTop: 10, padding: '10px 12px',
                    background: 'rgba(225,29,72,0.08)',
                    border: '1px solid rgba(225,29,72,0.30)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--danger)', fontSize: 12, lineHeight: 1.55,
                  }}>
                    <div style={{ fontWeight: 700, marginBottom: 2 }}>
                      ⚠ DEFAULTER — This patient has overdue payments
                    </div>
                    <div>Outstanding: <strong>{inr(patientCredit.outstanding_amount)}</strong></div>
                    {patientCredit.oldest_overdue_date && (
                      <div>Overdue since: {fmtDate(patientCredit.oldest_overdue_date)}</div>
                    )}
                  </div>
                )}

                {/* ── Amber EXISTING CREDIT banner ──
                    Shown for ANY patient who owes money, overdue or not.  When
                    both banners apply this one sits below the red one. */}
                {patientCredit?.has_outstanding && (
                  <div style={{
                    marginTop: 10, padding: '10px 12px',
                    background: 'rgba(245,158,11,0.12)',
                    border: '1px solid rgba(217,119,6,0.30)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--warn)', fontSize: 12, lineHeight: 1.55,
                  }}>
                    <div style={{ fontWeight: 700 }}>
                      💳 Existing Credit: {inr(patientCredit.outstanding_amount)} outstanding
                    </div>
                    {nextDueDate(patientCredit) && (
                      <div>Due: {fmtDate(nextDueDate(patientCredit))}</div>
                    )}
                  </div>
                )}

                {/* Prescription toggle */}
                <div style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500 }}>
                    Prescription?
                  </span>
                  {['No', 'Yes'].map(opt => (
                    <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                      <input
                        type="radio"
                        checked={isPrescription === (opt === 'Yes')}
                        onChange={() => {
                          setIsPrescription(opt === 'Yes');
                          if (opt === 'No') {
                            setReferredBy('');
                            setReferredByAutoFilled(false);
                            // Switching back to "No" drops any image already
                            // picked, so a hidden file can't be uploaded on save.
                            setPrescriptionFiles([]);
                          }
                        }}
                      />
                      {opt}
                    </label>
                  ))}
                </div>

                {/* THE REGISTER WARNING.
                    Shown the moment a regulated medicine lands on the bill,
                    not at the end — the customer is still at the counter now,
                    and these details can only be collected while they are. */}
                {needsRegister && (
                  <div style={{
                    marginTop: 8, padding: '10px 12px', borderRadius: 10,
                    background: 'rgba(245,158,11,0.10)',
                    border: '1px solid rgba(245,158,11,0.34)',
                    fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)',
                  }}>
                    <strong style={{ color: 'var(--warn)' }}>
                      This sale goes into the register.
                    </strong>{' '}
                    {bill.filter((i) => i.register_category).map((i) => i.name).join(', ')}
                    {' '}must be recorded, so the bill needs the patient's name,
                    phone and address, and the doctor's name and address.
                  </div>
                )}

                {/* Doctor name — shown when this is a prescription sale, AND
                    whenever the register needs it.  Without the second case a
                    regulated sale with "Prescription? No" would be refused by
                    the server with nowhere on screen to type the answer. */}
                {(isPrescription || needsRegister) && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      placeholder="Doctor name (referred by)"
                      value={referredBy}
                      onChange={e => { setReferredBy(e.target.value); setReferredByAutoFilled(false); }}
                      style={{ fontSize: 13, width: '100%' }}
                    />
                    {referredByAutoFilled && (
                      <div style={{ fontSize: 11, marginTop: 3, color: 'var(--ok)' }}>
                        ✓ Auto-filled from last OPD visit
                      </div>
                    )}
                    {/* The doctor's address.  Shown always (it belongs with
                        the name) but only REQUIRED when a regulated medicine
                        is on the bill — the server enforces that, and the
                        banner below says so before the pharmacist gets there. */}
                    <input
                      placeholder={needsRegister
                        ? "Doctor's address (required for the register)"
                        : "Doctor's address (optional)"}
                      value={referredByAddress}
                      onChange={(e) => setReferredByAddress(e.target.value)}
                      style={{
                        fontSize: 13, width: '100%', marginTop: 6,
                        borderColor: needsRegister && !referredByAddress.trim()
                          ? 'rgba(245,158,11,0.55)' : undefined,
                      }}
                    />
                  </div>
                )}

                {/* Prescription image upload widget — only when the
                    pharmacist answered "Yes" to the Prescription question.
                    On "No" (the default) nothing prescription-related shows. */}
                {isPrescription && (
                  <div style={{ marginTop: 10 }}>
                    <PrescriptionUpload
                      patientId={selectedPatient?.id || null}
                      onFilesSelected={setPrescriptionFiles}
                      disabled={!selectedPatient}
                    />
                  </div>
                )}
              </div>

            ) : (
              /* ── SEARCH STATE ──
                 One dropdown handles both cases.  Matching patients are listed
                 first (name in bold, phone underneath), and the last row is
                 ALWAYS "create new patient" so the pharmacist can register
                 someone even when similarly-named patients already exist. */
              <div style={{ position: 'relative' }}>
                <input
                  placeholder="Search name or mobile..."
                  value={patientSearch}
                  onChange={e => setPatientSearch(e.target.value)}
                  style={{ fontSize: 13, width: '100%' }}
                />

                {/* The dropdown appears from 2 characters on — that is the same
                    threshold the debounced search effect uses.

                    The list sits in the NORMAL document flow — deliberately not
                    position:absolute.  A floating dropdown covered the Bill
                    Summary card below it no matter how we stacked or tinted it.
                    In flow, the patient card simply grows and pushes Bill
                    Summary down, so the two can never overlap, and the card
                    returns to its usual place when the search clears. */}
                {patientSearch.trim().length >= 2 && (
                  <div style={{
                    background: 'rgba(255,255,255,0.98)',
                    border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)',
                    boxShadow: '0 4px 16px rgba(99,102,241,0.10)', marginTop: 6, overflow: 'hidden',
                  }}>
                    {/* Matching patients */}
                    {patientResults.map(p => (
                      <div
                        key={p.id}
                        onClick={() => handleSelectPatient(p)}
                        style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,0.04)', transition: 'background 0.15s' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.6)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
                          {p.name}
                        </div>
                        <div style={{ fontSize: 12, color: '#64748b' }}>
                          {p.mobile || 'No phone'}
                        </div>
                      </div>
                    ))}

                    {/* Empty state — names the exact text that was searched for
                        so the pharmacist can spot a typo straight away. */}
                    {patientResults.length === 0 && (
                      <div style={{
                        padding: '12px 12px 10px', fontSize: 13,
                        color: 'var(--text-secondary)',
                        borderBottom: '1px solid rgba(0,0,0,0.04)',
                      }}>
                        No patient found for "{patientSearch}"
                      </div>
                    )}

                    {/* Always-present create option.  Given a tinted background
                        and a top divider so it reads as a distinct action row
                        rather than blending into the result list above it. */}
                    <div
                      onClick={() => setShowAddForm(true)}
                      style={{
                        padding: '10px 14px', cursor: 'pointer',
                        borderTop: '1px solid rgba(99,102,241,0.15)',
                        background: 'var(--accent-light)',
                        display: 'flex', alignItems: 'center', gap: 8,
                        color: 'var(--accent)', fontWeight: 600, fontSize: 13,
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.20)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'var(--accent-light)'}
                    >
                      <span style={{ fontSize: 18, lineHeight: 1 }}>+</span>
                      Create new patient "{patientSearch}"
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Patient history panel — shown above the bill summary when a
              patient is selected.  Stacks vertically (does not push the bill
              summary sideways); its own visits list scrolls if it overflows. */}
          {historyPatient && (
            <PatientHistoryPanel
              patientId={historyPatient.id}
              patientName={historyPatient.name}
              onClose={() => setHistoryPatient(null)}
            />
          )}

          {/* ── Home visit / drip charge (Feature 4) ─────────────────────────
              Only shown when the bill contains a drip/injection.  The section
              fades in so the pharmacist notices it appear; the toggle stays OFF
              by default — administering at home is the pharmacist's call. */}
          {hasDripOrInjection && (
            <div className="card" style={{ padding: 16, animation: 'fadeIn 0.3s ease' }}>
              {/* Styled sliding toggle — no separate header; the toggle labels
                  itself. */}
              <div
                onClick={() => {
                  const next = !homeVisitOn;
                  setHomeVisitOn(next);
                  // Re-arm the shop default each time it is switched on, so a
                  // one-off override on the last bill does not leak into this one.
                  if (next) setHomeVisitAmount(homeVisitDefault.toFixed(2));
                  else setHomeVisitNotes('');
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  cursor: 'pointer',
                  padding: '12px 14px',
                  background: homeVisitOn
                    ? 'rgba(99,102,241,0.06)'
                    : 'rgba(0,0,0,0.02)',
                  borderRadius: '10px',
                  border: homeVisitOn
                    ? '1px solid rgba(99,102,241,0.25)'
                    : '1px solid rgba(0,0,0,0.06)',
                  transition: 'all 0.2s',
                  userSelect: 'none',
                }}
              >
                {/* Sliding toggle */}
                <div style={{
                  width: '40px',
                  height: '22px',
                  borderRadius: '11px',
                  background: homeVisitOn ? '#6366f1' : '#cbd5e1',
                  position: 'relative',
                  transition: 'background 0.2s',
                  flexShrink: 0,
                }}>
                  <div style={{
                    position: 'absolute',
                    top: '3px',
                    left: homeVisitOn ? '21px' : '3px',
                    width: '16px',
                    height: '16px',
                    borderRadius: '50%',
                    background: 'white',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    transition: 'left 0.2s',
                  }}/>
                </div>

                <div>
                  <div style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: homeVisitOn ? '#6366f1' : '#1e1b4b',
                  }}>
                    Add home visit charge
                  </div>
                  <div style={{
                    fontSize: '11px',
                    color: '#94a3b8',
                    marginTop: '1px',
                  }}>
                    Pharmacist visits patient at home
                  </div>
                </div>
              </div>

              {homeVisitOn && (
                <>
                  <div style={{ marginTop: '10px', display: 'flex', gap: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '11px', color: '#64748b' }}>
                        Charge (₹)
                      </label>
                      <input
                        type="number" min="0" step="0.01"
                        value={homeVisitAmount}
                        onChange={(e) => setHomeVisitAmount(e.target.value)}
                        style={{ width: '100%', padding: '8px', borderRadius: '8px',
                                 border: '1px solid #e2e8f0', fontSize: '14px',
                                 fontWeight: 600, marginTop: '4px' }}
                      />
                    </div>
                    <div style={{ flex: 2 }}>
                      <label style={{ fontSize: '11px', color: '#64748b' }}>
                        Notes (optional)
                      </label>
                      <input
                        type="text"
                        value={homeVisitNotes}
                        onChange={(e) => setHomeVisitNotes(e.target.value)}
                        placeholder="e.g. Drip at patient home"
                        style={{ width: '100%', padding: '8px', borderRadius: '8px',
                                 border: '1px solid #e2e8f0', fontSize: '13px',
                                 marginTop: '4px' }}
                      />
                    </div>
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 8, marginBottom: 0 }}>
                    Service charge — no GST is applied to this amount.
                  </p>
                </>
              )}
            </div>
          )}

          {/* Totals card */}
          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-muted)' }}>
              BILL SUMMARY
            </div>

            <TotalRow label="Subtotal (excl. GST)" value={inr(totals.subtotal)} />
            <TotalRow label="GST included" value={inr(totals.gstTotal)} />

            {/* Only shown when the charge is actually applied */}
            {homeVisitOn && parseFloat(totals.homeVisit) > 0 && (
              <TotalRow label="Home Visit Charge" value={`+ ${inr(totals.homeVisit)}`} />
            )}

            {/* Discount input — the ₹/% buttons decide how the typed number is
                read.  See the totals useMemo for the conversion. */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 }}>
              <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>Discount</span>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {/* Mode toggle */}
                <div style={{ display: 'flex', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                  {[['AMOUNT', '₹'], ['PERCENT', '%']].map(([mode, symbol]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDiscountMode(mode)}
                      style={{
                        border: 'none', cursor: 'pointer', padding: '6px 10px',
                        fontSize: 13, fontWeight: 700, lineHeight: 1,
                        background: discountMode === mode ? 'var(--accent)' : 'transparent',
                        color:      discountMode === mode ? '#fff' : 'var(--text-secondary)',
                        transition: 'background 0.15s',
                      }}
                    >
                      {symbol}
                    </button>
                  ))}
                </div>

                <input
                  type="number"
                  min={0}
                  max={discountMode === 'PERCENT' ? 100 : undefined}
                  value={discount}
                  onChange={e => setDiscount(e.target.value)}
                  placeholder="0"
                  style={{ width: 80, textAlign: 'right', fontSize: 14, padding: '6px 10px' }}
                />
              </div>
            </div>

            {/* When a percentage is in use, show what it actually comes to in
                rupees — the pharmacist should never have to do the maths. */}
            {discountMode === 'PERCENT' && parseFloat(discount) > 0 && (
              <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-hint)', marginTop: -4, marginBottom: 8 }}>
                = {inr(totals.discountAmount)} off
              </div>
            )}

            <div style={{ borderTop: '2px solid var(--border)', marginTop: 10, paddingTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 17, fontWeight: 700 }}>TOTAL</span>
                <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand)' }}>
                  {inr(totals.total)}
                </span>
              </div>
            </div>
          </div>

          {/* Payment method */}
          <div className="card" style={{ padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: 'var(--text-muted)' }}>
              PAYMENT METHOD
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {['CASH', 'UPI', 'CREDIT'].map(m => (
                <button
                  key={m}
                  onClick={() => {
                    setPaymentMethod(m);
                    // Pre-fill due date when switching to CREDIT
                    if (m === 'CREDIT' && !creditDueDate) {
                      setCreditDueDate(defaultCreditDueDate());
                    }
                  }}
                  style={{
                    flex: 1, padding: '10px 4px', fontSize: 14, fontWeight: 600,
                    background: paymentMethod === m
                      ? (m === 'CREDIT' ? '#e11d48' : 'var(--accent)')
                      : 'var(--glass)',
                    color: paymentMethod === m ? '#fff' : 'var(--text)',
                    border: `2px solid ${paymentMethod === m
                      ? (m === 'CREDIT' ? '#e11d48' : 'var(--accent)')
                      : 'var(--glass-border)'}`,
                    borderRadius: 'var(--radius)',
                    cursor: 'pointer',
                  }}>
                  {m === 'CREDIT' ? '💳 Credit' : m}
                </button>
              ))}
            </div>

            {/* Credit-specific fields — shown only when CREDIT is selected */}
            {paymentMethod === 'CREDIT' && (
              <div style={{
                marginTop: 14,
                background: 'rgba(225,29,72,0.05)',
                border: '1px solid rgba(225,29,72,0.20)',
                borderRadius: 'var(--radius)',
                padding: '14px 14px 10px',
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--danger)',
                  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                  Credit Details
                </div>

                {/* Total + paid today row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Total Bill</span>
                  <span style={{ fontWeight: 600 }}>{inr(totals.total)}</span>
                </div>

                {/* Amount paid today */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Paid Today (₹)</span>
                  <input
                    type="number"
                    min={0}
                    max={parseFloat(totals.total) - 0.01}
                    value={amountPaidToday}
                    onChange={e => setAmountPaidToday(e.target.value)}
                    placeholder="0"
                    style={{ width: 100, textAlign: 'right', fontSize: 13, padding: '6px 10px' }}
                  />
                </div>

                {/* Credit amount (read-only, auto-calculated) */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginBottom: 8, padding: '6px 0',
                  borderTop: '1px dashed rgba(225,29,72,0.2)',
                }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>Credit Amount</span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--danger)' }}>
                    {inr(creditAmount)}
                  </span>
                </div>

                {/* Due date */}
                <div style={{ marginBottom: 8 }}>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                    Due Date *
                  </label>
                  <input
                    type="date"
                    value={creditDueDate || defaultCreditDueDate()}
                    min={getTodayIST()}
                    onChange={e => setCreditDueDate(e.target.value)}
                    style={{ fontSize: 13, width: '100%' }}
                  />
                </div>

                {/* Optional notes */}
                <div>
                  <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                    Notes (optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Patient will pay on 15th"
                    value={creditNotes}
                    onChange={e => setCreditNotes(e.target.value)}
                    style={{ fontSize: 13, width: '100%' }}
                  />
                </div>

                {/* Warning if no patient selected */}
                {!selectedPatient && (
                  <div style={{
                    marginTop: 10, padding: '7px 10px', borderRadius: 'var(--radius)',
                    background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(217,119,6,0.25)',
                    fontSize: 12, color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    ⚠ Select a patient above to enable credit
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Upload warning — shown when bill saved but prescription upload failed */}
          {uploadWarning && (
            <div style={{
              background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(217,119,6,0.25)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
              color: 'var(--warn)', fontSize: 13, display: 'flex', gap: 8, alignItems: 'flex-start',
            }}>
              <span>⚠️</span>
              <span style={{ flex: 1 }}>{uploadWarning}</span>
              <button
                onClick={() => setUploadWarning('')}
                style={{ background: 'none', border: 'none', color: 'var(--warn)', fontSize: 16, cursor: 'pointer', padding: 0, lineHeight: 1 }}
              >×</button>
            </div>
          )}

          {/* Error message */}
          {error && (
            <div style={{
              background: 'var(--danger-bg)', border: '1px solid rgba(225,29,72,0.2)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
              color: 'var(--danger)', fontSize: 14,
            }}>
              {error}
            </div>
          )}

          {/* Complete Sale button */}
          <button
            onClick={completeSale}
            disabled={bill.length === 0 || completing}
            style={{
              width: '100%', padding: '16px', fontSize: 17, fontWeight: 700,
              background: bill.length === 0 ? 'var(--border)' : 'var(--ok)',
              color: bill.length === 0 ? 'var(--text-muted)' : '#fff',
              border: 'none', borderRadius: 'var(--radius)',
              cursor: bill.length === 0 ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
            }}>
            {completing ? 'Processing…' : '✓ Complete Sale  [F10]'}
          </button>
        </div>

      </div>

      {/* ===== NEW PATIENT REGISTRATION MODAL ===== */}
      {showAddForm && (
        <PatientRegisterModal
          initialName={patientSearch}
          tags={availableTags}
          departments={departments}
          onCreated={handlePatientCreated}
          onClose={() => setShowAddForm(false)}
        />
      )}

      {/* ===== TOAST ===== */}
      {toast && createPortal(
        <div style={{
          position: 'fixed', bottom: 28, right: 28, zIndex: 2000,
          background: 'var(--ok)', color: '#fff',
          padding: '12px 22px', borderRadius: 12, fontSize: 14, fontWeight: 600,
          boxShadow: '0 8px 24px rgba(5,150,105,0.35)',
          animation: 'fadeUp 0.3s ease',
        }}>
          ✓ {toast}
        </div>,
        document.body
      )}

      {/* ===== CAMERA BARCODE SCANNER MODAL ===== */}
      <CameraScanner
        isOpen={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onScan={(barcode) => {
          setCameraOpen(false);
          handleBarcodeScan(barcode);
        }}
      />

      {/* ===== THERMAL RECEIPT MODAL =====
        Rendered via a single createPortal into <body>, as THREE sibling
        elements (backdrop, receipt, action bar). Rendering the receipt as a
        direct child of <body> is what lets thermal-print.css print only it:
        during print, `body > * { display:none }` hides the backdrop, the app
        (#root) and the buttons, while `#thermal-receipt { display:block }`
        keeps the receipt. On screen, print.css positions all three nicely.
    ===== */}
      {receipt && createPortal(
        <>
          {/* Dark dimmer behind the preview — screen only (.print-actions
              means it is hidden when printing). */}
          <div className="thermal-modal-backdrop print-actions" />

          {/* The receipt itself — this is the only thing that prints. */}
          <ThermalReceipt receipt={receipt} />

          {/* Action bar — screen only, floats below the receipt card. */}
          <div className="thermal-modal-actions print-actions">
            <span className="success-flag">Sale Complete ✓</span>

            <button
              onClick={handlePrint}
              className="btn-primary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              🖨 Print
              {/* (?) hover tooltip with quick printer hints */}
              <span
                className="print-help"
                onClick={(e) => e.stopPropagation()}
              >
                ?
                <span className="print-help-tip">
                  Set paper size to 80mm in printer settings. For thermal
                  printers: select your printer, set paper width to 80mm,
                  disable headers/footers in browser print.
                </span>
              </span>
            </button>

            {/* Keep the A4 GST invoice available as a secondary option. */}
            <button
              onClick={() => printReceipt(receipt)}
              style={{
                padding: '10px 14px', fontSize: 13,
                background: 'rgba(255,255,255,0.6)', border: '1px solid var(--glass-border)',
                color: 'var(--text)', borderRadius: 'var(--radius)', cursor: 'pointer',
              }}
            >
              A4 PDF
            </button>

            <button onClick={newSale} className="btn-primary">
              + New Sale
            </button>

            <div style={{ width: '100%', textAlign: 'center', marginTop: 4 }}>
              <button
                onClick={() => setShowPrinterSetup(true)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--accent)', fontSize: 12, textDecoration: 'underline',
                }}
              >
                Printer Setup
              </button>
            </div>
          </div>
        </>,
        document.body
      )}

      {/* ===== PRINTER SETUP HELP MODAL ===== */}
      {showPrinterSetup && createPortal(
        <div
          className="print-actions"
          onClick={() => setShowPrinterSetup(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '90%', maxWidth: 460, maxHeight: '85vh', overflowY: 'auto',
              padding: 26,
              background: 'rgba(255,255,255,0.75)',
              backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
              border: '1px solid rgba(255,255,255,0.80)',
              borderRadius: 16, boxShadow: '0 20px 60px rgba(99,102,241,0.15)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 14 }}>
              Setting up your thermal printer
            </div>
            <ol style={{ paddingLeft: 20, margin: 0, color: 'var(--text)', fontSize: 14, lineHeight: 1.7 }}>
              <li>Connect your thermal printer via USB or to your WiFi network</li>
              <li>Install the printer driver from the manufacturer's website</li>
              <li>In Windows: Go to Settings → Printers → Add a printer</li>
              <li>When the browser print dialog opens, select your thermal printer</li>
              <li>Click "More settings" → Paper size → select "80mm" or custom 72mm width</li>
              <li>Disable "Headers and footers" in print settings</li>
              <li>Set Margins to "None"</li>
              <li>Click Print</li>
            </ol>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowPrinterSetup(false)} className="btn-primary">
                Got it
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// ─── Number → Indian English words (Rupees and Paise) ────────────────────────

function numberToWords(amount) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
    'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
    'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty',
    'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function numToWord(n) {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n / 10)] + ' ' + ones[n % 10] + ' ';
    if (n < 1000) return ones[Math.floor(n / 100)] + ' Hundred ' + numToWord(n % 100);
    if (n < 100000) return numToWord(Math.floor(n / 1000)) + 'Thousand ' + numToWord(n % 1000);
    if (n < 10000000) return numToWord(Math.floor(n / 100000)) + 'Lakh ' + numToWord(n % 100000);
    return numToWord(Math.floor(n / 10000000)) + 'Crore ' + numToWord(n % 10000000);
  }

  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  let result = numToWord(rupees).trim() + ' Rupees';
  if (paise > 0) result += ' and ' + numToWord(paise).trim() + ' Paise';
  return result;
}

// ─── Patient registration modal ───────────────────────────────────────────────

/**
 * Full patient registration form in a modal — the same fields as the Patients
 * page, so a pharmacist never has to leave the billing screen to register
 * someone mid-sale.
 *
 * Props:
 *   initialName — whatever was typed in the patient search box.  If it is all
 *                 digits we treat it as a mobile number instead of a name.
 *   tags, departments — reference lists loaded once by the Billing page
 *   onCreated(patient) — called with the created patient on success
 *   onClose() — dismiss without saving
 *
 * Rendered through createPortal so the fixed positioning is not clipped by any
 * scrolling/overflow container further up the tree.
 */
function PatientRegisterModal({ initialName, tags, departments, onCreated, onClose }) {
  const looksLikePhone = /^\d+$/.test(initialName.trim());

  const [form, setForm] = useState({
    name:           looksLikePhone ? '' : initialName.trim(),
    mobile:         looksLikePhone ? initialName.trim() : '',
    age:            '',
    // Backend accepts exactly 'M', 'F' or 'Other' — not 'O'.
    gender:         'M',
    patient_type:   'SELF_MEDICATION',
    address:        '',
    tag_ids:        [],
    department_ids: [],
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState('');

  // Toggle an id in/out of one of the two multi-select arrays
  function toggleId(field, id) {
    setForm(f => ({
      ...f,
      [field]: f[field].includes(id)
        ? f[field].filter(x => x !== id)
        : [...f[field], id],
    }));
  }

  async function handleSave() {
    if (!form.name.trim() || !form.mobile.trim()) {
      setErr('Name and phone number are required.');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const res = await api.post('/patients/', {
        name:           form.name.trim(),
        mobile:         form.mobile.trim(),
        age:            form.age ? parseInt(form.age, 10) : null,
        gender:         form.gender,
        patient_type:   form.patient_type,
        address:        form.address || null,
        tag_ids:        form.tag_ids,
        department_ids: form.department_ids,
      });
      onCreated(res.data);
    } catch (e) {
      setErr(e.response?.data?.detail || 'Could not create patient. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const canSave = form.name.trim() && form.mobile.trim() && !saving;

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '92%', maxWidth: 480, maxHeight: '88vh', overflowY: 'auto',
          background: 'rgba(255,255,255,0.78)',
          backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
          border: '1px solid rgba(255,255,255,0.85)',
          borderRadius: 18, padding: 26,
          boxShadow: '0 20px 60px rgba(99,102,241,0.15)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>
            Register New Patient
          </div>
          <button onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--text-hint)', cursor: 'pointer', padding: '0 4px' }}>
            ×
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            placeholder="Full Name *"
            value={form.name}
            autoFocus
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            style={{ fontSize: 13, width: '100%' }}
          />
          <input
            placeholder="Phone Number *"
            value={form.mobile}
            onChange={e => setForm(f => ({ ...f, mobile: e.target.value }))}
            style={{ fontSize: 13, width: '100%' }}
          />

          {/* Age + gender on one row */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              placeholder="Age"
              type="number"
              value={form.age}
              onChange={e => setForm(f => ({ ...f, age: e.target.value }))}
              style={{ fontSize: 13, width: '35%' }}
            />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 1 }}>
              {[['M', 'Male'], ['F', 'Female'], ['Other', 'Other']].map(([val, label]) => (
                <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                  <input
                    type="radio"
                    checked={form.gender === val}
                    onChange={() => setForm(f => ({ ...f, gender: val }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* Patient type */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {[['PRESCRIPTION', 'Prescription'], ['SELF_MEDICATION', 'Self Medication']].map(([val, label]) => (
              /* whiteSpace: nowrap keeps "Self Medication" on one line — as a
                 flex item the label would otherwise shrink and wrap the text. */
              <label key={val} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                <input
                  type="radio"
                  checked={form.patient_type === val}
                  onChange={() => setForm(f => ({ ...f, patient_type: val }))}
                />
                {label}
              </label>
            ))}
          </div>

          <textarea
            placeholder="Address (optional)"
            value={form.address}
            onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
            rows={2}
            style={{ fontSize: 13, resize: 'none', width: '100%' }}
          />

          {/* Tags — pill toggles */}
          {tags.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Tags</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {tags.map(tag => {
                  const on = form.tag_ids.includes(tag.id);
                  return (
                    <div key={tag.id} onClick={() => toggleId('tag_ids', tag.id)}
                      style={{
                        padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 500,
                        cursor: 'pointer', transition: 'all 0.15s',
                        background: on ? 'var(--accent)' : 'var(--accent-light)',
                        color: on ? '#fff' : 'var(--accent)',
                        border: `1px solid ${on ? 'var(--accent)' : 'rgba(99,102,241,0.25)'}`,
                      }}>
                      {tag.name}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Departments — same pill pattern as tags */}
          {departments.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6 }}>Departments</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                {departments.map(d => {
                  const on = form.department_ids.includes(d.id);
                  return (
                    <div key={d.id} onClick={() => toggleId('department_ids', d.id)}
                      style={{
                        padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 500,
                        cursor: 'pointer', transition: 'all 0.15s',
                        background: on ? 'var(--ok)' : 'rgba(16,185,129,0.12)',
                        color: on ? '#fff' : 'var(--ok)',
                        border: `1px solid ${on ? 'var(--ok)' : 'rgba(5,150,105,0.25)'}`,
                      }}>
                      {d.name}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {err && (
            <div style={{
              background: 'var(--danger-bg)', border: '1px solid rgba(225,29,72,0.2)',
              borderRadius: 8, padding: '8px 12px', color: 'var(--danger)', fontSize: 13,
            }}>
              {err}
            </div>
          )}

          {/* Buttons */}
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button onClick={onClose}
              style={{
                flex: 1, padding: '10px', background: 'transparent',
                border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)',
                color: 'var(--text-secondary)', fontSize: 14, cursor: 'pointer',
              }}>
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              style={{
                flex: 2, padding: '10px', background: 'var(--accent)', border: 'none',
                borderRadius: 'var(--radius)', color: '#fff', fontSize: 14, fontWeight: 700,
                cursor: canSave ? 'pointer' : 'not-allowed',
                opacity: canSave ? 1 : 0.55,
              }}>
              {saving ? 'Saving…' : 'Save & Select'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Small shared sub-components ─────────────────────────────────────────────

function TotalRow({ label, value }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      marginBottom: 8, fontSize: 14,
    }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ReceiptRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

// ─── Style constants ──────────────────────────────────────────────────────────

const kbdStyle = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '1px 5px',
  fontSize: 11,
  fontFamily: 'monospace',
};

const qtyBtnStyle = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 15,
  cursor: 'pointer',
  lineHeight: 1,
  color: 'var(--text)',
};