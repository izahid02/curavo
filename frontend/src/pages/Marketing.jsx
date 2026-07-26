/**
 * Marketing Automation page — Phase 3.4
 *
 * Two tabs:
 *  1. Campaigns  — list view with stats bar, actions (view / queue / delete)
 *  2. Create Campaign — 3-step form (Basic Info → Target Audience → Message)
 *
 * All API calls go through src/lib/api.js (Axios instance with auth header).
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { formatDateOnly } from '../lib/datetime';

// ─── tiny helpers ────────────────────────────────────────────────────────────

// IST-aware date for campaign created_at / scheduled_at (see lib/datetime.js).
const fmt = formatDateOnly;

const CAMPAIGN_TYPE_LABELS = {
  HEALTH_TIP:  'Health Tip',
  FESTIVAL:    'Festival Greeting',
  AWARENESS:   'Awareness',
  PROMOTIONAL: 'Promotional',
  RECALL:      'Patient Recall',
};

const CAMPAIGN_TYPE_BADGE = {
  HEALTH_TIP:  'badge-ok',
  FESTIVAL:    'badge-accent',
  AWARENESS:   'badge-info',
  PROMOTIONAL: 'badge-warn',
  RECALL:      'badge-danger',
};

const STATUS_BADGE = {
  DRAFT:     'badge-neutral',
  QUEUED:    'badge-info',
  SENT:      'badge-ok',
  CANCELLED: 'badge-danger',
};

// Toast notification (top-right, auto-dismiss after 3 s)
function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);

  const bg = type === 'success' ? 'var(--ok)' : 'var(--danger)';
  return createPortal(
    <div style={{
      position: 'fixed', top: 20, right: 20, zIndex: 9999,
      background: bg, color: '#fff',
      padding: '12px 20px', borderRadius: 'var(--radius)',
      boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
      fontSize: 13, fontWeight: 600,
      animation: 'fadeUp 0.3s ease',
    }}>
      {message}
    </div>,
    document.body
  );
}

// ─── Campaign Detail Modal ────────────────────────────────────────────────────

function CampaignDetailModal({ campaign, onClose, onQueue }) {
  const [recipients, setRecipients] = useState([]);
  const [loadingR, setLoadingR]     = useState(false);
  const [queuing, setQueuing]       = useState(false);

  useEffect(() => {
    if (campaign.status !== 'DRAFT') {
      setLoadingR(true);
      api.get(`/marketing/campaigns/${campaign.id}/recipients`)
        .then(({ data }) => setRecipients(data))
        .catch(() => {})
        .finally(() => setLoadingR(false));
    }
  }, [campaign.id, campaign.status]);

  async function handleQueue() {
    if (!window.confirm(`Queue "${campaign.name}" for all matched patients? This cannot be undone.`)) return;
    setQueuing(true);
    try {
      await onQueue(campaign.id);
      onClose();
    } finally {
      setQueuing(false);
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(30,27,75,0.45)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--glass-strong)', backdropFilter: 'blur(24px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-xl)', padding: 28,
        width: '100%', maxWidth: 680, maxHeight: '90vh', overflowY: 'auto',
      }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span className={`badge ${STATUS_BADGE[campaign.status] ?? 'badge-neutral'}`}>{campaign.status}</span>
              <span className={`badge ${CAMPAIGN_TYPE_BADGE[campaign.campaign_type] ?? 'badge-neutral'}`}>
                {CAMPAIGN_TYPE_LABELS[campaign.campaign_type] ?? campaign.campaign_type}
              </span>
              <span className="badge badge-neutral">{campaign.channel}</span>
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', margin: 0 }}>{campaign.name}</h2>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-hint)', padding: '0 4px' }}>×</button>
        </div>

        {campaign.description && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>{campaign.description}</p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
          <InfoCard label="Created" value={fmt(campaign.created_at)} />
          <InfoCard label="Scheduled" value={fmt(campaign.scheduled_at)} />
          <InfoCard label="Recipients" value={campaign.recipient_count} />
        </div>

        {/* Filters */}
        {campaign.filters?.length > 0 && (
          <Section title="Audience Filters">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {campaign.filters.map((f, i) => (
                <span key={i} className="badge badge-info" style={{ fontSize: 11 }}>
                  {f.filter_type}: {f.filter_value}
                </span>
              ))}
            </div>
          </Section>
        )}

        {/* Messages */}
        {campaign.messages?.length > 0 && (
          <Section title="Messages">
            {campaign.messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-hint)', textTransform: 'uppercase', marginBottom: 4 }}>
                  {m.language === 'EN' ? 'English' : 'Assamese'}
                </div>
                <div style={{
                  background: 'rgba(255,255,255,0.5)', border: '1px solid var(--glass-border)',
                  borderRadius: 'var(--radius)', padding: '10px 14px',
                  fontSize: 13, color: 'var(--text)', lineHeight: 1.6,
                }}>
                  {m.message_body}
                </div>
              </div>
            ))}
          </Section>
        )}

        {/* Recipients (shown after queuing) */}
        {campaign.status !== 'DRAFT' && (
          <Section title={`Recipients (${recipients.length})`}>
            {loadingR ? <p style={{ color: 'var(--text-hint)', fontSize: 13 }}>Loading…</p> : (
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-hint)', textTransform: 'uppercase', fontSize: 10, letterSpacing: '0.05em' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Patient</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Mobile</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map(r => (
                      <tr key={r.id} style={{ borderTop: '1px solid rgba(0,0,0,0.05)' }}>
                        <td style={{ padding: '6px 8px', color: 'var(--text)' }}>{r.patient_name}</td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-secondary)' }}>{r.mobile}</td>
                        <td style={{ padding: '6px 8px' }}>
                          <span className={`badge ${r.status === 'QUEUED' ? 'badge-info' : r.status === 'SENT' ? 'badge-ok' : 'badge-danger'}`} style={{ fontSize: 10 }}>
                            {r.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {campaign.status === 'DRAFT' && (
          <div style={{ marginTop: 20 }}>
            <button className="btn-primary" onClick={handleQueue} disabled={queuing} style={{ width: '100%' }}>
              {queuing ? 'Queuing…' : '📤 Queue Campaign'}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function InfoCard({ label, value }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.4)', border: '1px solid var(--glass-border)',
      borderRadius: 'var(--radius)', padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{value ?? '—'}</div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

// ─── Create Campaign: Step 1 — Basic Info ────────────────────────────────────

function StepBasicInfo({ data, onChange, onNext }) {
  const valid = data.name.trim() && data.campaign_type;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ margin: 0, color: 'var(--text)', fontSize: 16 }}>Step 1 — Basic Info</h3>

      <label style={labelStyle}>
        Campaign Name <span style={{ color: 'var(--danger)' }}>*</span>
        <input
          style={inputStyle}
          placeholder="e.g. Diabetes Awareness June 2026"
          value={data.name}
          onChange={e => onChange({ ...data, name: e.target.value })}
        />
      </label>

      <label style={labelStyle}>
        Description
        <textarea
          style={{ ...inputStyle, minHeight: 72, resize: 'vertical' }}
          placeholder="Optional — internal note about this campaign"
          value={data.description}
          onChange={e => onChange({ ...data, description: e.target.value })}
        />
      </label>

      <label style={labelStyle}>
        Campaign Type <span style={{ color: 'var(--danger)' }}>*</span>
        <select style={inputStyle} value={data.campaign_type} onChange={e => onChange({ ...data, campaign_type: e.target.value })}>
          <option value="">Select type…</option>
          <option value="HEALTH_TIP">Health Tip</option>
          <option value="FESTIVAL">Festival Greeting</option>
          <option value="AWARENESS">Awareness</option>
          <option value="PROMOTIONAL">Promotional</option>
          <option value="RECALL">Patient Recall</option>
        </select>
      </label>

      <label style={labelStyle}>
        Channel
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name="channel" value="SMS" checked={data.channel === 'SMS'} onChange={() => onChange({ ...data, channel: 'SMS' })} />
            SMS
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-hint)', cursor: 'not-allowed' }}>
            <input type="radio" disabled />
            WhatsApp (coming soon)
          </label>
        </div>
      </label>

      <label style={labelStyle}>
        Scheduled Date &amp; Time <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>(optional — leave empty to send immediately)</span>
        <input
          type="datetime-local"
          style={inputStyle}
          value={data.scheduled_at}
          onChange={e => onChange({ ...data, scheduled_at: e.target.value })}
        />
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn-primary" onClick={onNext} disabled={!valid}>
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Create Campaign: Step 2 — Target Audience ───────────────────────────────

const FILTER_TYPES = [
  { value: 'TAG',                label: 'Has Tag' },
  { value: 'DEPARTMENT',         label: 'Department' },
  { value: 'PATIENT_TYPE',       label: 'Patient Type' },
  { value: 'GENDER',             label: 'Gender' },
  { value: 'LAST_VISIT_BEFORE',  label: 'Last Visit Before' },
  { value: 'LAST_VISIT_AFTER',   label: 'Last Visit After' },
  { value: 'AGE_MIN',            label: 'Min Age' },
  { value: 'AGE_MAX',            label: 'Max Age' },
];

function FilterValueInput({ filterType, value, onChange, tags, departments }) {
  if (filterType === 'TAG') {
    return (
      <select style={{ ...inputStyle, flex: 1 }} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Select tag…</option>
        {tags.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
      </select>
    );
  }
  if (filterType === 'DEPARTMENT') {
    return (
      <select style={{ ...inputStyle, flex: 1 }} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Select department…</option>
        {departments.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
      </select>
    );
  }
  if (filterType === 'PATIENT_TYPE') {
    return (
      <select style={{ ...inputStyle, flex: 1 }} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Select…</option>
        <option value="PRESCRIPTION">Prescription</option>
        <option value="SELF_MEDICATION">Self Medication</option>
      </select>
    );
  }
  if (filterType === 'GENDER') {
    return (
      <select style={{ ...inputStyle, flex: 1 }} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">Select…</option>
        <option value="M">Male</option>
        <option value="F">Female</option>
        <option value="O">Other</option>
      </select>
    );
  }
  if (filterType === 'LAST_VISIT_BEFORE' || filterType === 'LAST_VISIT_AFTER') {
    return <input type="date" style={{ ...inputStyle, flex: 1 }} value={value} onChange={e => onChange(e.target.value)} />;
  }
  // AGE_MIN / AGE_MAX — number
  return (
    <input
      type="number" min="0" max="120"
      style={{ ...inputStyle, flex: 1 }}
      placeholder="Age"
      value={value}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function StepTargetAudience({ data, onChange, onBack, onNext, tags, departments }) {
  const [preview, setPreview]   = useState(null);
  const [previewing, setPreviewing] = useState(false);

  function addFilter() {
    onChange({ ...data, filters: [...data.filters, { filter_type: 'TAG', filter_value: '' }] });
  }

  function removeFilter(i) {
    const f = data.filters.filter((_, idx) => idx !== i);
    onChange({ ...data, filters: f });
    setPreview(null);
  }

  function updateFilter(i, patch) {
    const f = data.filters.map((fl, idx) => idx === i ? { ...fl, ...patch } : fl);
    onChange({ ...data, filters: f });
    setPreview(null);
  }

  async function doPreview() {
    setPreviewing(true);
    try {
      const { data: res } = await api.post('/marketing/campaigns/preview', { filters: data.filters });
      setPreview(res);
    } catch {
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ margin: 0, color: 'var(--text)', fontSize: 16 }}>Step 2 — Target Audience</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
        Add filters to narrow who receives this message. All filters use AND logic — a patient must match every filter. Leave empty to target all patients with a mobile number.
      </p>

      {/* Filter rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.filters.map((f, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select
              style={{ ...inputStyle, width: 170, flexShrink: 0 }}
              value={f.filter_type}
              onChange={e => updateFilter(i, { filter_type: e.target.value, filter_value: '' })}
            >
              {FILTER_TYPES.map(ft => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
            </select>
            <FilterValueInput
              filterType={f.filter_type}
              value={f.filter_value}
              onChange={v => updateFilter(i, { filter_value: v })}
              tags={tags}
              departments={departments}
            />
            <button
              onClick={() => removeFilter(i)}
              style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 18, flexShrink: 0 }}
            >×</button>
          </div>
        ))}
      </div>

      <button
        onClick={addFilter}
        className="btn-secondary"
        style={{ alignSelf: 'flex-start', fontSize: 13 }}
      >
        + Add Filter
      </button>

      {/* Preview */}
      <div>
        <button className="btn-secondary" onClick={doPreview} disabled={previewing} style={{ fontSize: 13 }}>
          {previewing ? 'Checking…' : '🔍 Preview Audience'}
        </button>
        {preview && (
          <div style={{
            marginTop: 12, background: 'rgba(255,255,255,0.4)',
            border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)',
            padding: '12px 16px',
          }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)', marginBottom: 8, fontSize: 14 }}>
              {preview.matched_patients} patient{preview.matched_patients !== 1 ? 's' : ''} match these filters
            </div>
            {preview.sample_patients.length > 0 && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sample (up to 5)</div>
                {preview.sample_patients.map((p, i) => (
                  <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '3px 0' }}>
                    {p.name} — {p.mobile}
                    {p.tags.length > 0 && <span style={{ color: 'var(--text-hint)', marginLeft: 6 }}>[{p.tags.join(', ')}]</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
        <button className="btn-primary" onClick={onNext}>Next →</button>
      </div>
    </div>
  );
}

// ─── Create Campaign: Step 3 — Message ───────────────────────────────────────

function StepMessage({ data, onChange, onBack, onSubmit, submitting }) {
  const enBody = data.messages.find(m => m.language === 'EN')?.message_body ?? '';
  const asBody = data.messages.find(m => m.language === 'AS')?.message_body ?? '';

  function setMsg(lang, body) {
    const others = data.messages.filter(m => m.language !== lang);
    const updated = body.trim() ? [...others, { language: lang, message_body: body }] : others;
    onChange({ ...data, messages: updated });
  }

  // Live preview: replace variables with sample values
  const sampleEN = enBody.replace(/{patient_name}/g, 'Rahul Das').replace(/{shop_name}/g, 'Health Care Centre');
  const sampleAS = asBody.replace(/{patient_name}/g, 'ৰাহুল দাস').replace(/{shop_name}/g, 'Health Care Centre');

  const enValid = enBody.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <h3 style={{ margin: 0, color: 'var(--text)', fontSize: 16 }}>Step 3 — Message</h3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* English */}
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
            English Message <span style={{ color: 'var(--danger)' }}>*</span>
          </div>
          <textarea
            style={{ ...inputStyle, minHeight: 120, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            placeholder="Dear {patient_name}, …"
            value={enBody}
            onChange={e => setMsg('EN', e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
            <span>{enBody.length} chars ({Math.ceil(enBody.length / 160)} SMS)</span>
            <span style={{ color: enBody.length > 160 ? 'var(--warn)' : undefined }}>160 = 1 SMS</span>
          </div>
          <VariableHints />
        </div>

        {/* Assamese */}
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)', marginBottom: 6 }}>
            Assamese Message <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>(optional)</span>
          </div>
          <textarea
            style={{ ...inputStyle, minHeight: 120, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            placeholder="মৰমৰ {patient_name}, …"
            value={asBody}
            onChange={e => setMsg('AS', e.target.value)}
          />
          <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 4 }}>
            {asBody.length} chars ({Math.ceil((asBody.length || 1) / 160)} SMS)
          </div>
          <VariableHints />
        </div>
      </div>

      {/* Preview */}
      {(enBody || asBody) && (
        <div style={{
          background: 'rgba(255,255,255,0.4)', border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius)', padding: '14px 16px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            Message Preview (with sample name "Rahul Das")
          </div>
          {sampleEN && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: 'var(--text-hint)', marginBottom: 4 }}>ENGLISH</div>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, background: 'rgba(99,102,241,0.06)', padding: '8px 12px', borderRadius: 8 }}>
                {sampleEN}
              </div>
            </div>
          )}
          {sampleAS && (
            <div>
              <div style={{ fontSize: 10, color: 'var(--text-hint)', marginBottom: 4 }}>ASSAMESE</div>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6, background: 'rgba(99,102,241,0.06)', padding: '8px 12px', borderRadius: 8 }}>
                {sampleAS}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
        <button className="btn-secondary" onClick={onBack}>← Back</button>
        <button className="btn-primary" onClick={onSubmit} disabled={!enValid || submitting}>
          {submitting ? 'Creating…' : '✓ Create Campaign'}
        </button>
      </div>
    </div>
  );
}

function VariableHints() {
  return (
    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-hint)' }}>
      Variables: <code style={{ background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 4 }}>{'{patient_name}'}</code>{' '}
      <code style={{ background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 4 }}>{'{shop_name}'}</code>
    </div>
  );
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputStyle = {
  display: 'block', width: '100%',
  padding: '9px 12px', marginTop: 6,
  background: 'rgba(255,255,255,0.55)',
  backdropFilter: 'blur(8px)',
  border: '1px solid rgba(255,255,255,0.7)',
  borderRadius: 'var(--radius)',
  fontSize: 13, color: 'var(--text)',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle = {
  display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text)',
};

// ─── Tab 1: Campaign list ─────────────────────────────────────────────────────

function CampaignList({ onRefresh }) {
  const [campaigns, setCampaigns]   = useState([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState(null);   // for detail modal
  const [toast, setToast]           = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/marketing/campaigns')
      .then(({ data }) => setCampaigns(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  // Expose reload to parent so "Create Campaign" can trigger a refresh
  useEffect(() => { onRefresh.current = load; }, [load, onRefresh]);

  const total   = campaigns.length;
  const queued  = campaigns.filter(c => c.status === 'QUEUED' || c.status === 'SENT').length;
  const drafts  = campaigns.filter(c => c.status === 'DRAFT').length;

  async function handleQueue(campaignId) {
    try {
      const { data } = await api.post(`/marketing/campaigns/${campaignId}/queue`);
      setCampaigns(prev => prev.map(c => c.id === campaignId ? { ...c, status: data.status, recipient_count: data.recipient_count, sent_at: data.sent_at } : c));
      setToast({ message: '✅ Campaign queued! Messages are in the outbox.', type: 'success' });
    } catch (err) {
      setToast({ message: err.response?.data?.detail ?? 'Failed to queue campaign', type: 'error' });
    }
  }

  async function handleDelete(campaign) {
    if (!window.confirm(`Delete "${campaign.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/marketing/campaigns/${campaign.id}`);
      setCampaigns(prev => prev.filter(c => c.id !== campaign.id));
      setToast({ message: 'Campaign deleted.', type: 'success' });
    } catch (err) {
      setToast({ message: err.response?.data?.detail ?? 'Failed to delete campaign', type: 'error' });
    }
  }

  return (
    <div>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Stats bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
        <StatCard label="Total Campaigns" value={total} color="var(--accent)" />
        <StatCard label="Queued / Sent"   value={queued} color="var(--info)" />
        <StatCard label="Draft"           value={drafts} color="var(--text-secondary)" />
      </div>

      {/* Table */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-hint)', fontSize: 13 }}>Loading…</div>
        ) : campaigns.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-hint)', fontSize: 13 }}>
            No campaigns yet. Click "Create Campaign" to get started.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                {['Name', 'Type', 'Channel', 'Recipients', 'Status', 'Created', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c, i) => (
                <tr key={c.id} style={{ borderTop: i > 0 ? '1px solid rgba(0,0,0,0.04)' : undefined, transition: 'background 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.3)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>{c.name}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span className={`badge ${CAMPAIGN_TYPE_BADGE[c.campaign_type] ?? 'badge-neutral'}`} style={{ fontSize: 11 }}>
                      {CAMPAIGN_TYPE_LABELS[c.campaign_type] ?? c.campaign_type}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-secondary)' }}>{c.channel}</td>
                  <td style={{ padding: '12px 16px', fontSize: 13, color: 'var(--text)', fontWeight: 600 }}>{c.recipient_count}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <span className={`badge ${STATUS_BADGE[c.status] ?? 'badge-neutral'}`} style={{ fontSize: 11 }}>
                      {c.status}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 12, color: 'var(--text-secondary)' }}>{fmt(c.created_at)}</td>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-secondary" style={{ fontSize: 11, padding: '4px 10px' }}
                        onClick={() => setSelected(c)}>
                        View
                      </button>
                      {c.status === 'DRAFT' && (
                        <>
                          <button className="btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={async () => {
                              if (!window.confirm(`Queue "${c.name}"?`)) return;
                              await handleQueue(c.id);
                            }}>
                            Queue
                          </button>
                          <button className="btn-danger" style={{ fontSize: 11, padding: '4px 10px' }}
                            onClick={() => handleDelete(c)}>
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && (
        <CampaignDetailModal
          campaign={selected}
          onClose={() => setSelected(null)}
          onQueue={async (id) => {
            await handleQueue(id);
            const updated = campaigns.find(c => c.id === id);
            if (updated) setSelected({ ...updated, status: 'QUEUED' });
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--glass)', backdropFilter: 'blur(24px)',
      border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-lg)',
      borderTop: `3px solid ${color}`,
      padding: '16px 20px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-hint)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
    </div>
  );
}

// ─── Tab 2: Create Campaign (3-step form) ────────────────────────────────────

const INITIAL_FORM = {
  name: '',
  description: '',
  campaign_type: '',
  channel: 'SMS',
  scheduled_at: '',
  filters: [],
  messages: [],
};

function CreateCampaign({ onCreated }) {
  const [step, setStep]         = useState(1);
  const [form, setForm]         = useState(INITIAL_FORM);
  const [tags, setTags]         = useState([]);
  const [departments, setDepts] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get('/patients/tags').then(({ data }) => setTags(data)).catch(() => {});
    api.get('/inventory/departments').then(({ data }) => setDepts(data)).catch(() => {});
  }, []);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const payload = {
        name:          form.name,
        description:   form.description || null,
        campaign_type: form.campaign_type,
        channel:       form.channel,
        filters:       form.filters,
        messages:      form.messages,
        scheduled_at:  form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
      };
      await api.post('/marketing/campaigns', payload);
      setForm(INITIAL_FORM);
      setStep(1);
      onCreated();
    } catch (err) {
      alert(err.response?.data?.detail ?? 'Failed to create campaign');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 780 }}>
      {/* Step indicator */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 28 }}>
        {[1, 2, 3].map((n, i) => (
          <div key={n} style={{ display: 'flex', alignItems: 'center', flex: i < 2 ? 1 : undefined }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: step >= n ? 'var(--accent)' : 'rgba(99,102,241,0.15)',
              color: step >= n ? '#fff' : 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, flexShrink: 0,
            }}>{n}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: step >= n ? 'var(--accent)' : 'var(--text-hint)', marginLeft: 8, whiteSpace: 'nowrap' }}>
              {n === 1 ? 'Basic Info' : n === 2 ? 'Audience' : 'Message'}
            </div>
            {i < 2 && <div style={{ flex: 1, height: 2, background: step > n ? 'var(--accent)' : 'rgba(99,102,241,0.15)', margin: '0 12px' }} />}
          </div>
        ))}
      </div>

      {/* Step panels */}
      <div className="glass-card" style={{ padding: 24 }}>
        {step === 1 && (
          <StepBasicInfo
            data={form}
            onChange={setForm}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <StepTargetAudience
            data={form}
            onChange={setForm}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            tags={tags}
            departments={departments}
          />
        )}
        {step === 3 && (
          <StepMessage
            data={form}
            onChange={setForm}
            onBack={() => setStep(2)}
            onSubmit={handleSubmit}
            submitting={submitting}
          />
        )}
      </div>
    </div>
  );
}

// ─── Main page component ──────────────────────────────────────────────────────

export default function Marketing() {
  const [tab, setTab]       = useState('campaigns');
  const [toast, setToast]   = useState(null);
  // Ref so CreateCampaign can trigger CampaignList to reload
  const refreshRef = { current: null };

  function handleCampaignCreated() {
    setTab('campaigns');
    setToast({ message: '✅ Campaign created! Review and queue it when ready.', type: 'success' });
    if (refreshRef.current) refreshRef.current();
  }

  return (
    <div>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 24, borderBottom: '1px solid rgba(0,0,0,0.07)', paddingBottom: 0 }}>
        {[
          { key: 'campaigns', label: 'Campaigns' },
          { key: 'create',    label: '+ Create Campaign' },
        ].map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '9px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              background: 'none', border: 'none',
              color: tab === t.key ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'campaigns' && <CampaignList onRefresh={refreshRef} />}
      {tab === 'create'    && <CreateCampaign onCreated={handleCampaignCreated} />}
    </div>
  );
}
