/**
 * FollowUps.jsx — Phase 3: Smart Follow-Up System
 *
 * This page helps pharmacy staff track patient follow-ups after a purchase.
 * When a SELF_MEDICATION patient buys medicines, the system automatically
 * schedules check-ins on Day 2, 5, 10, and 30 after the purchase.
 *
 * Four tabs:
 *   1. Due Today   — patients who need to be contacted right now
 *   2. Responses   — incoming patient responses that may need staff action
 *   3. All Schedules — full history of all follow-up checkpoints
 *   4. Message Queue — SMS/WhatsApp messages waiting to be sent
 *
 * Uses createPortal for modals (required by CLAUDE.md to avoid clipping).
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDateOnly, formatDateTimeShort } from '../lib/datetime';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a date string as "12 Jun 2026" (IST — see lib/datetime.js). */
const fmtDate = formatDateOnly;

/** Format a datetime string as "12 Jun 2026, 10:00 am" (IST). */
const fmtDateTime = formatDateTimeShort;

/** Truncate a string to maxLen characters */
function truncate(str, maxLen = 60) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

/** Day number → badge color class */
function dayBadgeClass(day) {
  if (day === 2)  return 'badge-info';
  if (day === 30) return 'badge-accent';
  return 'badge-warn';   // Day 5 and Day 10
}

/** Status → badge color class */
function statusBadgeClass(status) {
  switch (status) {
    case 'PENDING':   return 'badge-warn';
    case 'COMPLETED': return 'badge-ok';
    case 'CANCELLED': return 'badge-neutral';
    case 'QUEUED':    return 'badge-info';
    case 'SENT':      return 'badge-ok';
    case 'FAILED':    return 'badge-danger';
    default:          return 'badge-neutral';
  }
}

/** response_type → badge class and label */
function responseBadge(type) {
  switch (type) {
    case 'BETTER':      return { cls: 'badge-ok',      label: 'Feeling Better' };
    case 'SAME':        return { cls: 'badge-warn',    label: 'Still Same' };
    case 'NEED_DOCTOR': return { cls: 'badge-danger',  label: 'Needs Doctor' };
    case 'CALL_ME':     return { cls: 'badge-info',    label: 'Call Me' };
    default:            return { cls: 'badge-neutral', label: type };
  }
}

// ---------------------------------------------------------------------------
// Toast — simple green/red floating message
// ---------------------------------------------------------------------------

function Toast({ message }) {
  if (!message) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 28, right: 28, zIndex: 8888,
      background: 'var(--ok)', color: '#fff',
      padding: '12px 20px', borderRadius: 'var(--radius)',
      fontWeight: 600, fontSize: 14,
      boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
    }}>
      ✓ {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats Bar (for Follow-Up Schedules summary)
// ---------------------------------------------------------------------------

function StatsBar({ stats }) {
  const cards = [
    { label: 'Pending',    value: stats.total_pending,   color: 'var(--warn)' },
    { label: 'Due Today',  value: stats.due_today,       color: 'var(--danger)' },
    { label: 'Sent',       value: stats.total_sent,      color: 'var(--ok)' },
    { label: 'Cancelled',  value: stats.total_cancelled, color: 'var(--text-hint)' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.label} style={{
          background: 'var(--glass)',
          backdropFilter: 'blur(24px)',
          border: '1px solid var(--glass-border)',
          borderTop: `3px solid ${c.color}`,
          borderRadius: 'var(--radius)',
          padding: '14px 16px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value ?? 0}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Record Response Modal (Due Today tab)
// ---------------------------------------------------------------------------

const RESPONSE_BUTTONS = [
  {
    type: 'BETTER',
    label: 'Feeling Better',
    emoji: '✅',
    color: 'var(--ok)',
    bg: 'var(--ok-bg)',
    note: 'All remaining follow-ups will be cancelled automatically.',
  },
  {
    type: 'SAME',
    label: 'Still Same',
    emoji: '😐',
    color: 'var(--warn)',
    bg: 'var(--warn-bg)',
    note: null,
  },
  {
    type: 'NEED_DOCTOR',
    label: 'Needs Doctor',
    emoji: '🏥',
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
    note: 'OPD desk will be notified.',
  },
  {
    type: 'CALL_ME',
    label: 'Please Call Me',
    emoji: '📞',
    color: 'var(--info)',
    bg: 'var(--info-bg)',
    note: 'Callback task will be created.',
  },
];

function RecordResponseModal({ schedule, onClose, onSaved }) {
  const [selected, setSelected]   = useState(null);
  const [notes, setNotes]         = useState('');
  const [saving, setSaving]       = useState(false);
  const [saveNote, setSaveNote]   = useState('');

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    try {
      await api.post('/followup/responses', {
        patient_id   : schedule.patient_id,
        follow_up_id : schedule.id,
        response_type: selected,
        notes        : notes || null,
      });
      setSaveNote('');
      onSaved(schedule.id);
    } catch (err) {
      setSaveNote(err.response?.data?.detail || 'Error saving response');
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--glass-strong)',
        backdropFilter: 'blur(32px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-xl)',
        padding: 28, width: 460,
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
              Record Response
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
              {schedule.patient_name}
              {schedule.patient_mobile && (
                <span style={{ color: 'var(--text-hint)', marginLeft: 8 }}>
                  {schedule.patient_mobile}
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 4 }}>
              Day {schedule.day_number} · Invoice {schedule.invoice_number}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 20, color: 'var(--text-hint)', lineHeight: 1,
            }}
          >×</button>
        </div>

        {/* Response buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {RESPONSE_BUTTONS.map(rb => (
            <button
              key={rb.type}
              onClick={() => setSelected(rb.type)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '13px 16px',
                background: selected === rb.type ? rb.bg : 'rgba(255,255,255,0.4)',
                border: `2px solid ${selected === rb.type ? rb.color : 'rgba(0,0,0,0.08)'}`,
                borderRadius: 'var(--radius)',
                cursor: 'pointer', textAlign: 'left',
                transition: 'all 0.15s',
              }}
            >
              <span style={{ fontSize: 22 }}>{rb.emoji}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: rb.color, fontSize: 14 }}>{rb.label}</div>
                {rb.note && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 1 }}>{rb.note}</div>
                )}
              </div>
              {selected === rb.type && (
                <span style={{ color: rb.color, fontWeight: 700, fontSize: 18 }}>✓</span>
              )}
            </button>
          ))}
        </div>

        {/* Optional notes */}
        <textarea
          placeholder="Optional notes (e.g. side effects mentioned, specific concern)…"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.6)',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 'var(--radius)',
            fontSize: 13, color: 'var(--text)',
            resize: 'vertical', fontFamily: 'inherit',
            marginBottom: 14,
          }}
        />

        {saveNote && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{saveNote}</div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={!selected || saving}
            style={{ opacity: !selected || saving ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : 'Save Response'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Mark as Done Modal (Responses tab)
// ---------------------------------------------------------------------------

function ActionModal({ response, onClose, onActioned }) {
  const [note, setNote]     = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  async function handleConfirm() {
    setSaving(true);
    setError('');
    try {
      await api.patch(`/followup/responses/${response.id}/action`, { action_note: note });
      onActioned(response.id);
    } catch (err) {
      setError(err.response?.data?.detail || 'Error saving');
    } finally {
      setSaving(false);
    }
  }

  const badge = responseBadge(response.response_type);

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--glass-strong)',
        backdropFilter: 'blur(32px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-xl)',
        padding: 28, width: 440,
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>
              Mark as Done
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
              {response.patient_name}
              {response.patient_mobile && (
                <span style={{ color: 'var(--text-hint)', marginLeft: 8 }}>{response.patient_mobile}</span>
              )}
            </div>
            <div style={{ marginTop: 6 }}>
              <span className={`badge ${badge.cls}`}>{badge.label}</span>
            </div>
            {response.notes && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
                Patient note: "{response.notes}"
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-hint)', lineHeight: 1 }}
          >×</button>
        </div>

        {/* Action note textarea */}
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
          Action taken (optional)
        </label>
        <textarea
          placeholder="e.g. Called patient, referred to Dr. Hoque…"
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '10px 12px',
            background: 'rgba(255,255,255,0.6)',
            border: '1px solid rgba(0,0,0,0.1)',
            borderRadius: 'var(--radius)',
            fontSize: 13, color: 'var(--text)',
            resize: 'vertical', fontFamily: 'inherit',
            marginBottom: 14,
          }}
        />

        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 10 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleConfirm}
            disabled={saving}
            style={{ opacity: saving ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : 'Mark Actioned'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Message Detail Modal
// ---------------------------------------------------------------------------

function MessageDetailModal({ message, onClose }) {
  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        background: 'var(--glass-strong)',
        backdropFilter: 'blur(32px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-xl)',
        padding: 28, width: 480,
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>Message Preview</div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-hint)' }}
          >×</button>
        </div>

        <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className={`badge badge-${message.language === 'AS' ? 'accent' : 'info'}`}>
            {message.language === 'AS' ? 'Assamese' : 'English'}
          </span>
          <span className={`badge ${statusBadgeClass(message.status)}`}>{message.status}</span>
          <span style={{ fontSize: 12, color: 'var(--text-hint)', marginLeft: 4 }}>
            {message.recipient_mobile}
          </span>
        </div>

        <div style={{
          background: 'rgba(255,255,255,0.5)',
          border: '1px solid rgba(0,0,0,0.08)',
          borderRadius: 'var(--radius)',
          padding: '14px 16px',
          fontSize: 14, lineHeight: 1.6,
          color: 'var(--text)', marginBottom: 12,
          whiteSpace: 'pre-wrap',
        }}>
          {message.message_body}
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-hint)', marginBottom: 16 }}>
          Scheduled: {fmtDateTime(message.scheduled_at)}
          {message.sent_at && ` · Sent: ${fmtDateTime(message.sent_at)}`}
        </div>

        {message.error_message && (
          <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 12 }}>
            Error: {message.error_message}
          </div>
        )}

        <div style={{ textAlign: 'right' }}>
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// ComposePanel — slide-in right-side panel for composing a follow-up message
// ---------------------------------------------------------------------------

/**
 * Shown when the pharmacist clicks "Compose Message" on a pending follow-up.
 *
 * What it does:
 *  1. Calls POST /followup/compose-message to pre-fill EN + AS textareas.
 *  2. Lets the pharmacist edit the text freely before sending.
 *  3. On Send: calls POST /followup/{id}/send, then marks the row as sent.
 *
 * The "generated_by" field comes back from the API. Right now it is always
 * "template". When Ollama is wired up in Phase 4, it will say "ollama" and
 * we can update this label without touching anything else.
 */
function ComposePanel({ schedule, onClose, onSent }) {
  const [english,      setEnglish]      = useState('');
  const [assamese,     setAssamese]     = useState('');
  const [loading,      setLoading]      = useState(true);
  const [sending,      setSending]      = useState(false);
  const [generatedBy,  setGeneratedBy]  = useState('template');
  const [tagUsed,      setTagUsed]      = useState(null);
  const [error,        setError]        = useState('');
  const [confirming,   setConfirming]   = useState(false);

  // Fetch composed message from backend
  const fetchComposed = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.post('/followup/compose-message', {
        patient_id   : schedule.patient_id,
        follow_up_day: schedule.day_number,
        language     : 'both',
      });
      setEnglish(data.english || '');
      setAssamese(data.assamese || '');
      setGeneratedBy(data.generated_by || 'template');
      setTagUsed(data.tag_used || null);
    } catch (err) {
      setError(err.response?.data?.detail || 'Could not load template');
    } finally {
      setLoading(false);
    }
  }, [schedule.patient_id, schedule.day_number]);

  useEffect(() => { fetchComposed(); }, [fetchComposed]);

  async function handleSend() {
    if (!confirming) {
      // First click: show confirmation state
      setConfirming(true);
      return;
    }
    // Second click: actually send
    setSending(true);
    setError('');
    try {
      await api.post(`/followup/${schedule.id}/send`, {
        message_en: english || null,
        message_as: assamese || null,
        channel   : 'SMS',
      });
      onSent(schedule.id);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to send');
      setSending(false);
      setConfirming(false);
    }
  }

  const sourceLabel = generatedBy === 'ollama'
    ? 'Generated by AI'
    : 'Message from template';

  return createPortal(
    <>
      {/* Backdrop (clicking it closes the panel) */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 8000,
          background: 'rgba(0,0,0,0.25)',
        }}
      />

      {/* Panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 8001,
        width: 480, maxWidth: '95vw',
        background: 'var(--glass-strong)',
        backdropFilter: 'blur(32px)',
        borderLeft: '1px solid var(--glass-border)',
        boxShadow: '-8px 0 40px rgba(0,0,0,0.15)',
        display: 'flex', flexDirection: 'column',
        animation: 'slideInRight 0.25s ease',
      }}>
        {/* ── Header ─────────────────────────────────── */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid rgba(0,0,0,0.06)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
                Compose Message
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>
                {schedule.patient_name}
                {schedule.patient_mobile && (
                  <span style={{ color: 'var(--text-hint)', marginLeft: 8 }}>
                    {schedule.patient_mobile}
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: 22, color: 'var(--text-hint)', lineHeight: 1, padding: 0,
              }}
            >×</button>
          </div>

          {/* Day badge + tags */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
            <span className={`badge ${dayBadgeClass(schedule.day_number)}`}>
              Day {schedule.day_number} follow-up
            </span>
            {schedule.patient_tags && schedule.patient_tags.map(tag => (
              <span key={tag} className="badge badge-neutral" style={{ fontSize: 10 }}>
                {tag}
              </span>
            ))}
            {tagUsed && (
              <span className="badge badge-accent" style={{ fontSize: 10 }}>
                {tagUsed} template
              </span>
            )}
          </div>
        </div>

        {/* ── Textareas ───────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px' }}>
          {loading ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13, paddingTop: 12 }}>
              Loading template…
            </div>
          ) : (
            <>
              {/* English */}
              <label style={{
                display: 'block', fontSize: 12, fontWeight: 600,
                color: 'var(--text-secondary)', marginBottom: 6,
              }}>
                English Message
                <span style={{ float: 'right' }}>
                  <span className="badge badge-info" style={{ fontSize: 10 }}>EN</span>
                </span>
              </label>
              <textarea
                value={english}
                onChange={e => setEnglish(e.target.value)}
                rows={5}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.7)',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: 'var(--radius)',
                  fontSize: 13, lineHeight: 1.6, color: 'var(--text)',
                  resize: 'vertical', fontFamily: 'inherit',
                  marginBottom: 16,
                }}
              />

              {/* Assamese */}
              <label style={{
                display: 'block', fontSize: 12, fontWeight: 600,
                color: 'var(--text-secondary)', marginBottom: 6,
              }}>
                Assamese Message
                <span style={{ float: 'right' }}>
                  <span className="badge badge-accent" style={{ fontSize: 10 }}>AS</span>
                </span>
              </label>
              <textarea
                value={assamese}
                onChange={e => setAssamese(e.target.value)}
                rows={5}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.7)',
                  border: '1px solid rgba(0,0,0,0.12)',
                  borderRadius: 'var(--radius)',
                  fontSize: 13, lineHeight: 1.6, color: 'var(--text)',
                  resize: 'vertical', fontFamily: 'inherit',
                  marginBottom: 8,
                }}
              />

              {/* Source label */}
              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginBottom: 8 }}>
                {sourceLabel} · Day {schedule.day_number} follow-up
              </div>

              {/* Refresh button */}
              <button
                className="btn-secondary"
                onClick={fetchComposed}
                style={{ fontSize: 12, padding: '6px 12px' }}
              >
                ↺ Refresh from template
              </button>
            </>
          )}

          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 13, marginTop: 12 }}>{error}</div>
          )}
        </div>

        {/* ── Footer / Send button ────────────────────── */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid rgba(0,0,0,0.06)',
          flexShrink: 0,
        }}>
          {confirming && !sending && (
            <div style={{
              background: 'var(--warn-bg)', border: '1px solid rgba(217,119,6,0.25)',
              borderRadius: 'var(--radius)', padding: '10px 14px',
              fontSize: 12, color: 'var(--warn)', marginBottom: 12,
            }}>
              Send WhatsApp/SMS to {schedule.patient_mobile || 'this patient'}?
              Click Send again to confirm.
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="btn-secondary"
              onClick={() => { setConfirming(false); onClose(); }}
              style={{ flex: 1 }}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={handleSend}
              disabled={loading || sending || (!english.trim() && !assamese.trim())}
              style={{
                flex: 2,
                opacity: (loading || sending || (!english.trim() && !assamese.trim())) ? 0.6 : 1,
                background: confirming
                  ? 'linear-gradient(135deg, var(--ok), #34d399)'
                  : undefined,
              }}
            >
              {sending ? 'Queuing…' : confirming ? 'Confirm — Send Now' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}


// ---------------------------------------------------------------------------
// Tab 1 — Due Today
// ---------------------------------------------------------------------------

function DueTodayTab({ onResponseRecorded }) {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState(null);   // schedule for Record Response modal
  const [composing, setComposing] = useState(null);   // schedule for ComposePanel
  const [toast, setToast]         = useState('');

  const load = useCallback(async () => {
    try {
      // Use the new /pending endpoint which includes overdue schedules + tags
      const { data } = await api.get('/followup/pending');
      setSchedules(data);
    } catch {
      // silently ignore — backend may not be up yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Auto-refresh every 60 seconds
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  function handleSaved(scheduleId) {
    // Remove the responded schedule from the list
    setSchedules(prev => prev.filter(s => s.id !== scheduleId));
    setSelected(null);
    setToast('Response recorded');
    setTimeout(() => setToast(''), 3500);
    onResponseRecorded();   // trigger stats refresh
  }

  function handleSent(scheduleId) {
    // Mark the row as sent (remove from pending list)
    setSchedules(prev => prev.filter(s => s.id !== scheduleId));
    setComposing(null);
    setToast(`Message queued for ${schedules.find(s => s.id === scheduleId)?.patient_name ?? 'patient'}`);
    setTimeout(() => setToast(''), 3500);
    onResponseRecorded();   // refresh stats bar
  }

  if (loading) {
    return <div style={{ color: 'var(--text-secondary)', padding: 24 }}>Loading…</div>;
  }

  // The /pending endpoint returns BOTH today's follow-ups and past-due ones.
  // Split them so "Due Today" shows only genuinely-today items (days_overdue===0,
  // matching the stats badge) and overdue items get their own clearly-labelled
  // section instead of inflating the Due Today count.
  const dueToday = schedules.filter(s => s.days_overdue === 0);
  const overdue  = schedules.filter(s => s.days_overdue > 0);

  const renderRow = (s) => (
            <div key={s.id} style={{
              background: 'var(--glass)',
              backdropFilter: 'blur(24px)',
              border: s.days_overdue > 0
                ? '1px solid rgba(225,29,72,0.3)'   // red tint for overdue
                : '1px solid var(--glass-border)',
              borderRadius: 'var(--radius-lg)',
              padding: '16px 20px',
              display: 'flex', alignItems: 'center', gap: 16,
              animation: 'fadeUp 0.4s ease',
            }}>
              {/* Day badge */}
              <div style={{ flexShrink: 0, textAlign: 'center', minWidth: 60 }}>
                <span className={`badge ${dayBadgeClass(s.follow_up_day)}`}>
                  DAY {s.follow_up_day}
                </span>
                {s.days_overdue > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 3, fontWeight: 600 }}>
                    {s.days_overdue}d overdue
                  </div>
                )}
              </div>

              {/* Patient info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)' }}>
                  {s.patient_name}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {s.patient_phone || 'No mobile'} · Invoice {s.invoice_number}
                </div>
                {/* Tags */}
                {s.patient_tags && s.patient_tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {s.patient_tags.slice(0, 3).map(tag => (
                      <span key={tag} className="badge badge-neutral" style={{ fontSize: 9 }}>
                        {tag}
                      </span>
                    ))}
                    {s.patient_tags.length > 3 && (
                      <span style={{ fontSize: 9, color: 'var(--text-hint)' }}>
                        +{s.patient_tags.length - 3} more
                      </span>
                    )}
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2 }}>
                  Due: {fmtDate(s.due_date)}
                  {s.last_invoice_date && (
                    <span style={{ marginLeft: 8 }}>
                      · Last purchase: {fmtDate(s.last_invoice_date)}
                    </span>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div style={{ flexShrink: 0, display: 'flex', gap: 8 }}>
                <button
                  className="btn-secondary"
                  onClick={() => setComposing({
                    // Normalize pending fields → ComposePanel uses day_number/patient_mobile/patient_id
                    id            : s.id,
                    patient_id    : s.patient_id,
                    patient_name  : s.patient_name,
                    patient_mobile: s.patient_phone,
                    patient_tags  : s.patient_tags,
                    day_number    : s.follow_up_day,
                    invoice_number: s.invoice_number,
                  })}
                  style={{ fontSize: 12, padding: '7px 13px' }}
                >
                  Compose
                </button>
                <button
                  className="btn-primary"
                  onClick={() => setSelected({
                    id            : s.id,
                    patient_id    : s.patient_id,
                    patient_name  : s.patient_name,
                    patient_mobile: s.patient_phone,
                    day_number    : s.follow_up_day,
                    invoice_number: s.invoice_number,
                  })}
                  style={{ fontSize: 12, padding: '7px 13px' }}
                >
                  Record Response
                </button>
              </div>
            </div>
  );

  const sectionHeader = (title, count, color) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      margin: '4px 0 2px', fontSize: 12, fontWeight: 700,
      letterSpacing: '0.04em', textTransform: 'uppercase', color,
    }}>
      {title}
      <span className="badge" style={{
        background: 'rgba(0,0,0,0.06)', color, fontSize: 11, fontWeight: 700,
      }}>{count}</span>
    </div>
  );

  return (
    <>
      <Toast message={toast} />

      {schedules.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 48,
          background: 'var(--glass)',
          backdropFilter: 'blur(24px)',
          border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)',
        }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>✅</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            All caught up!
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            No follow-ups are due today. Check back tomorrow.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Due Today — only genuinely-today items (count matches the stat badge) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sectionHeader('Due Today', dueToday.length, 'var(--danger)')}
            {dueToday.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '4px 2px' }}>
                Nothing due today. 🎉
              </div>
            ) : dueToday.map(renderRow)}
          </div>

          {/* Overdue — past-due follow-ups, kept separate so they aren't lost */}
          {overdue.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {sectionHeader('Overdue', overdue.length, 'var(--warn)')}
              {overdue.map(renderRow)}
            </div>
          )}
        </div>
      )}

      {/* Record Response modal */}
      {selected && (
        <RecordResponseModal
          schedule={selected}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Compose Message panel */}
      {composing && (
        <ComposePanel
          schedule={composing}
          onClose={() => setComposing(null)}
          onSent={handleSent}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 2 — Responses
// ---------------------------------------------------------------------------

function ResponseSummaryBar({ summary }) {
  const cards = [
    { label: 'Total',          value: summary.total_responses, color: 'var(--accent)' },
    { label: 'Feeling Better', value: summary.feeling_better,  color: 'var(--ok)' },
    { label: 'Still Same',     value: summary.still_same,      color: 'var(--warn)' },
    { label: 'Needs Doctor',   value: summary.needs_doctor,    color: 'var(--danger)' },
    { label: 'Call Me',        value: summary.call_me,         color: 'var(--info)' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 20 }}>
      {cards.map(c => (
        <div key={c.label} style={{
          background: 'var(--glass)',
          backdropFilter: 'blur(24px)',
          border: '1px solid var(--glass-border)',
          borderTop: `3px solid ${c.color}`,
          borderRadius: 'var(--radius)',
          padding: '12px 14px',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value ?? 0}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}

function ResponsesTab({ onActionTaken }) {
  const navigate = useNavigate();

  const [summary, setSummary] = useState({
    total_responses: 0, feeling_better: 0, still_same: 0,
    needs_doctor: 0, call_me: 0, pending_action: 0,
  });
  const [pending, setPending]         = useState([]);
  const [allResponses, setAllResponses] = useState([]);
  const [loadingPending, setLoadingPending] = useState(true);
  const [loadingAll, setLoadingAll]   = useState(true);
  const [page, setPage]               = useState(1);
  const limit = 20;
  const [actionTarget, setActionTarget] = useState(null);  // response shown in ActionModal
  const [toast, setToast]             = useState('');

  async function loadSummaryAndPending() {
    try {
      const [summaryRes, pendingRes] = await Promise.all([
        api.get('/followup/responses/summary'),
        api.get('/followup/responses/pending'),
      ]);
      setSummary(summaryRes.data);
      setPending(pendingRes.data);
    } catch { /* ignore */ }
    finally { setLoadingPending(false); }
  }

  async function loadAll(p) {
    setLoadingAll(true);
    try {
      const { data } = await api.get('/followup/responses', { params: { page: p, limit } });
      setAllResponses(data);
    } catch { /* ignore */ }
    finally { setLoadingAll(false); }
  }

  useEffect(() => {
    loadSummaryAndPending();
  }, []);

  useEffect(() => {
    loadAll(page);
  }, [page]);

  function handleActioned(responseId) {
    // Remove the actioned response from the pending list immediately
    setPending(prev => prev.filter(r => r.id !== responseId));
    setActionTarget(null);
    setToast('Marked as done');
    setTimeout(() => setToast(''), 3500);
    onActionTaken();  // tell Layout.jsx to refresh its badge
    // Refresh summary and the full list to reflect the new actioned_at status
    loadSummaryAndPending();
    loadAll(page);
  }

  return (
    <>
      <Toast message={toast} />

      {/* 5-card summary bar */}
      <ResponseSummaryBar summary={summary} />

      {/* ── Needs Action Section ─────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
        }}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
            Needs Action
          </h3>
          {summary.pending_action > 0 && (
            <span style={{
              background: 'var(--danger)', color: '#fff',
              fontSize: 11, fontWeight: 700,
              borderRadius: 20, padding: '2px 8px',
            }}>
              {summary.pending_action}
            </span>
          )}
        </div>

        {loadingPending ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</div>
        ) : pending.length === 0 ? (
          <div style={{
            padding: '20px 24px',
            background: 'var(--glass)',
            backdropFilter: 'blur(24px)',
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius-lg)',
            textAlign: 'center',
            fontSize: 13, color: 'var(--text-secondary)',
          }}>
            No pending actions — all NEED_DOCTOR and CALL_ME responses have been handled.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pending.map(r => {
              const badge = responseBadge(r.response_type);
              return (
                <div key={r.id} style={{
                  background: 'var(--glass)',
                  backdropFilter: 'blur(24px)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: 'var(--radius-lg)',
                  padding: '14px 18px',
                  display: 'flex', alignItems: 'center', gap: 16,
                  animation: 'fadeUp 0.4s ease',
                }}>
                  {/* Response type badge */}
                  <div style={{ flexShrink: 0, minWidth: 100 }}>
                    <span className={`badge ${badge.cls}`}>{badge.label}</span>
                  </div>

                  {/* Patient info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{ fontWeight: 700, fontSize: 14, color: 'var(--accent)', cursor: 'pointer' }}
                      onClick={() => navigate(`/patients?highlight=${r.patient_id}`)}
                    >
                      {r.patient_name}
                    </div>
                    {r.patient_mobile && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 1 }}>
                        {r.patient_mobile}
                      </div>
                    )}
                    {r.notes && (
                      <div style={{ fontSize: 12, color: 'var(--text-hint)', marginTop: 2, fontStyle: 'italic' }}>
                        "{truncate(r.notes, 80)}"
                      </div>
                    )}
                  </div>

                  {/* Date */}
                  <div style={{ fontSize: 12, color: 'var(--text-hint)', flexShrink: 0, textAlign: 'right' }}>
                    {fmtDateTime(r.created_at)}
                  </div>

                  {/* Mark as Done button */}
                  <button
                    className="btn-primary"
                    onClick={() => setActionTarget(r)}
                    style={{ flexShrink: 0, fontSize: 12, padding: '7px 14px' }}
                  >
                    Mark as Done
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── All Responses Table ────────────────────────────────────── */}
      <div>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
          All Responses
        </h3>

        {loadingAll ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading…</div>
        ) : (
          <div style={{
            background: 'var(--glass)',
            backdropFilter: 'blur(24px)',
            border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                  {['Patient', 'Response', 'Date', 'Notes', 'Status'].map(h => (
                    <th key={h} style={{
                      padding: '10px 14px', textAlign: 'left',
                      fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                      letterSpacing: '0.06em', color: 'var(--text-hint)',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allResponses.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: 'var(--text-hint)' }}>
                      No responses recorded yet
                    </td>
                  </tr>
                ) : allResponses.map((r, i) => {
                  const badge      = responseBadge(r.response_type);
                  const isActioned = !!r.actioned_at;
                  const needsAction = (r.response_type === 'NEED_DOCTOR' || r.response_type === 'CALL_ME') && !isActioned;

                  return (
                    <tr key={r.id} style={{
                      borderBottom: i < allResponses.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)',
                    }}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{r.patient_name}</div>
                        {r.patient_mobile && (
                          <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{r.patient_mobile}</div>
                        )}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span className={`badge ${badge.cls}`}>{badge.label}</span>
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                        {fmtDateTime(r.created_at)}
                      </td>
                      <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)', maxWidth: 200 }}>
                        {truncate(r.notes, 50) || '—'}
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        {needsAction ? (
                          <span className="badge badge-warn">Pending Action</span>
                        ) : isActioned ? (
                          <div>
                            <span className="badge badge-ok">Done</span>
                            {r.action_note && (
                              <div style={{ fontSize: 10, color: 'var(--text-hint)', marginTop: 2 }}>
                                {truncate(r.action_note, 40)}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="badge badge-neutral">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {allResponses.length === limit && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
            {page > 1 && (
              <button className="btn-secondary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => setPage(p => p - 1)}>
                ← Previous
              </button>
            )}
            <button className="btn-secondary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => setPage(p => p + 1)}>
              Next →
            </button>
          </div>
        )}
        {page > 1 && allResponses.length < limit && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
            <button className="btn-secondary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => setPage(p => p - 1)}>
              ← Previous
            </button>
          </div>
        )}
      </div>

      {/* Mark as Done modal */}
      {actionTarget && (
        <ActionModal
          response={actionTarget}
          onClose={() => setActionTarget(null)}
          onActioned={handleActioned}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Tab 3 — All Schedules
// ---------------------------------------------------------------------------

function AllSchedulesTab() {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState('');     // '' = all, or status string
  const [cancelling, setCancelling] = useState(null); // schedule id being cancelled

  async function load(status) {
    setLoading(true);
    try {
      const params = {};
      if (status) params.status = status;
      const { data } = await api.get('/followup/schedules', { params });
      setSchedules(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(filter); }, [filter]);

  async function handleCancel(schedule) {
    if (!window.confirm(`Cancel follow-up Day ${schedule.day_number} for ${schedule.patient_name}?`)) return;
    setCancelling(schedule.id);
    try {
      await api.post(`/followup/schedules/${schedule.id}/cancel`, { reason: 'Manually cancelled by staff' });
      load(filter);
    } catch (err) {
      alert(err.response?.data?.detail || 'Failed to cancel');
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['', 'PENDING', 'COMPLETED', 'CANCELLED'].map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
              background: filter === s ? 'var(--accent)' : 'rgba(255,255,255,0.5)',
              color: filter === s ? '#fff' : 'var(--text-secondary)',
              border: `1px solid ${filter === s ? 'var(--accent)' : 'rgba(0,0,0,0.1)'}`,
            }}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)' }}>Loading…</div>
      ) : (
        <div style={{
          background: 'var(--glass)',
          backdropFilter: 'blur(24px)',
          border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                {['Patient', 'Day', 'Scheduled Date', 'Invoice', 'Status', 'Action'].map(h => (
                  <th key={h} style={{
                    padding: '10px 14px', textAlign: 'left',
                    fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.06em', color: 'var(--text-hint)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schedules.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-hint)' }}>
                    No schedules found
                  </td>
                </tr>
              ) : schedules.map((s, i) => (
                <tr key={s.id} style={{
                  borderBottom: i < schedules.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)',
                }}>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{s.patient_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-hint)' }}>{s.patient_mobile || '—'}</div>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`badge ${dayBadgeClass(s.day_number)}`}>Day {s.day_number}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 13, color: 'var(--text)' }}>
                    {fmtDate(s.scheduled_date)}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {s.invoice_number}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`badge ${statusBadgeClass(s.status)}`}>{s.status}</span>
                    {s.cancelled_reason && (
                      <div style={{ fontSize: 10, color: 'var(--text-hint)', marginTop: 2 }}>
                        {s.cancelled_reason}
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    {s.status === 'PENDING' && (
                      <button
                        className="btn-danger"
                        onClick={() => handleCancel(s)}
                        disabled={cancelling === s.id}
                        style={{ fontSize: 12, padding: '5px 12px' }}
                      >
                        {cancelling === s.id ? '…' : 'Cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 4 — Message Queue
// ---------------------------------------------------------------------------

function MessageQueueTab() {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState('');
  const [selected, setSelected] = useState(null);   // message for detail modal

  async function load(status) {
    setLoading(true);
    try {
      const params = {};
      if (status) params.status = status;
      const { data } = await api.get('/followup/messages', { params });
      setMessages(data);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(filter); }, [filter]);

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['', 'QUEUED', 'SENT', 'CANCELLED', 'FAILED'].map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
              cursor: 'pointer',
              background: filter === s ? 'var(--accent)' : 'rgba(255,255,255,0.5)',
              color: filter === s ? '#fff' : 'var(--text-secondary)',
              border: `1px solid ${filter === s ? 'var(--accent)' : 'rgba(0,0,0,0.1)'}`,
            }}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {/* Provider notice */}
      <div style={{
        background: 'var(--info-bg)',
        border: '1px solid rgba(2,132,199,0.2)',
        borderRadius: 'var(--radius)',
        padding: '10px 14px',
        fontSize: 12, color: 'var(--info)',
        marginBottom: 16,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span>ℹ️</span>
        <span>
          Messages are queued and ready to send. Actual delivery requires an SMS/WhatsApp
          provider to be connected (coming in Phase 3.2).
        </span>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)' }}>Loading…</div>
      ) : (
        <div style={{
          background: 'var(--glass)',
          backdropFilter: 'blur(24px)',
          border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
                {['Patient', 'Mobile', 'Lang', 'Channel', 'Scheduled', 'Status', 'Message'].map(h => (
                  <th key={h} style={{
                    padding: '10px 14px', textAlign: 'left',
                    fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.06em', color: 'var(--text-hint)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {messages.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-hint)' }}>
                    No messages found
                  </td>
                </tr>
              ) : messages.map((m, i) => (
                <tr
                  key={m.id}
                  onClick={() => setSelected(m)}
                  style={{
                    borderBottom: i < messages.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                    background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.05)'}
                  onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)'}
                >
                  <td style={{ padding: '10px 14px', fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                    {m.patient_name}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {m.recipient_mobile || '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`badge ${m.language === 'AS' ? 'badge-accent' : 'badge-info'}`}>
                      {m.language}
                    </span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {m.channel}
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {fmtDateTime(m.scheduled_at)}
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span className={`badge ${statusBadgeClass(m.status)}`}>{m.status}</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)', maxWidth: 200 }}>
                    {truncate(m.message_body, 60)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <MessageDetailModal message={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 5 — Refill Reminders
// ---------------------------------------------------------------------------

/**
 * Extract the medicine name from a refill reminder message body.
 * EN template: "Dear {name}, your {MEDICINE} supply may be running low…"
 * Regex pulls out whatever sits between "your " and " supply may be".
 */
function extractMedicine(msgBody) {
  const m = (msgBody || '').match(/your (.+?) supply may be running low/i);
  return m ? m[1] : '—';
}

/**
 * How many calendar days until scheduledAt?
 * Returns 0 if it's today or already past.
 */
function daysUntil(scheduledAt) {
  const msLeft = new Date(scheduledAt) - Date.now();
  return Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
}

function DaysUntilBadge({ scheduledAt }) {
  const days = daysUntil(scheduledAt);
  if (days === 0) return <span className="badge badge-danger">Today</span>;
  if (days <= 3)  return <span className="badge badge-warn">{days} days</span>;
  return               <span className="badge badge-info">{days} days</span>;
}

function RefillRemindersTab() {
  const [upcoming, setUpcoming] = useState([]);
  const [all,      setAll]      = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(null);   // message shown in detail modal

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      api.get('/followup/refills/upcoming'),
      api.get('/followup/refills'),
    ])
      .then(([upRes, allRes]) => {
        if (!active) return;
        setUpcoming(upRes.data);
        setAll(allRes.data);
      })
      .catch(() => {/* backend may not be running */})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const totalQueued = all.filter(m => m.status === 'QUEUED').length;

  const thStyle = {
    padding: '10px 14px', textAlign: 'left',
    fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '0.06em', color: 'var(--text-hint)',
  };

  if (loading) {
    return <div style={{ color: 'var(--text-secondary)', padding: 24 }}>Loading…</div>;
  }

  return (
    <div>
      {/* ── Stat cards ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Upcoming (7 days)', value: upcoming.length, color: 'var(--warn)' },
          { label: 'Total Queued',      value: totalQueued,     color: 'var(--accent)' },
        ].map(c => (
          <div key={c.label} style={{
            background: 'var(--glass)',
            backdropFilter: 'blur(24px)',
            border: '1px solid var(--glass-border)',
            borderTop: `3px solid ${c.color}`,
            borderRadius: 'var(--radius)',
            padding: '16px 20px',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: 30, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* ── Upcoming in next 7 days ─────────────────────────────────── */}
      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
        Reminders in Next 7 Days
      </h3>
      <div style={{
        background: 'var(--glass)',
        backdropFilter: 'blur(24px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        marginBottom: 28,
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              {['Patient', 'Mobile', 'Medicine', 'Reminder Date', 'Days Until', 'Language'].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {upcoming.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-hint)' }}>
                  No refill reminders in the next 7 days
                </td>
              </tr>
            ) : upcoming.map((m, i) => (
              <tr
                key={m.id}
                onClick={() => setSelected(m)}
                style={{
                  borderBottom: i < upcoming.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.05)'}
                onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)'}
              >
                <td style={{ padding: '10px 14px', fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                  {m.patient_name}
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {m.recipient_mobile || '—'}
                </td>
                <td style={{ padding: '10px 14px', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
                  {extractMedicine(m.message_body)}
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {fmtDate(m.scheduled_at)}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <DaysUntilBadge scheduledAt={m.scheduled_at} />
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span className={`badge ${m.language === 'AS' ? 'badge-accent' : 'badge-info'}`}>
                    {m.language === 'AS' ? 'Assamese' : 'English'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── All Reminders ───────────────────────────────────────────── */}
      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
        All Reminders
      </h3>
      <div style={{
        background: 'var(--glass)',
        backdropFilter: 'blur(24px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
      }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
              {['Patient', 'Mobile', 'Medicine', 'Reminder Date', 'Days Until', 'Language', 'Status'].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {all.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-hint)' }}>
                  No refill reminders yet. They are created automatically when a
                  chronic or prescription patient makes a purchase.
                </td>
              </tr>
            ) : all.map((m, i) => (
              <tr
                key={m.id}
                onClick={() => setSelected(m)}
                style={{
                  borderBottom: i < all.length - 1 ? '1px solid rgba(0,0,0,0.04)' : 'none',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.05)'}
                onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.15)'}
              >
                <td style={{ padding: '10px 14px', fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                  {m.patient_name}
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {m.recipient_mobile || '—'}
                </td>
                <td style={{ padding: '10px 14px', fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
                  {extractMedicine(m.message_body)}
                </td>
                <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {fmtDate(m.scheduled_at)}
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <DaysUntilBadge scheduledAt={m.scheduled_at} />
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span className={`badge ${m.language === 'AS' ? 'badge-accent' : 'badge-info'}`}>
                    {m.language === 'AS' ? 'Assamese' : 'English'}
                  </span>
                </td>
                <td style={{ padding: '10px 14px' }}>
                  <span className={`badge ${statusBadgeClass(m.status)}`}>{m.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Message detail modal — reused from Message Queue tab */}
      {selected && (
        <MessageDetailModal message={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

// Tab order: Due Today (0) | Responses (1) | All Schedules (2) | Message Queue (3) | Refill Reminders (4)
const TABS = ['Due Today', 'Responses', 'All Schedules', 'Message Queue', 'Refill Reminders'];

export default function FollowUps() {
  const [tab, setTab]     = useState(0);
  const [stats, setStats] = useState({
    total_pending: 0, due_today: 0, total_sent: 0, total_cancelled: 0,
  });
  const [pendingAction, setPendingAction] = useState(0);

  const loadStats = useCallback(async () => {
    try {
      const { data } = await api.get('/followup/stats');
      setStats(data);
    } catch { /* ignore */ }
  }, []);

  // Separate load for pending_action count (used by Responses tab badge)
  const loadPendingAction = useCallback(async () => {
    try {
      const { data } = await api.get('/followup/responses/summary');
      setPendingAction(data.pending_action ?? 0);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadStats();
    loadPendingAction();
  }, [loadStats, loadPendingAction]);

  // Called by ResponsesTab after a response is actioned
  function handleActionTaken() {
    loadPendingAction();
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', margin: 0 }}>
          Patient Follow-Ups
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
          Track and record check-ins with patients after their purchase.
        </p>
      </div>

      {/* Stats bar (schedule counts) */}
      <StatsBar stats={stats} />

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 2, marginBottom: 20,
        background: 'rgba(255,255,255,0.35)',
        backdropFilter: 'blur(16px)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius)',
        padding: 4,
      }}>
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setTab(i)}
            style={{
              flex: 1, padding: '9px 16px',
              background: tab === i
                ? 'linear-gradient(135deg, var(--accent), #8b5cf6)'
                : 'transparent',
              color: tab === i ? '#fff' : 'var(--text-secondary)',
              border: 'none', borderRadius: 7,
              fontWeight: tab === i ? 700 : 500,
              fontSize: 13, cursor: 'pointer',
              transition: 'all 0.15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            }}
          >
            {t}
            {/* Due Today badge */}
            {i === 0 && stats.due_today > 0 && (
              <span style={{
                background: tab === 0 ? 'rgba(255,255,255,0.3)' : '#ef4444',
                color: '#fff', fontSize: 9, fontWeight: 700,
                borderRadius: 20, padding: '1px 6px',
              }}>
                {stats.due_today}
              </span>
            )}
            {/* Responses tab badge — shows pending action count */}
            {i === 1 && pendingAction > 0 && (
              <span style={{
                background: tab === 1 ? 'rgba(255,255,255,0.3)' : '#ef4444',
                color: '#fff', fontSize: 9, fontWeight: 700,
                borderRadius: 20, padding: '1px 6px',
              }}>
                {pendingAction}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 0 && <DueTodayTab onResponseRecorded={loadStats} />}
      {tab === 1 && <ResponsesTab onActionTaken={handleActionTaken} />}
      {tab === 2 && <AllSchedulesTab />}
      {tab === 3 && <MessageQueueTab />}
      {tab === 4 && <RefillRemindersTab />}
    </div>
  );
}
