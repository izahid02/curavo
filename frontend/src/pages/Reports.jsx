/**
 * Reports page — four analytics tabs with PDF and Excel export.
 *
 * Tabs: Sales Report | Inventory Report | Profit Report | Patient Report
 *
 * Workflow:
 *   1. Select a date range (or use a preset button).
 *   2. Click "Generate Report" — all four reports are fetched in parallel.
 *   3. Switch tabs freely; the date range and data are retained.
 *   4. Click "Export PDF" or "Export Excel" to download the active tab's data.
 */
import { useState } from 'react';
import { api } from '../lib/api';
import { usePharmacy } from '../lib/pharmacy';
import { LicenceLockedPanel, useLicence } from '../lib/licence.jsx';

// ---------------------------------------------------------------------------
// Indian currency formatter — ₹1,24,500
// ---------------------------------------------------------------------------
function formatINR(amount) {
  if (amount === null || amount === undefined) return '—';
  return '₹' + Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function formatPct(v) {
  return Number(v ?? 0).toFixed(1) + '%';
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------
function toIso(d) {
  // Convert a JS Date to YYYY-MM-DD string
  return d.toISOString().slice(0, 10);
}

function getPresetDates(preset) {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const d = today.getDate();

  switch (preset) {
    case 'today':
      return { from: toIso(today), to: toIso(today) };
    case 'week': {
      const mon = new Date(y, m, d - ((today.getDay() + 6) % 7)); // Monday
      return { from: toIso(mon), to: toIso(today) };
    }
    case 'month':
      return { from: `${y}-${String(m + 1).padStart(2, '0')}-01`, to: toIso(today) };
    case 'year':
      return { from: `${y}-01-01`, to: toIso(today) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------
// shopName comes from Pharmacy Settings (passed in by the page) so a report
// prints the shop that ran it, never a name baked into the code.
async function generatePDF(reportType, data, dateFrom, dateTo, shopName) {
  // Dynamic import so the large jsPDF bundle is only loaded when needed
  const jsPDF = (await import('jspdf')).default;
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const today = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const TITLE_MAP = {
    sales: 'Sales Report',
    inventory: 'Inventory Report',
    profit: 'Profit Report',
    patients: 'Patient Report',
  };

  // ── Header ──────────────────────────────────────────────────────────
  doc.setFillColor(99, 102, 241);
  doc.rect(0, 0, pageW, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(shopName || 'Pharmacy', 14, 10);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Curavo', 14, 16);

  const titleText = TITLE_MAP[reportType] || 'Report';
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text(titleText, pageW - 14, 10, { align: 'right' });
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  if (reportType !== 'inventory') {
    doc.text(`Period: ${dateFrom} to ${dateTo}`, pageW - 14, 16, { align: 'right' });
  } else {
    doc.text(`Snapshot: ${today}`, pageW - 14, 16, { align: 'right' });
  }

  doc.setTextColor(30, 27, 75);
  let y = 30;

  // ── Summary section ──────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Summary', 14, y);
  y += 6;

  const summaryRows = buildPDFSummary(reportType, data);
  autoTable(doc, {
    startY: y,
    head: [['Metric', 'Value']],
    body: summaryRows,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [99, 102, 241] },
    columnStyles: { 0: { cellWidth: 80 }, 1: { cellWidth: 60 } },
    margin: { left: 14, right: 14 },
  });
  y = doc.lastAutoTable.finalY + 10;

  // ── Main data table ──────────────────────────────────────────────────
  const { head, body } = buildPDFTable(reportType, data);
  if (head && body) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Details', 14, y);
    y += 6;
    autoTable(doc, {
      startY: y,
      head: [head],
      body,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [99, 102, 241] },
      margin: { left: 14, right: 14 },
    });
  }

  // ── Footer ───────────────────────────────────────────────────────────
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(
      `Generated on ${today} by Curavo   |   Page ${i} of ${pageCount}`,
      pageW / 2, doc.internal.pageSize.getHeight() - 8,
      { align: 'center' }
    );
  }

  const fileName = `${TITLE_MAP[reportType].replace(' ', '-')}-${dateFrom}.pdf`;
  doc.save(fileName);
}

function buildPDFSummary(reportType, data) {
  if (reportType === 'sales') {
    const s = data.sales.summary;
    return [
      ['Total Revenue', formatINR(s.total_revenue)],
      ['Total Cost', formatINR(s.total_cost)],
      ['Gross Profit', formatINR(s.gross_profit)],
      ['Profit Margin', formatPct(s.profit_margin_pct)],
      ['Total Invoices', s.total_invoices],
      ['Items Sold', s.total_items_sold],
      ['Cash Sales', formatINR(s.cash_sales)],
      ['UPI Sales', formatINR(s.upi_sales)],
      ['Credit Sales', formatINR(s.credit_sales)],
    ];
  }
  if (reportType === 'inventory') {
    const s = data.inventory.summary;
    return [
      ['Total Products', s.total_products],
      ['Total Batches (active)', s.total_batches],
      ['Inventory Value', formatINR(s.inventory_value)],
      ['Retail Value', formatINR(s.retail_value)],
      ['Potential Profit', formatINR(s.potential_profit)],
      ['Low Stock Products', s.low_stock_count],
      ['Expiry Alerts (90d)', s.expiry_alerts_count],
    ];
  }
  if (reportType === 'profit') {
    const s = data.profit.summary;
    return [
      ['Revenue', formatINR(s.revenue)],
      ['Cost', formatINR(s.cost)],
      ['Gross Profit', formatINR(s.gross_profit)],
      ['Profit Margin', formatPct(s.profit_margin_pct)],
      ['Net Profit', formatINR(s.net_profit)],
    ];
  }
  if (reportType === 'patients') {
    const s = data.patients.summary;
    return [
      ['Total Patients', s.total_patients],
      ['New This Period', s.new_patients],
      ['Prescription', s.prescription_patients],
      ['Self Medication', s.self_medication_patients],
      ['Active Buyers (period)', s.patients_with_purchases],
    ];
  }
  return [];
}

function buildPDFTable(reportType, data) {
  if (reportType === 'sales') {
    const rows = data.sales.top_products.map((r, i) => [
      i + 1, r.product_name, r.units_sold, formatINR(r.revenue), formatINR(r.profit),
    ]);
    return { head: ['#', 'Product', 'Units', 'Revenue', 'Profit'], body: rows };
  }
  if (reportType === 'inventory') {
    const rows = data.inventory.top_value_products.map((r, i) => [
      i + 1, r.product_name, r.qty, formatINR(r.purchase_price), formatINR(r.total_value),
    ]);
    return { head: ['#', 'Product', 'Qty', 'Purchase Price', 'Total Value'], body: rows };
  }
  if (reportType === 'profit') {
    const rows = data.profit.product_profitability.map((r, i) => [
      i + 1, r.product_name, r.units_sold, formatINR(r.revenue), formatINR(r.cost),
      formatINR(r.profit), formatPct(r.margin_pct),
    ]);
    return { head: ['#', 'Product', 'Units', 'Revenue', 'Cost', 'Profit', 'Margin'], body: rows };
  }
  if (reportType === 'patients') {
    const rows = data.patients.top_patients.map((r, i) => [
      i + 1, r.patient_name, r.mobile || '—', formatINR(r.total_spent), r.visit_count,
    ]);
    return { head: ['#', 'Patient', 'Mobile', 'Total Spent', 'Visits'], body: rows };
  }
  return { head: null, body: null };
}

// ---------------------------------------------------------------------------
// Excel export
// ---------------------------------------------------------------------------
async function generateExcel(reportType, data, dateFrom, dateTo) {
  const XLSX = await import('xlsx');

  const TITLE_MAP = {
    sales: 'Sales-Report',
    inventory: 'Inventory-Report',
    profit: 'Profit-Report',
    patients: 'Patient-Report',
  };

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Summary ────────────────────────────────────────────────
  const summaryRows = buildPDFSummary(reportType, data);   // reuse same helper
  const summaryData = [['Metric', 'Value'], ...summaryRows];
  const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

  // ── Sheet 2: Details ─────────────────────────────────────────────────
  const { head, body } = buildPDFTable(reportType, data);
  if (head && body) {
    const detailData = [head, ...body];
    const ws2 = XLSX.utils.aoa_to_sheet(detailData);
    XLSX.utils.book_append_sheet(wb, ws2, 'Details');
  }

  // ── Sheet 3: Extra tables (daily breakdown for sales, trend for profit, etc.)
  buildExcelExtra(reportType, data, wb, XLSX);

  const fileName = `${TITLE_MAP[reportType]}-${dateFrom}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

function buildExcelExtra(reportType, data, wb, XLSX) {
  if (reportType === 'sales' && data.sales.daily_breakdown?.length) {
    const rows = data.sales.daily_breakdown.map(r => [r.date, r.revenue, r.invoices_count, r.profit]);
    const ws = XLSX.utils.aoa_to_sheet([['Date', 'Revenue', 'Invoices', 'Profit'], ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Daily Breakdown');
  }
  if (reportType === 'profit' && data.profit.monthly_trend?.length) {
    const rows = data.profit.monthly_trend.map(r => [r.month, r.revenue, r.cost, r.profit, r.margin_pct]);
    const ws = XLSX.utils.aoa_to_sheet([['Month', 'Revenue', 'Cost', 'Profit', 'Margin%'], ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Monthly Trend');
  }
  if (reportType === 'patients' && data.patients.registration_trend?.length) {
    const rows = data.patients.registration_trend.map(r => [r.date, r.new_patients]);
    const ws = XLSX.utils.aoa_to_sheet([['Date', 'New Patients'], ...rows]);
    XLSX.utils.book_append_sheet(wb, ws, 'Registration Trend');
  }
}

// ---------------------------------------------------------------------------
// Reusable table component
// ---------------------------------------------------------------------------
function ReportTable({ columns, rows, emptyMsg = 'No data' }) {
  if (!rows || rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-hint)', padding: '24px 0' }}>
        {emptyMsg}
      </div>
    );
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} style={{
                fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.05em', color: 'var(--text-hint)',
                padding: '8px 10px', textAlign: col.align || 'left',
                borderBottom: '1px solid rgba(0,0,0,0.08)',
                whiteSpace: 'nowrap',
              }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
              {columns.map(col => (
                <td key={col.key} style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  color: col.color ? col.color(row) : 'var(--text)',
                  fontWeight: col.bold ? 500 : 400,
                  textAlign: col.align || 'left',
                }}>
                  {col.render ? col.render(row, i) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------
function StatCard({ label, value, topColor, sub, valueColor }) {
  return (
    <div style={{
      background: 'var(--glass)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      border: '1px solid var(--glass-border)',
      borderRadius: 'var(--radius-lg)',
      borderTop: `3px solid ${topColor || 'var(--accent)'}`,
      padding: '16px 18px',
      animation: 'fadeUp 0.4s ease both',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--text-hint)', marginBottom: 6 }}>
        {label}
      </div>
      {/* valueColor lets a loss-making figure show in red — see the profit
          cards, where a heavily discounted period can go negative. */}
      <div style={{ fontSize: 22, fontWeight: 700, color: valueColor || 'var(--text)', lineHeight: 1.2 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section heading
// ---------------------------------------------------------------------------
function SectionHeading({ title }) {
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)',
      marginBottom: 10, marginTop: 6 }}>
      {title}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glass panel wrapper
// ---------------------------------------------------------------------------
function Panel({ children, style }) {
  return (
    <div style={{
      background: 'var(--glass)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      border: '1px solid var(--glass-border)',
      borderRadius: 'var(--radius-lg)',
      padding: '18px 20px',
      ...style,
    }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TAB 1 — Sales Report
// ---------------------------------------------------------------------------
function SalesTab({ data }) {
  const s = data.summary;
  const daily = [...(data.daily_breakdown || [])].reverse().slice(0, 14).reverse();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <StatCard label="Total Revenue" value={formatINR(s.total_revenue)} topColor="#6366f1" />
        {/* Profit is post-discount and can be negative — show a loss in red. */}
        <StatCard label="Gross Profit"  value={formatINR(s.gross_profit)}
          topColor={s.gross_profit >= 0 ? '#059669' : 'var(--danger)'}
          valueColor={s.gross_profit >= 0 ? undefined : 'var(--danger)'} />
        <StatCard label="Profit Margin" value={formatPct(s.profit_margin_pct)}
          topColor={s.profit_margin_pct >= 0 ? '#0284c7' : 'var(--danger)'}
          valueColor={s.profit_margin_pct >= 0 ? undefined : 'var(--danger)'} />
        <StatCard label="Total Invoices" value={s.total_invoices} topColor="#0d9488" />
      </div>

      {/* Payment breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        <StatCard label="Cash Sales"   value={formatINR(s.cash_sales)}   topColor="#059669" />
        <StatCard label="UPI Sales"    value={formatINR(s.upi_sales)}    topColor="#0284c7" />
        <StatCard label="Credit Sales" value={formatINR(s.credit_sales)} topColor="#6366f1" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Daily Revenue */}
        <Panel>
          <SectionHeading title="Daily Revenue (last 14 days)" />
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <ReportTable
              columns={[
                { key: 'date',           label: 'Date' },
                { key: 'revenue',        label: 'Revenue',  align: 'right', render: r => formatINR(r.revenue) },
                { key: 'invoices_count', label: 'Invoices', align: 'right' },
                { key: 'profit',         label: 'Profit',   align: 'right',
                  render: r => (
                    <span style={{ color: r.profit >= 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
                      {formatINR(r.profit)}
                    </span>
                  ),
                },
              ]}
              rows={daily}
              emptyMsg="No sales in this period"
            />
          </div>
        </Panel>

        {/* Top Products */}
        <Panel>
          <SectionHeading title="Top Products by Revenue" />
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <ReportTable
              columns={[
                { key: '_num',      label: '#',        render: (_, i) => i + 1 },
                { key: 'product_name', label: 'Product' },
                { key: 'units_sold',   label: 'Units', align: 'right' },
                { key: 'revenue',      label: 'Revenue', align: 'right', render: r => formatINR(r.revenue) },
                { key: 'profit',       label: 'Profit',  align: 'right',
                  render: r => (
                    <span style={{ color: r.profit >= 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
                      {formatINR(r.profit)}
                    </span>
                  ),
                },
              ]}
              rows={(data.top_products || []).map((r, i) => ({ ...r, _num: i + 1 }))}
              emptyMsg="No sales in this period"
            />
          </div>
        </Panel>
      </div>

      {/* Top Departments */}
      {data.top_departments?.length > 0 && (
        <Panel>
          <SectionHeading title="Top Departments by Revenue" />
          <ReportTable
            columns={[
              { key: 'department_name', label: 'Department' },
              { key: 'revenue', label: 'Revenue', align: 'right', render: r => formatINR(r.revenue) },
              { key: 'invoices_count', label: 'Invoices', align: 'right' },
            ]}
            rows={data.top_departments}
          />
        </Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TAB 2 — Inventory Report
// ---------------------------------------------------------------------------
function InventoryTab({ data }) {
  const s = data.summary;
  const exp = data.expiry_summary;

  const expiryRows = [
    { label: 'Expired',          bucket: exp.expired,   color: 'var(--danger)' },
    { label: 'Within 7 days',    bucket: exp.within_7,  color: 'var(--danger)' },
    { label: 'Within 30 days',   bucket: exp.within_30, color: 'var(--warn)' },
    { label: 'Within 60 days',   bucket: exp.within_60, color: 'var(--warn)' },
    { label: 'Within 90 days',   bucket: exp.within_90, color: '#6366f1' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Value cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        <StatCard label="Inventory Value"  value={formatINR(s.inventory_value)}  topColor="#6366f1" />
        <StatCard label="Retail Value"     value={formatINR(s.retail_value)}     topColor="#0284c7" />
        <StatCard label="Potential Profit" value={formatINR(s.potential_profit)} topColor="#059669" />
      </div>

      {/* Alert cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
        <StatCard label="Low Stock Products"   value={s.low_stock_count}      topColor="var(--warn)" />
        <StatCard label="Expiry Alerts (90d)"  value={s.expiry_alerts_count}  topColor="var(--danger)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Expiry Summary */}
        <Panel>
          <SectionHeading title="Expiry Summary" />
          {/* This column is the FULL cost value of the stock (qty × purchase
              price) — a different figure from the GST-only "GST Loss" on the
              Expiry Alerts page. Labelled clearly so the two aren't confused. */}
          <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 8 }}>
            Full cost value of expired stock
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Status', 'Batches', 'Inventory Value Lost'].map(h => (
                  <th key={h} style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: 'var(--text-hint)', padding: '8px 10px',
                    textAlign: h === 'Status' ? 'left' : 'right',
                    borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {expiryRows.map(({ label, bucket, color }) => (
                <tr key={label} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <td style={{ padding: '8px 10px' }}>
                    <span style={{ color, fontWeight: 500, fontSize: 13 }}>{label}</span>
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: 13 }}>
                    {bucket.count}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right', fontSize: 13,
                    color: bucket.estimated_loss > 0 ? color : 'var(--text-hint)' }}>
                    {bucket.estimated_loss > 0 ? formatINR(bucket.estimated_loss) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Low Stock */}
        <Panel>
          <SectionHeading title="Low Stock Products" />
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <ReportTable
              columns={[
                { key: 'product_name',   label: 'Product' },
                { key: 'current_stock',  label: 'Stock',  align: 'right',
                  color: () => 'var(--danger)', bold: true },
                { key: 'min_stock_level', label: 'Min',   align: 'right' },
                { key: 'department',      label: 'Dept' },
              ]}
              rows={data.low_stock_products || []}
              emptyMsg="All products well stocked"
            />
          </div>
        </Panel>
      </div>

      {/* Top value products */}
      <Panel>
        <SectionHeading title="Top Products by Inventory Value" />
        <ReportTable
          columns={[
            { key: '_num',          label: '#', render: r => r._num },
            { key: 'product_name',  label: 'Product' },
            { key: 'qty',           label: 'Qty',            align: 'right' },
            { key: 'purchase_price', label: 'Purchase Price', align: 'right',
              render: r => formatINR(r.purchase_price) },
            { key: 'total_value',   label: 'Total Value',    align: 'right',
              render: r => formatINR(r.total_value), bold: true },
          ]}
          rows={(data.top_value_products || []).map((r, i) => ({ ...r, _num: i + 1 }))}
          emptyMsg="No active inventory"
        />
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TAB 3 — Profit Report
// ---------------------------------------------------------------------------
function ProfitTab({ data }) {
  const s = data.summary;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Prominent notice: some lines had no purchase price, so profit excludes
          them. Shown at the TOP (not buried in a panel) so the owner knows the
          profit figures below are understated and how to fix it. */}
      {s.excluded_items > 0 && (
        <div style={{
          fontSize: 13, color: 'var(--warn)', background: 'var(--warn-bg)',
          border: '1px solid rgba(217,119,6,0.3)', borderRadius: 'var(--radius)',
          padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'flex-start',
        }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>⚠</span>
          <span>
            <strong>{s.excluded_items} line item{s.excluded_items === 1 ? '' : 's'}</strong> excluded
            from profit calculation (no purchase price recorded).
            Add purchase prices in Medicines → Add Stock to include them.
          </span>
        </div>
      )}

      {/* Summary cards.
          A period can genuinely LOSE money — heavy discounts mean stock left
          the shelf for less than it cost.  When that happens the card turns
          red rather than showing a loss in the usual "healthy" green, so it
          cannot be misread at a glance. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        <StatCard label="Gross Profit"  value={formatINR(s.gross_profit)}
          topColor={s.gross_profit >= 0 ? '#059669' : 'var(--danger)'}
          valueColor={s.gross_profit >= 0 ? undefined : 'var(--danger)'} />
        <StatCard label="Profit Margin" value={formatPct(s.profit_margin_pct)}
          topColor={s.profit_margin_pct >= 0 ? '#0284c7' : 'var(--danger)'}
          valueColor={s.profit_margin_pct >= 0 ? undefined : 'var(--danger)'} />
        <StatCard label="Net Profit"    value={formatINR(s.net_profit)}
          topColor={s.net_profit >= 0 ? '#6366f1' : 'var(--danger)'}
          valueColor={s.net_profit >= 0 ? undefined : 'var(--danger)'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Monthly trend */}
        <Panel>
          <SectionHeading title="Monthly Trend (last 6 months)" />
          <ReportTable
            columns={[
              { key: 'month',      label: 'Month' },
              { key: 'revenue',    label: 'Revenue', align: 'right', render: r => formatINR(r.revenue) },
              { key: 'cost',       label: 'Cost',    align: 'right', render: r => formatINR(r.cost) },
              { key: 'profit',     label: 'Profit',  align: 'right',
                render: r => (
                  <span style={{ color: r.profit >= 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
                    {formatINR(r.profit)}
                  </span>
                ),
              },
              { key: 'margin_pct', label: 'Margin', align: 'right',
                render: r => (
                  <span style={{ color: r.margin_pct >= 0 ? 'var(--text)' : 'var(--danger)', fontWeight: 600 }}>
                    {formatPct(r.margin_pct)}
                  </span>
                ),
              },
            ]}
            rows={data.monthly_trend || []}
            emptyMsg="No monthly data yet"
          />
        </Panel>

        {/* Top profitable products */}
        <Panel>
          <SectionHeading title="Top Products by Profit" />
          {/* Items sold without a recorded purchase price can't show real profit,
              so they're left out of this table. Tell the user how many. */}
          {s.excluded_items > 0 && (
            <div style={{
              fontSize: 12, color: 'var(--warn)', background: 'var(--warn-bg)',
              border: '1px solid rgba(217,119,6,0.25)', borderRadius: 'var(--radius)',
              padding: '7px 10px', marginBottom: 10,
            }}>
              {s.excluded_items} item{s.excluded_items === 1 ? '' : 's'} excluded (no purchase price)
            </div>
          )}
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <ReportTable
              columns={[
                { key: '_num',        label: '#', render: r => r._num },
                { key: 'product_name', label: 'Product' },
                { key: 'units_sold',   label: 'Units', align: 'right' },
                { key: 'revenue',      label: 'Revenue', align: 'right', render: r => formatINR(r.revenue) },
                { key: 'cost',         label: 'Cost',    align: 'right', render: r => formatINR(r.cost) },
                { key: 'profit',       label: 'Profit',  align: 'right',
                  render: r => (
                    <span style={{ color: r.profit >= 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
                      {formatINR(r.profit)}
                    </span>
                  ),
                },
                { key: 'margin_pct',   label: 'Margin', align: 'right',
                  render: r => (
                    <span style={{ color: r.margin_pct >= 0 ? 'var(--text)' : 'var(--danger)', fontWeight: 600 }}>
                      {formatPct(r.margin_pct)}
                    </span>
                  ),
                },
              ]}
              rows={(data.product_profitability || []).map((r, i) => ({ ...r, _num: i + 1 }))}
              emptyMsg="No sales in this period"
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TAB 4 — Patient Report
// ---------------------------------------------------------------------------
function PatientsTab({ data }) {
  const s = data.summary;

  // Build bar widths for department breakdown (relative to max)
  const maxCount = Math.max(...(data.department_breakdown || []).map(r => r.patient_count), 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <StatCard label="Total Patients"   value={s.total_patients}           topColor="#6366f1" />
        <StatCard label="New This Period"  value={s.new_patients}             topColor="#059669" />
        <StatCard label="Prescription"     value={s.prescription_patients}    topColor="#0284c7" />
        <StatCard label="Self Medication"  value={s.self_medication_patients} topColor="#0d9488" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Department breakdown with visual bar */}
        <Panel>
          <SectionHeading title="Department Breakdown" />
          {(data.department_breakdown || []).length === 0 ? (
            <div style={{ color: 'var(--text-hint)', textAlign: 'center', padding: '20px 0' }}>
              No department assignments
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {data.department_breakdown.map(row => (
                <div key={row.department_name}>
                  <div style={{ display: 'flex', justifyContent: 'space-between',
                    fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: 'var(--text)' }}>{row.department_name}</span>
                    <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>
                      {row.patient_count}
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(99,102,241,0.1)', borderRadius: 4 }}>
                    <div style={{
                      height: '100%', borderRadius: 4,
                      background: 'var(--accent)',
                      width: `${Math.round((row.patient_count / maxCount) * 100)}%`,
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* Top patients */}
        <Panel>
          <SectionHeading title="Top Patients by Purchase Value" />
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <ReportTable
              columns={[
                { key: '_num',         label: '#', render: r => r._num },
                { key: 'patient_name', label: 'Name' },
                { key: 'mobile',       label: 'Mobile', render: r => r.mobile || '—' },
                { key: 'total_spent',  label: 'Total Spent', align: 'right',
                  render: r => formatINR(r.total_spent), bold: true },
                { key: 'visit_count',  label: 'Visits', align: 'right' },
              ]}
              rows={(data.top_patients || []).map((r, i) => ({ ...r, _num: i + 1 }))}
              emptyMsg="No purchases in this period"
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Placeholder shown before first Generate
// ---------------------------------------------------------------------------
function EmptyState() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', padding: '60px 0', gap: 12,
    }}>
      <svg width="48" height="48" fill="none" stroke="var(--text-hint)" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round">
        <line x1="36" y1="40" x2="36" y2="20" />
        <line x1="24" y1="40" x2="24" y2="8" />
        <line x1="12" y1="40" x2="12" y2="28" />
      </svg>
      <div style={{ fontSize: 14, color: 'var(--text-secondary)', textAlign: 'center' }}>
        Select a date range and click <strong>Generate Report</strong> to see analytics.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Reports component
// ---------------------------------------------------------------------------
const TABS = [
  { id: 'sales',     label: 'Sales Report' },
  { id: 'inventory', label: 'Inventory Report' },
  { id: 'profit',    label: 'Profit Report' },
  { id: 'patients',  label: 'Patient Report' },
];

export default function Reports() {
  const { pharmacy } = usePharmacy();
  // Dates — shared across all tabs
  const today = new Date();
  const firstOfMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const todayStr = toIso(today);

  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);
  const [activeTab, setActiveTab] = useState('sales');
  const [allData, setAllData] = useState(null);   // holds all 4 reports after generation
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { restricted: licenceRestricted, refresh: refreshLicence } = useLicence();

  function applyPreset(preset) {
    const dates = getPresetDates(preset);
    if (dates) {
      setDateFrom(dates.from);
      setDateTo(dates.to);
    }
  }

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    try {
      const params = `?date_from=${dateFrom}&date_to=${dateTo}`;
      const [salesRes, inventoryRes, profitRes, patientsRes] = await Promise.all([
        api.get(`/reports/sales${params}`),
        api.get('/reports/inventory'),            // no date filter — current state
        api.get(`/reports/profit${params}`),
        api.get(`/reports/patients${params}`),
      ]);
      setAllData({
        sales:     salesRes.data,
        inventory: inventoryRes.data,
        profit:    profitRes.data,
        patients:  patientsRes.data,
      });
    } catch (err) {
      console.error('Report generation failed:', err);
      // 402 = the subscription lapsed while this page was open.  Refreshing
      // the shared status swaps the page for the "paused" panel below.
      if (err?.response?.status === 402) { refreshLicence(); return; }
      setError(err?.response?.data?.detail || 'Failed to generate reports. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function handleExportPDF() {
    if (!allData) return;
    generatePDF(activeTab, allData, dateFrom, dateTo, pharmacy.pharmacy_name).catch(console.error);
  }

  function handleExportExcel() {
    if (!allData) return;
    generateExcel(activeTab, allData, dateFrom, dateTo).catch(console.error);
  }

  // Reports and their PDF/Excel exports pause when the Curavo subscription
  // has lapsed (the server enforces it too - this just says so nicely).
  if (licenceRestricted) {
    return <LicenceLockedPanel what="Reports" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

      {/* ── Controls panel ─────────────────────────────────────────── */}
      <div style={{
        background: 'var(--glass)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '16px 20px',
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        {/* Date inputs + presets */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              From
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              style={{
                padding: '7px 10px', fontSize: 13,
                background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(0,0,0,0.12)',
                borderRadius: 8, color: 'var(--text)',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              To
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              style={{
                padding: '7px 10px', fontSize: 13,
                background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(0,0,0,0.12)',
                borderRadius: 8, color: 'var(--text)',
              }}
            />
          </div>

          {/* Preset buttons */}
          {['today', 'week', 'month', 'year'].map(p => (
            <button
              key={p}
              onClick={() => applyPreset(p)}
              style={{
                padding: '7px 14px', fontSize: 12, cursor: 'pointer',
                background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(0,0,0,0.10)',
                borderRadius: 8, color: 'var(--text-secondary)', fontFamily: 'var(--font-body)',
              }}
            >
              {p === 'today' ? 'Today' : p === 'week' ? 'This Week' :
               p === 'month' ? 'This Month' : 'This Year'}
            </button>
          ))}

          <button
            onClick={handleGenerate}
            disabled={loading}
            className="btn-primary"
            style={{ marginLeft: 'auto', minWidth: 140 }}
          >
            {loading ? 'Generating…' : 'Generate Report'}
          </button>
        </div>

        {/* Export row — only shown after data is loaded */}
        {allData && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>Export active tab:</span>
            <button onClick={handleExportPDF}
              className="btn-secondary"
              style={{ fontSize: 12, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              Export PDF
            </button>
            <button onClick={handleExportExcel}
              className="btn-secondary"
              style={{ fontSize: 12, padding: '6px 14px', display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <path d="M8 7v10M12 7v10M16 7v10M3 11h18"/>
              </svg>
              Export Excel
            </button>
          </div>
        )}
      </div>

      {/* ── Error banner ─────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: 'var(--danger-bg)', border: '1px solid rgba(225,29,72,0.2)',
          borderRadius: 'var(--radius)', padding: '10px 14px',
          color: 'var(--danger)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* ── Tab bar ─────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', gap: 4,
        background: 'rgba(255,255,255,0.4)',
        backdropFilter: 'blur(12px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 4,
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: '9px 0', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-body)',
              borderRadius: 10, transition: 'all 0.2s',
              background: activeTab === tab.id ? 'rgba(255,255,255,0.85)' : 'transparent',
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
              boxShadow: activeTab === tab.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Report content ──────────────────────────────────────────── */}
      {!allData && !loading && <EmptyState />}
      {loading && (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)',
          padding: '60px 0', fontSize: 14 }}>
          Generating report…
        </div>
      )}

      {allData && activeTab === 'sales'     && <SalesTab     data={allData.sales}     />}
      {allData && activeTab === 'inventory' && <InventoryTab data={allData.inventory} />}
      {allData && activeTab === 'profit'    && <ProfitTab    data={allData.profit}    />}
      {allData && activeTab === 'patients'  && <PatientsTab  data={allData.patients}  />}
    </div>
  );
}
