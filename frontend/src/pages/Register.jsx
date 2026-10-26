/**
 * Register — the Schedule H1 / MTP record of what was dispensed to whom.
 *
 * Rule 65(11)(d) requires a pharmacy to keep this for three years and produce
 * it on inspection.  Every value shown here was COPIED onto its row at the
 * moment of dispensing; nothing is looked up live.  So an entry reads today
 * exactly as it read on the day it was written, even if the patient's phone
 * number has been corrected since.
 *
 * The column order follows the official register (prescriber, patient,
 * medicine, quantity, date).  Everything after that — phone, address, batch,
 * invoice — is this pharmacy's own addition.  A register may hold more than
 * the minimum; it may never hold less.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { getTodayIST } from '../lib/datetime';

/** Quick windows.  "Today" first, because that is what is usually wanted. */
const RANGES = [
  ['today', 'Today'],
  ['week',  'Last 7 days'],
  ['month', 'Last 30 days'],
  ['all',   'Everything'],
];

function rangeToDates(key) {
  const today = getTodayIST();           // "YYYY-MM-DD" in IST
  if (key === 'all') return { from: '', to: '' };
  if (key === 'today') return { from: today, to: today };
  const days = key === 'week' ? 6 : 29;
  const d = new Date(`${today}T00:00:00`);
  d.setDate(d.getDate() - days);
  return { from: d.toISOString().slice(0, 10), to: today };
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

export default function Register() {
  const [range,   setRange]   = useState('month');
  const [category, setCategory] = useState('');
  const [search,  setSearch]  = useState('');
  const [debounced, setDebounced] = useState('');
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = useCallback(() => {
    const { from, to } = rangeToDates(range);
    const p = new URLSearchParams();
    if (from) p.set('date_from', from);
    if (to)   p.set('date_to', to);
    if (category) p.set('category', category);
    if (debounced.trim()) p.set('search', debounced.trim());
    return p;
  }, [range, category, debounced]);

  useEffect(() => {
    setLoading(true);
    setError('');
    api.get(`/regulated/register?${params()}`)
      .then(({ data: d }) => setData(d))
      .catch((err) => setError(err.response?.data?.detail || 'Could not load the register.'))
      .finally(() => setLoading(false));
  }, [params]);

  /**
   * Download through the API client, not a plain link: the endpoint needs the
   * JWT, and a bare <a href> carries no auth header and would just 401.
   */
  async function download() {
    setDownloading(true);
    setError('');
    try {
      const res = await api.get(`/regulated/register/export?${params()}`, {
        responseType: 'blob',
      });
      const disp = res.headers['content-disposition'] || '';
      const match = disp.match(/filename="?([^"]+)"?/);
      const name = match ? match[1] : 'H1-register.xlsx';
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not download the register.');
    } finally {
      setDownloading(false);
    }
  }

  const TH = {
    padding: '10px 12px', textAlign: 'left', fontSize: 11,
    fontWeight: 700, letterSpacing: 0.3, textTransform: 'uppercase',
    color: 'var(--text-muted)', borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap', background: 'var(--bg)',
  };
  const TD = {
    padding: '10px 12px', fontSize: 13, verticalAlign: 'top',
    borderBottom: '1px solid var(--border)',
  };

  return (
    <div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-secondary)', maxWidth: 760, lineHeight: 1.55 }}>
        Every Schedule H1 and MTP kit sale, as recorded at the counter. Kept for
        three years and produced on inspection. These details were copied at the
        moment of dispensing, so correcting a patient's record later never
        changes what the register says.
      </p>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              style={{
                padding: '6px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                borderRadius: 8,
                border: range === key ? '1px solid rgba(99,102,241,0.45)' : '1px solid var(--border)',
                background: range === key ? 'var(--accent-light)' : 'transparent',
                color: range === key ? 'var(--accent-dark)' : 'var(--text-secondary)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{ fontSize: 13, padding: '6px 8px', maxWidth: 170 }}
        >
          <option value="">Both registers</option>
          <option value="H1">Schedule H1</option>
          <option value="MTP">MTP kit</option>
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Patient, phone, medicine, doctor or invoice…"
          style={{ fontSize: 13, maxWidth: 320, flex: 1, minWidth: 200 }}
        />

        <button
          className="btn-primary"
          onClick={download}
          disabled={downloading || loading || !data?.items?.length}
          style={{ marginLeft: 'auto' }}
        >
          {downloading ? 'Preparing…' : '↓ Download for Excel'}
        </button>
      </div>

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>{error}</p>
      )}

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        {loading ? (
          <p style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading the register…
          </p>
        ) : !data || data.items.length === 0 ? (
          <p style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
            Nothing in the register for this period.
            <br />
            <span style={{ fontSize: 12 }}>
              Entries appear here automatically when a medicine marked Schedule H1
              or MTP kit is sold.
            </span>
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['S.No.', 'Date', 'Prescriber (name & address)', 'Patient',
                  'Medicine dispensed', 'Quantity', 'Batch', 'Register', 'Invoice']
                  .map((h) => <th key={h} style={TH}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td style={{ ...TD, color: 'var(--text-hint)', fontFamily: 'monospace' }}>{e.serial}</td>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>{fmtDate(e.sold_on)}</td>
                  <td style={TD}>
                    <div style={{ fontWeight: 600 }}>{e.prescriber_name}</div>
                    {e.prescriber_address && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.prescriber_address}</div>
                    )}
                  </td>
                  <td style={TD}>
                    <div style={{ fontWeight: 600 }}>{e.patient_name}</div>
                    {e.patient_phone && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                        {e.patient_phone}
                      </div>
                    )}
                    {e.patient_address && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.patient_address}</div>
                    )}
                  </td>
                  <td style={TD}>
                    <div style={{ fontWeight: 600 }}>{e.product_name}</div>
                    {e.generic_name && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.generic_name}</div>
                    )}
                  </td>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>{e.quantity_label || e.quantity}</td>
                  <td style={{ ...TD, whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 12 }}>
                    {e.batch_number || '—'}
                  </td>
                  <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                    <span style={{
                      fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
                      background: e.category === 'H1' ? 'rgba(245,158,11,0.14)' : 'rgba(244,63,94,0.12)',
                      color:      e.category === 'H1' ? 'var(--warn)' : 'var(--danger)',
                    }}>
                      {e.category_label}
                    </span>
                    {e.drug_matched && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-hint)', marginTop: 3, textTransform: 'capitalize' }}>
                        {e.drug_matched}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11.5 }}>
                    {e.invoice_number || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.items.length > 0 && (
        <p style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
          Showing {data.items.length} of {data.total} entr{data.total === 1 ? 'y' : 'ies'}
          {data.date_from ? ` · ${fmtDate(data.date_from)} to ${fmtDate(data.date_to)}` : ' · all time'}
        </p>
      )}
    </div>
  );
}
