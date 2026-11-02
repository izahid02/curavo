/**
 * Expenditure & Payroll page.
 *
 * Four tabs:
 *   1. Expenses      — log & review every rupee going out, by month
 *   2. Employees     — staff on the payroll + their salary components
 *   3. Payroll       — per-employee net-payable cards, settle a month's salary
 *   4. Cash Register — daily cash + bank drawer (opening / sales / expenses / actual)
 *
 * Follows the house glassmorphism style: glass cards, CSS-variable colours,
 * createPortal modals, Indian currency formatting.  ALL data goes through
 * src/lib/api.js.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { usePharmacy } from '../lib/pharmacy';
import { getTodayIST } from '../lib/datetime';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function formatINR(amount) {
  if (amount === null || amount === undefined || amount === '') return '—';
  return '₹' + Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

/** Full month name from a 1-12 number. */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Category → badge style. Colours per the spec. */
const CATEGORY_STYLE = {
  SALARY:      { bg: 'rgba(99,102,241,0.12)',  color: '#4f46e5' },  // indigo
  ADVANCE:     { bg: 'rgba(245,158,11,0.14)',  color: '#b45309' },  // amber
  SHOP:        { bg: 'rgba(14,165,233,0.12)',  color: '#0284c7' },  // blue
  PERSONAL:    { bg: 'rgba(168,85,247,0.12)',  color: '#7e22ce' },  // purple
  UTILITY:     { bg: 'rgba(249,115,22,0.14)',  color: '#c2410c' },  // orange
  MAINTENANCE: { bg: 'rgba(107,114,128,0.14)', color: '#4b5563' },  // gray
  OTHER:       { bg: 'rgba(100,116,139,0.14)', color: '#475569' },  // slate
};

const EXPENSE_CATEGORIES = [
  'SALARY', 'ADVANCE', 'SHOP', 'PERSONAL', 'UTILITY', 'MAINTENANCE', 'OTHER',
];

function CategoryBadge({ category }) {
  const s = CATEGORY_STYLE[category] || CATEGORY_STYLE.OTHER;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
      fontSize: 11, fontWeight: 700, letterSpacing: '0.03em',
      background: s.bg, color: s.color,
    }}>
      {category}
    </span>
  );
}

function todayISO() {
  // IST calendar date "YYYY-MM-DD". Must NOT use toISOString() (that is UTC and
  // rolls to yesterday for late-evening IST) — the Cash Register defaults to
  // today, and "today" means today in India. See lib/datetime.js.
  return getTodayIST();
}

// Reusable glass card wrapper style
const glassCard = {
  background: 'rgba(255,255,255,0.52)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  border: '1px solid rgba(255,255,255,0.75)',
  borderRadius: 14,
  boxShadow: '0 4px 20px rgba(99,102,241,0.06)',
};

// Shared modal chrome (portal-rendered so it's never clipped)
function ModalShell({ title, onClose, children, width = 480 }) {
  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(30,27,75,0.35)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto',
        background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(24px)',
        border: '1px solid rgba(255,255,255,0.75)', borderRadius: 18,
        padding: 28, boxShadow: '0 20px 60px rgba(99,102,241,0.18)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1e1b4b', margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: 'var(--text-hint)', lineHeight: 1,
          }}>×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// Reusable labelled form field
function Field({ label, value, onChange, placeholder, required, type = 'text', children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}{required && <span style={{ color: '#e11d48', marginLeft: 2 }}>*</span>}
      </label>
      {children ? children : type === 'textarea' ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={2} style={{ resize: 'vertical' }} />
      ) : (
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} required={required} />
      )}
    </div>
  );
}

// Cash/UPI segmented toggle
function ModeToggle({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {['CASH', 'UPI'].map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          style={{
            flex: 1, padding: '9px 0', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: value === m ? '1px solid #6366f1' : '1px solid rgba(0,0,0,0.1)',
            background: value === m ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.6)',
            color: value === m ? '#4f46e5' : '#6b7280',
          }}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

const errBanner = {
  background: 'rgba(244,63,94,0.08)', border: '1px solid rgba(244,63,94,0.2)',
  color: '#e11d48', borderRadius: 8, padding: '10px 14px', fontSize: 13,
};

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN PAGE — tab shell
// ═══════════════════════════════════════════════════════════════════════════

const TABS = [
  { key: 'expenses',  label: 'Expenses' },
  { key: 'employees', label: 'Employees' },
  { key: 'payroll',   label: 'Payroll' },
  { key: 'cash',      label: 'Cash Register' },
];

export default function Expenditure() {
  const [tab, setTab] = useState('expenses');

  return (
    <div>
      {/* Heading */}
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#1e1b4b', marginBottom: 2 }}>Expenditure &amp; Payroll</h1>
        <p style={{ fontSize: 14, color: 'var(--text-hint)' }}>Track spending, staff salaries, advances and the daily cash drawer</p>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '9px 18px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer',
              border: tab === t.key ? '1px solid #6366f1' : '1px solid rgba(255,255,255,0.75)',
              background: tab === t.key ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.5)',
              color: tab === t.key ? '#4f46e5' : '#6b7280',
              backdropFilter: 'blur(20px)',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'expenses'  && <ExpensesTab />}
      {tab === 'employees' && <EmployeesTab />}
      {tab === 'payroll'   && <PayrollTab />}
      {tab === 'cash'      && <CashRegisterTab />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  TAB 1 — EXPENSES
// ═══════════════════════════════════════════════════════════════════════════

function ExpensesTab() {
  const now = new Date();
  const [month, setMonth]     = useState(now.getMonth() + 1);
  const [year, setYear]       = useState(now.getFullYear());
  const [summary, setSummary] = useState(null);
  const [lastMonthTotal, setLastMonthTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Filters (client-side over the loaded list)
  const [catFilter, setCatFilter]   = useState('');
  const [modeFilter, setModeFilter] = useState('');
  const [searchText, setSearchText] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [employees, setEmployees] = useState([]);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/expenditure/expenses', { params: { month, year } });
      setSummary(data);
      // Previous month total for the "vs last" card
      const prevMonth = month === 1 ? 12 : month - 1;
      const prevYear  = month === 1 ? year - 1 : year;
      const prev = await api.get('/expenditure/expenses', { params: { month: prevMonth, year: prevYear } });
      setLastMonthTotal(Number(prev.data.total_expenses));
    } catch {
      setError('Could not load expenses. Is the server running?');
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => {
    api.get('/expenditure/employees').then(({ data }) => setEmployees(data)).catch(() => {});
  }, []);

  const rows = (summary?.expenses || []).filter((e) => {
    if (catFilter && e.category !== catFilter) return false;
    if (modeFilter && e.payment_mode !== modeFilter) return false;
    if (searchText && !(e.description || '').toLowerCase().includes(searchText.toLowerCase())) return false;
    return true;
  });

  const total   = Number(summary?.total_expenses || 0);
  const vsLast  = lastMonthTotal === null ? null : total - lastMonthTotal;

  return (
    <div>
      {/* Month/year selector + add button */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <MonthYearSelector month={month} year={year} onMonth={setMonth} onYear={setYear} />
        <button className="btn-primary" onClick={() => setShowAdd(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Expense
        </button>
      </div>

      {error && <div style={{ ...errBanner, marginBottom: 16 }}>{error}</div>}

      {/* Summary cards */}
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', marginBottom: 20 }}>
        <StatCard label="Total Out" value={formatINR(total)} sub={`${MONTH_NAMES[month - 1]} ${year}`} color="#6366f1" />
        <StatCard label="Cash Out" value={formatINR(summary?.cash_out)} sub="Paid in cash" color="#059669" />
        <StatCard label="UPI Out" value={formatINR(summary?.upi_out)} sub="Paid via UPI" color="#0284c7" />
        <StatCard
          label="This Month vs Last"
          value={vsLast === null ? '—' : (vsLast >= 0 ? '+' : '−') + formatINR(Math.abs(vsLast)).slice(1)}
          sub={vsLast === null ? '' : vsLast >= 0 ? 'more than last month' : 'less than last month'}
          color={vsLast > 0 ? '#e11d48' : '#059669'}
        />
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} style={{ minWidth: 160 }}>
          <option value="">All Categories</option>
          {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} style={{ minWidth: 120 }}>
          <option value="">Cash / UPI</option>
          <option value="CASH">CASH</option>
          <option value="UPI">UPI</option>
        </select>
        <input placeholder="Search description…" value={searchText} onChange={(e) => setSearchText(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
      </div>

      {/* Table */}
      <div style={{ ...glassCard, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '90px 110px 1.6fr 1fr 100px 70px 1fr 70px',
          padding: '12px 18px', borderBottom: '1px solid rgba(0,0,0,0.06)',
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-hint)',
        }}>
          <span>Date</span><span>Category</span><span>Description</span><span>Paid To</span>
          <span style={{ textAlign: 'right' }}>Amount</span><span>Mode</span><span>Added By</span>
          <span style={{ textAlign: 'right' }}>Action</span>
        </div>

        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} style={{ padding: '14px 18px', borderBottom: '1px solid rgba(0,0,0,0.04)', animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ height: 14, width: '50%', background: '#e5e7eb', borderRadius: 4 }} />
            </div>
          ))
        ) : rows.length === 0 ? (
          <div style={{ padding: '32px 18px', textAlign: 'center', color: 'var(--text-hint)', fontSize: 14 }}>
            No expenses match this view.
          </div>
        ) : rows.map((e) => (
          <ExpenseRow key={e.id} expense={e} onDeleted={fetchSummary} />
        ))}
      </div>

      {showAdd && (
        <AddExpenseModal
          employees={employees}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); fetchSummary(); }}
        />
      )}
    </div>
  );
}

function ExpenseRow({ expense: e, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  async function handleDelete() {
    if (!window.confirm('Delete this expense? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api.delete(`/expenditure/expenses/${e.id}`);
      onDeleted();
    } catch (err) {
      alert(err.response?.data?.detail || 'Could not delete. Owner/Admin only.');
      setDeleting(false);
    }
  }
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '90px 110px 1.6fr 1fr 100px 70px 1fr 70px',
        padding: '12px 18px', borderBottom: '1px solid rgba(0,0,0,0.04)', alignItems: 'center',
      }}
      onMouseEnter={(ev) => ev.currentTarget.style.background = 'rgba(99,102,241,0.03)'}
      onMouseLeave={(ev) => ev.currentTarget.style.background = ''}
    >
      <span style={{ fontSize: 12, color: '#6b7280' }}>{e.date?.slice(5)}</span>
      <span><CategoryBadge category={e.category} /></span>
      <span style={{ fontSize: 13, color: '#1e1b4b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.description}</span>
      <span style={{ fontSize: 13, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {e.paid_to || e.employee_name || <span style={{ color: '#d1d5db' }}>—</span>}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#1e1b4b', textAlign: 'right' }}>{formatINR(e.amount)}</span>
      <span style={{ fontSize: 11, fontWeight: 600, color: e.payment_mode === 'CASH' ? '#059669' : '#0284c7' }}>{e.payment_mode}</span>
      <span style={{ fontSize: 12, color: 'var(--text-hint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {e.added_by_name || <span style={{ color: '#d1d5db' }}>—</span>}
      </span>
      <span style={{ textAlign: 'right' }}>
        <button onClick={handleDelete} disabled={deleting} style={{
          background: 'rgba(244,63,94,0.07)', border: '1px solid rgba(244,63,94,0.2)', color: '#e11d48',
          borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
        }}>
          {deleting ? '…' : 'Delete'}
        </button>
      </span>
    </div>
  );
}

function AddExpenseModal({ employees, onClose, onSaved }) {
  const [form, setForm] = useState({
    date: todayISO(), category: 'SHOP', description: '', amount: '',
    payment_mode: 'CASH', paid_to: '', employee_id: '', reference: '', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const set = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));
  const needsEmployee = form.category === 'ADVANCE' || form.category === 'SALARY';

  async function handleSubmit(ev) {
    ev.preventDefault();
    setError('');
    if (!form.description.trim()) { setError('Description is required.'); return; }
    if (!form.amount || Number(form.amount) <= 0) { setError('Enter a valid amount.'); return; }
    if (needsEmployee && !form.employee_id) { setError(`An employee is required for ${form.category} expenses.`); return; }

    setSaving(true);
    try {
      await api.post('/expenditure/expenses', {
        date: form.date,
        category: form.category,
        description: form.description.trim(),
        amount: Number(form.amount),
        payment_mode: form.payment_mode,
        paid_to: form.paid_to.trim() || null,
        employee_id: form.employee_id ? Number(form.employee_id) : null,
        reference: form.reference.trim() || null,
        notes: form.notes.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not save expense.');
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Add Expense" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Date" required><input type="date" value={form.date} onChange={(e) => set('date')(e.target.value)} /></Field>
          <Field label="Category" required>
            <select value={form.category} onChange={(e) => set('category')(e.target.value)}>
              {EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description" value={form.description} onChange={set('description')} placeholder="e.g. Electricity bill" required />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Amount (₹)" value={form.amount} onChange={set('amount')} placeholder="0" type="number" required />
          <Field label="Payment Mode" required><ModeToggle value={form.payment_mode} onChange={set('payment_mode')} /></Field>
        </div>
        <Field label="Paid To" value={form.paid_to} onChange={set('paid_to')} placeholder="Person / vendor name" />

        {needsEmployee && (
          <Field label="Employee" required>
            <select value={form.employee_id} onChange={(e) => set('employee_id')(e.target.value)}>
              <option value="">Select employee…</option>
              {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name} — {emp.role}</option>)}
            </select>
          </Field>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Reference No." value={form.reference} onChange={set('reference')} placeholder="UPI txn / receipt" />
          <Field label="Notes" value={form.notes} onChange={set('notes')} placeholder="Optional" />
        </div>

        {error && <div style={errBanner}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving} style={{ minWidth: 120 }}>{saving ? 'Saving…' : 'Save Expense'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  TAB 2 — EMPLOYEES
// ═══════════════════════════════════════════════════════════════════════════

function EmployeesTab() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [modal, setModal]         = useState(null); // 'add' | { edit }

  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/expenditure/employees');
      setEmployees(data);
    } catch {
      setError('Could not load employees.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchEmployees(); }, [fetchEmployees]);

  async function handleDeactivate(emp) {
    if (!window.confirm(`Deactivate ${emp.name}? They will be hidden from payroll.`)) return;
    try {
      await api.delete(`/expenditure/employees/${emp.id}`);
      fetchEmployees();
    } catch {
      alert('Could not deactivate employee.');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <p style={{ fontSize: 14, color: 'var(--text-hint)' }}>{loading ? 'Loading…' : `${employees.length} active employee${employees.length !== 1 ? 's' : ''}`}</p>
        <button className="btn-primary" onClick={() => setModal('add')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Employee
        </button>
      </div>

      {error && <div style={{ ...errBanner, marginBottom: 16 }}>{error}</div>}

      <div style={{ ...glassCard, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 90px 90px 90px 90px 100px 100px 130px',
          padding: '12px 18px', borderBottom: '1px solid rgba(0,0,0,0.06)',
          fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-hint)',
        }}>
          <span>Name</span><span>Role</span>
          <span style={{ textAlign: 'right' }}>Basic</span><span style={{ textAlign: 'right' }}>HRA</span>
          <span style={{ textAlign: 'right' }}>Travel</span><span style={{ textAlign: 'right' }}>Other</span>
          <span style={{ textAlign: 'right' }}>Total</span><span>Since</span>
          <span style={{ textAlign: 'right' }}>Actions</span>
        </div>

        {loading ? (
          Array.from({ length: 2 }).map((_, i) => (
            <div key={i} style={{ padding: '14px 18px', borderBottom: '1px solid rgba(0,0,0,0.04)', animation: 'pulse 1.5s ease-in-out infinite' }}>
              <div style={{ height: 14, width: '40%', background: '#e5e7eb', borderRadius: 4 }} />
            </div>
          ))
        ) : employees.length === 0 ? (
          <div style={{ padding: '32px 18px', textAlign: 'center', color: 'var(--text-hint)', fontSize: 14 }}>No employees yet. Add your first one above.</div>
        ) : employees.map((emp) => (
          <div key={emp.id} style={{
            display: 'grid', gridTemplateColumns: '1.6fr 1.2fr 90px 90px 90px 90px 100px 100px 130px',
            padding: '12px 18px', borderBottom: '1px solid rgba(0,0,0,0.04)', alignItems: 'center',
          }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#1e1b4b' }}>{emp.name}</span>
            <span style={{ fontSize: 13, color: '#6b7280' }}>{emp.role}</span>
            <span style={{ fontSize: 13, color: '#6b7280', textAlign: 'right' }}>{formatINR(emp.basic_salary)}</span>
            <span style={{ fontSize: 13, color: '#6b7280', textAlign: 'right' }}>{formatINR(emp.hra)}</span>
            <span style={{ fontSize: 13, color: '#6b7280', textAlign: 'right' }}>{formatINR(emp.travel_allowance)}</span>
            <span style={{ fontSize: 13, color: '#6b7280', textAlign: 'right' }}>{formatINR(emp.other_allowance)}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#4f46e5', textAlign: 'right' }}>{formatINR(emp.total_salary)}</span>
            <span style={{ fontSize: 12, color: 'var(--text-hint)' }}>{emp.joining_date || '—'}</span>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => setModal({ edit: emp })} style={{
                background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', color: '#6366f1',
                borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}>Edit</button>
              <button onClick={() => handleDeactivate(emp)} style={{
                background: 'rgba(244,63,94,0.07)', border: '1px solid rgba(244,63,94,0.2)', color: '#e11d48',
                borderRadius: 7, padding: '4px 9px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              }}>Deactivate</button>
            </div>
          </div>
        ))}
      </div>

      {modal === 'add' && <EmployeeModal onClose={() => setModal(null)} onSaved={() => { setModal(null); fetchEmployees(); }} />}
      {modal?.edit && <EmployeeModal employee={modal.edit} onClose={() => setModal(null)} onSaved={() => { setModal(null); fetchEmployees(); }} />}
    </div>
  );
}

function EmployeeModal({ employee, onClose, onSaved }) {
  const isEdit = Boolean(employee);
  const [form, setForm] = useState({
    name:             employee?.name             ?? '',
    role:             employee?.role             ?? '',
    phone:            employee?.phone            ?? '',
    joining_date:     employee?.joining_date     ?? '',
    basic_salary:     employee?.basic_salary     ?? '',
    hra:              employee?.hra              ?? '',
    travel_allowance: employee?.travel_allowance ?? '',
    other_allowance:  employee?.other_allowance  ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');
  const set = (k) => (v) => setForm((p) => ({ ...p, [k]: v }));

  const total = ['basic_salary', 'hra', 'travel_allowance', 'other_allowance']
    .reduce((sum, k) => sum + (Number(form[k]) || 0), 0);

  async function handleSubmit(ev) {
    ev.preventDefault();
    setError('');
    if (!form.name.trim()) { setError('Full name is required.'); return; }
    if (!form.role.trim()) { setError('Role is required.'); return; }
    if (!form.basic_salary || Number(form.basic_salary) <= 0) { setError('Basic salary is required.'); return; }

    const payload = {
      name: form.name.trim(),
      role: form.role.trim(),
      phone: form.phone.trim() || null,
      joining_date: form.joining_date || null,
      basic_salary: Number(form.basic_salary),
      hra: Number(form.hra) || 0,
      travel_allowance: Number(form.travel_allowance) || 0,
      other_allowance: Number(form.other_allowance) || 0,
    };
    setSaving(true);
    try {
      if (isEdit) await api.put(`/expenditure/employees/${employee.id}`, payload);
      else        await api.post('/expenditure/employees', payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not save employee.');
      setSaving(false);
    }
  }

  return (
    <ModalShell title={isEdit ? 'Edit Employee' : 'Add Employee'} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Full Name" value={form.name} onChange={set('name')} placeholder="e.g. Inzamamul Hoque" required />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Role" value={form.role} onChange={set('role')} placeholder="e.g. Pharmacist" required />
          <Field label="Phone" value={form.phone} onChange={set('phone')} placeholder="Optional" type="tel" />
        </div>
        <Field label="Joining Date"><input type="date" value={form.joining_date} onChange={(e) => set('joining_date')(e.target.value)} /></Field>

        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 }}>Salary Details</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Basic Salary" value={form.basic_salary} onChange={set('basic_salary')} placeholder="0" type="number" required />
          <Field label="HRA (₹)" value={form.hra} onChange={set('hra')} placeholder="0" type="number" />
          <Field label="Travel Allow." value={form.travel_allowance} onChange={set('travel_allowance')} placeholder="0" type="number" />
          <Field label="Other Allow." value={form.other_allowance} onChange={set('other_allowance')} placeholder="0" type="number" />
        </div>

        <div style={{
          padding: '10px 14px', borderRadius: 10, background: 'rgba(99,102,241,0.08)',
          fontSize: 14, fontWeight: 700, color: '#4f46e5', textAlign: 'center',
        }}>
          Total: {formatINR(total)}
        </div>

        {error && <div style={errBanner}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving} style={{ minWidth: 120 }}>{saving ? 'Saving…' : 'Save Employee'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  TAB 3 — PAYROLL
// ═══════════════════════════════════════════════════════════════════════════

function PayrollTab() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear]   = useState(now.getFullYear());
  const [rows, setRows]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settleFor, setSettleFor] = useState(null); // salary summary row
  const [slipFor, setSlipFor]     = useState(null);

  const fetchPayroll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/expenditure/salary/${month}/${year}`);
      setRows(data);
    } catch {
      setError('Could not load payroll.');
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => { fetchPayroll(); }, [fetchPayroll]);

  return (
    <div>
      <div style={{ marginBottom: 18 }}>
        <MonthYearSelector month={month} year={year} onMonth={setMonth} onYear={setYear} />
      </div>

      {error && <div style={{ ...errBanner, marginBottom: 16 }}>{error}</div>}

      {loading ? (
        <div style={{ ...glassCard, padding: 40, textAlign: 'center', color: 'var(--text-hint)' }}>Loading payroll…</div>
      ) : rows.length === 0 ? (
        <div style={{ ...glassCard, padding: 40, textAlign: 'center', color: 'var(--text-hint)' }}>No active employees. Add employees first.</div>
      ) : (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
          {rows.map((r) => (
            <PayrollCard
              key={r.employee.id}
              row={r}
              month={month}
              year={year}
              onSettle={() => setSettleFor(r)}
              onSlip={() => setSlipFor(r)}
            />
          ))}
        </div>
      )}

      {settleFor && (
        <SettleSalaryModal
          row={settleFor}
          month={month}
          year={year}
          onClose={() => setSettleFor(null)}
          onSaved={() => { setSettleFor(null); fetchPayroll(); }}
        />
      )}
      {slipFor && (
        <SalarySlipModal row={slipFor} month={month} year={year} onClose={() => setSlipFor(null)} />
      )}
    </div>
  );
}

function PayrollCard({ row, onSettle, onSlip }) {
  const e = row.employee;
  const isPaid = row.status === 'PAID' || row.status === 'PARTIAL';
  const statusStyle = {
    PENDING: { bg: 'rgba(245,158,11,0.14)', color: '#b45309' },
    PAID:    { bg: 'rgba(16,185,129,0.14)', color: '#059669' },
    PARTIAL: { bg: 'rgba(14,165,233,0.14)', color: '#0284c7' },
  }[row.status] || { bg: 'rgba(107,114,128,0.14)', color: '#4b5563' };

  return (
    <div style={{ ...glassCard, padding: 20 }} className="fade-up">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1e1b4b' }}>{e.name}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{e.role}</div>
        </div>
        <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: statusStyle.bg, color: statusStyle.color }}>
          {row.status}
        </span>
      </div>

      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
        Basic: {formatINR(e.basic_salary)} + HRA: {formatINR(e.hra)} + Travel: {formatINR(e.travel_allowance)}
        {Number(e.other_allowance) > 0 && ` + Other: ${formatINR(e.other_allowance)}`}
        {' = '}<strong style={{ color: '#1e1b4b' }}>Gross: {formatINR(row.gross_salary)}</strong>
      </div>

      <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
          Advances taken this month: <strong style={{ color: '#b45309' }}>{formatINR(row.advances_taken)}</strong>
        </div>
        {row.advances.map((a, idx) => (
          <div key={idx} style={{ fontSize: 11, color: 'var(--text-hint)', paddingLeft: 12 }}>
            {idx === row.advances.length - 1 ? '└──' : '├──'} {a.date?.slice(5)}: {formatINR(a.amount)} ({a.description})
          </div>
        ))}
      </div>

      <div style={{
        padding: '10px 14px', borderRadius: 10, background: 'rgba(99,102,241,0.08)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>NET PAYABLE</span>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#4f46e5' }}>{formatINR(row.net_payable)}</span>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        {isPaid ? (
          <button className="btn-secondary" onClick={onSlip} style={{ flex: 1 }}>Generate Salary Slip</button>
        ) : (
          <button className="btn-primary" onClick={onSettle} style={{ flex: 1 }}>Settle Salary →</button>
        )}
      </div>
      {isPaid && row.amount_paid != null && (
        <div style={{ fontSize: 11, color: '#059669', marginTop: 8, textAlign: 'center' }}>
          Paid {formatINR(row.amount_paid)}
        </div>
      )}
    </div>
  );
}

function SettleSalaryModal({ row, month, year, onClose, onSaved }) {
  const [amount, setAmount] = useState(String(row.net_payable));
  const [mode, setMode]     = useState('CASH');
  const [notes, setNotes]   = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  async function handleSubmit(ev) {
    ev.preventDefault();
    setError('');
    if (!amount || Number(amount) <= 0) { setError('Enter a valid amount.'); return; }
    setSaving(true);
    try {
      await api.post('/expenditure/salary/settle', {
        employee_id: row.employee.id,
        month, year,
        amount_paid: Number(amount),
        payment_mode: mode,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not settle salary.');
      setSaving(false);
    }
  }

  const summaryRow = (label, value, bold) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 14 }}>
      <span style={{ color: '#6b7280' }}>{label}</span>
      <span style={{ fontWeight: bold ? 700 : 500, color: bold ? '#4f46e5' : '#1e1b4b' }}>{value}</span>
    </div>
  );

  return (
    <ModalShell title={`Settle Salary — ${MONTH_NAMES[month - 1]} ${year}`} onClose={onClose} width={420}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ padding: '4px 0', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
          {summaryRow('Gross Salary', formatINR(row.gross_salary))}
          {summaryRow('Advances Taken', '− ' + formatINR(row.advances_taken).slice(1))}
          {summaryRow('Net Payable', formatINR(row.net_payable), true)}
        </div>
        <Field label="Amount to Pay (₹)" value={amount} onChange={setAmount} type="number" required />
        <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: -8 }}>Editable — owner can adjust (partial payment allowed).</div>
        <Field label="Payment Mode" required><ModeToggle value={mode} onChange={setMode} /></Field>
        <Field label="Notes" value={notes} onChange={setNotes} placeholder="Optional" />
        {error && <div style={errBanner}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving} style={{ minWidth: 130 }}>{saving ? 'Saving…' : 'Mark as Paid ✓'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

/** Printable salary slip. Uses window.print() scoped to the slip content. */
function SalarySlipModal({ row, month, year, onClose }) {
  const e = row.employee;
  const { pharmacy } = usePharmacy();

  function handlePrint() {
    const content = document.getElementById('salary-slip-print').innerHTML;
    const w = window.open('', '_blank', 'width=800,height=900');
    w.document.write(`
      <html><head><title>Salary Slip — ${e.name}</title>
      <style>
        body { font-family: 'Outfit', system-ui, sans-serif; color: #1e1b4b; padding: 40px; }
        h1 { font-size: 20px; margin: 0 0 4px; }
        .muted { color: #6b7280; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        td { padding: 8px 4px; border-bottom: 1px solid #eee; font-size: 14px; }
        td.r { text-align: right; }
        .total { font-weight: 700; font-size: 16px; }
      </style></head><body>${content}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 250);
  }

  return (
    <ModalShell title="Salary Slip" onClose={onClose} width={460}>
      <div id="salary-slip-print">
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1e1b4b', margin: '0 0 2px' }}>{pharmacy.pharmacy_name}</h1>
        <div className="muted" style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>
          Salary Slip — {MONTH_NAMES[month - 1]} {year}
        </div>
        <div style={{ fontSize: 14, marginBottom: 4 }}><strong>{e.name}</strong> — {e.role}</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
          <tbody>
            {[
              ['Basic Salary', row.gross_salary != null ? e.basic_salary : e.basic_salary],
              ['HRA', e.hra],
              ['Travel Allowance', e.travel_allowance],
              ['Other Allowance', e.other_allowance],
            ].map(([l, v]) => (
              <tr key={l}>
                <td style={{ padding: '8px 4px', borderBottom: '1px solid #eee', fontSize: 14 }}>{l}</td>
                <td className="r" style={{ padding: '8px 4px', borderBottom: '1px solid #eee', fontSize: 14, textAlign: 'right' }}>{formatINR(v)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ padding: '8px 4px', borderBottom: '1px solid #eee', fontSize: 14, fontWeight: 600 }}>Gross Salary</td>
              <td className="r" style={{ padding: '8px 4px', borderBottom: '1px solid #eee', fontSize: 14, textAlign: 'right', fontWeight: 600 }}>{formatINR(row.gross_salary)}</td>
            </tr>
            <tr>
              <td style={{ padding: '8px 4px', borderBottom: '1px solid #eee', fontSize: 14, color: '#b45309' }}>Less: Advances</td>
              <td className="r" style={{ padding: '8px 4px', borderBottom: '1px solid #eee', fontSize: 14, textAlign: 'right', color: '#b45309' }}>− {formatINR(row.advances_taken).slice(1)}</td>
            </tr>
            <tr>
              <td className="total" style={{ padding: '10px 4px', fontWeight: 700, fontSize: 16 }}>Net Paid</td>
              <td className="r total" style={{ padding: '10px 4px', textAlign: 'right', fontWeight: 700, fontSize: 16, color: '#059669' }}>
                {formatINR(row.amount_paid != null ? row.amount_paid : row.net_payable)}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="muted" style={{ color: 'var(--text-hint)', fontSize: 11, marginTop: 20 }}>
          This is a computer-generated salary slip. Powered by ARZ Technologies.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn-secondary" onClick={onClose}>Close</button>
        <button className="btn-primary" onClick={handlePrint}>Print Slip</button>
      </div>
    </ModalShell>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  TAB 4 — CASH REGISTER
// ═══════════════════════════════════════════════════════════════════════════

function CashRegisterTab() {
  const [day, setDay]       = useState(todayISO());
  const [reg, setReg]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState('');
  const [history, setHistory] = useState([]);
  const [showOpening, setShowOpening] = useState(false);

  // Actual-count inputs
  const [actualCash, setActualCash] = useState('');
  const [actualBank, setActualBank] = useState('');
  const [savingClose, setSavingClose] = useState(false);

  const fetchRegister = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/expenditure/cash-register/${day}`);
      setReg(data);
      setActualCash(data.actual_closing_cash != null ? String(data.actual_closing_cash) : '');
      setActualBank(data.actual_closing_bank != null ? String(data.actual_closing_bank) : '');
    } catch {
      setError('Could not load cash register.');
    } finally {
      setLoading(false);
    }
  }, [day]);

  useEffect(() => { fetchRegister(); }, [fetchRegister]);

  // Load last 7 days history
  const fetchHistory = useCallback(async () => {
    const days = [];
    for (let i = 1; i <= 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    try {
      const results = await Promise.all(days.map((d) => api.get(`/expenditure/cash-register/${d}`).then((r) => r.data)));
      setHistory(results);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory, reg]);

  async function saveClosing() {
    if (actualCash === '' || actualBank === '') { alert('Enter both counted balances.'); return; }
    setSavingClose(true);
    try {
      const { data } = await api.post('/expenditure/cash-register/closing', {
        date: day,
        actual_closing_cash: Number(actualCash),
        actual_closing_bank: Number(actualBank),
      });
      setReg(data);
    } catch {
      alert('Could not save closing count.');
    } finally {
      setSavingClose(false);
    }
  }

  // Opening set only if a register row hasn't recorded it (heuristic: both zero & no sales)
  const openingSet = reg && (Number(reg.opening_cash) > 0 || Number(reg.opening_bank) > 0);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>Date</label>
          <input type="date" value={day} max={todayISO()} onChange={(e) => setDay(e.target.value)} />
        </div>
        <button className="btn-secondary" onClick={() => setShowOpening(true)}>
          {openingSet ? 'Update Opening Balance' : 'Set Opening Balance'}
        </button>
      </div>

      {error && <div style={{ ...errBanner, marginBottom: 16 }}>{error}</div>}

      {loading || !reg ? (
        <div style={{ ...glassCard, padding: 40, textAlign: 'center', color: 'var(--text-hint)' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 20 }}>
            <DrawerColumn
              title="CASH DRAWER" accent="#059669"
              opening={reg.opening_cash} inLabel="+ Sales" inAmt={reg.cash_in}
              outLabel="− Expenses" outAmt={reg.cash_out} expected={reg.closing_cash}
              actual={actualCash} onActual={setActualCash} diff={reg.difference_cash}
            />
            <DrawerColumn
              title="BANK / UPI" accent="#0284c7"
              opening={reg.opening_bank} inLabel="+ Sales" inAmt={reg.upi_in}
              outLabel="− Expenses" outAmt={reg.upi_out} expected={reg.closing_bank}
              actual={actualBank} onActual={setActualBank} diff={reg.difference_bank}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 24 }}>
            <button className="btn-primary" onClick={saveClosing} disabled={savingClose}>
              {savingClose ? 'Saving…' : 'Save Closing Count'}
            </button>
          </div>

          {/* History */}
          <div style={{ ...glassCard, padding: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1e1b4b', marginBottom: 12 }}>Last 7 Days</div>
            <div style={{
              display: 'grid', gridTemplateColumns: '110px 1fr 1fr 1fr 1fr',
              fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-hint)',
              paddingBottom: 8, borderBottom: '1px solid rgba(0,0,0,0.06)',
            }}>
              <span>Date</span>
              <span style={{ textAlign: 'right' }}>Cash In</span>
              <span style={{ textAlign: 'right' }}>Cash Out</span>
              <span style={{ textAlign: 'right' }}>UPI In</span>
              <span style={{ textAlign: 'right' }}>Expected Cash</span>
            </div>
            {history.map((h) => (
              <div key={h.date} style={{
                display: 'grid', gridTemplateColumns: '110px 1fr 1fr 1fr 1fr',
                fontSize: 12, padding: '8px 0', borderBottom: '1px solid rgba(0,0,0,0.04)', color: '#6b7280',
              }}>
                <span>{h.date}</span>
                <span style={{ textAlign: 'right', color: '#059669' }}>{formatINR(h.cash_in)}</span>
                <span style={{ textAlign: 'right', color: '#e11d48' }}>{formatINR(h.cash_out)}</span>
                <span style={{ textAlign: 'right', color: '#0284c7' }}>{formatINR(h.upi_in)}</span>
                <span style={{ textAlign: 'right', fontWeight: 600, color: '#1e1b4b' }}>{formatINR(h.closing_cash)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {showOpening && reg && (
        <OpeningBalanceModal
          day={day}
          current={reg}
          onClose={() => setShowOpening(false)}
          onSaved={() => { setShowOpening(false); fetchRegister(); }}
        />
      )}
    </div>
  );
}

function DrawerColumn({ title, accent, opening, inLabel, inAmt, outLabel, outAmt, expected, actual, onActual, diff }) {
  const line = (label, value, color) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', fontSize: 14 }}>
      <span style={{ color: '#6b7280' }}>{label}</span>
      <span style={{ fontWeight: 600, color: color || '#1e1b4b' }}>{formatINR(value)}</span>
    </div>
  );
  const hasDiff = diff !== null && diff !== undefined;
  const short = hasDiff && Number(diff) < 0;
  const over  = hasDiff && Number(diff) > 0;

  return (
    <div style={{ ...glassCard, padding: 20, borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', color: accent, marginBottom: 6 }}>{title}</div>
      {line('Opening', opening)}
      {line(inLabel, inAmt, '#059669')}
      {line(outLabel, outAmt, '#e11d48')}
      <div style={{ borderTop: '1px solid rgba(0,0,0,0.08)', margin: '6px 0' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', fontSize: 15, fontWeight: 700 }}>
        <span style={{ color: '#1e1b4b' }}>Expected</span>
        <span style={{ color: accent }}>{formatINR(expected)}</span>
      </div>

      <div style={{ marginTop: 10 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Actual Count</label>
        <input type="number" value={actual} onChange={(e) => onActual(e.target.value)} placeholder="Count the drawer…" style={{ width: '100%', marginTop: 5 }} />
      </div>

      {hasDiff && (
        <div style={{
          marginTop: 10, padding: '8px 12px', borderRadius: 9, fontSize: 13, fontWeight: 600,
          background: Number(diff) === 0 ? 'rgba(16,185,129,0.12)' : short ? 'rgba(244,63,94,0.10)' : 'rgba(245,158,11,0.12)',
          color: Number(diff) === 0 ? '#059669' : short ? '#e11d48' : '#b45309',
        }}>
          {Number(diff) === 0
            ? '✓ Balanced — no difference'
            : short
              ? `⚠ Shortage of ${formatINR(Math.abs(diff))} — please recount`
              : `▲ Excess of ${formatINR(Math.abs(diff))}`}
        </div>
      )}
    </div>
  );
}

function OpeningBalanceModal({ day, current, onClose, onSaved }) {
  const [cash, setCash] = useState(String(current.opening_cash || ''));
  const [bank, setBank] = useState(String(current.opening_bank || ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(ev) {
    ev.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/expenditure/cash-register/opening', {
        date: day,
        opening_cash: Number(cash) || 0,
        opening_bank: Number(bank) || 0,
      });
      onSaved();
    } catch {
      setError('Could not save opening balance.');
      setSaving(false);
    }
  }

  return (
    <ModalShell title={`Opening Balance — ${day}`} onClose={onClose} width={380}>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Opening Cash (₹)" value={cash} onChange={setCash} placeholder="0" type="number" />
        <Field label="Opening Bank / UPI (₹)" value={bank} onChange={setBank} placeholder="0" type="number" />
        {error && <div style={errBanner}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving} style={{ minWidth: 110 }}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Small shared UI bits
// ═══════════════════════════════════════════════════════════════════════════

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ ...glassCard, padding: '16px 18px', position: 'relative', overflow: 'hidden' }} className="fade-up">
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: color, borderRadius: '14px 14px 0 0' }} />
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-hint)', marginBottom: 8, marginTop: 4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#1e1b4b' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function MonthYearSelector({ month, year, onMonth, onYear }) {
  const years = [];
  const cy = new Date().getFullYear();
  for (let y = cy - 3; y <= cy + 1; y++) years.push(y);
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <select value={month} onChange={(e) => onMonth(Number(e.target.value))} style={{ minWidth: 130 }}>
        {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
      </select>
      <select value={year} onChange={(e) => onYear(Number(e.target.value))} style={{ minWidth: 90 }}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}
