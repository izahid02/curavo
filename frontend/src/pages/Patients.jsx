/**
 * Patients Screen — Phase 1, Step 4
 *
 * Two tabs:
 *   TAB 1 — Patient List  : search, table, row-click → detail modal
 *   TAB 2 — Register      : form to add a new patient
 *
 * Patient Detail Modal (opens when a row is clicked):
 *   View mode  — all info, departments badges, tag pills, purchase history
 *   Edit mode  — same form fields pre-filled, Save / Cancel
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import PatientSummaryCard from '../components/patients/PatientSummaryCard';
import { formatDateOnly } from '../lib/datetime';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Format a date/datetime as "29 May 2026" in IST (see lib/datetime.js). */
const fmtDate = formatDateOnly;
const fmtDateTime = formatDateOnly;

/** Format money as ₹1,234.56 */
function inr(n) {
  return '₹' + Number(n).toLocaleString('en-IN', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

const BLANK_FORM = {
  name: '', mobile: '', age: '', gender: 'M',
  patient_type: 'PRESCRIPTION', preferred_language: 'BOTH',
  email: '', address: '',
  department_ids: [], tag_ids: [],
};

// ─── Main component ───────────────────────────────────────────────────────────

export default function Patients() {
  // ── Tab navigation ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('list');

  // ── Shared lookup data (fetched once on mount) ──────────────────────────────
  const [departments, setDepartments] = useState([]);
  const [allTags,     setAllTags]     = useState([]);

  // ── Patient list state ──────────────────────────────────────────────────────
  const [query,       setQuery]       = useState('');
  const [patients,    setPatients]    = useState([]);
  const [listLoading, setListLoading] = useState(false);

  // ── Patient detail modal ────────────────────────────────────────────────────
  // modalPatient = the PatientOut object fetched from GET /api/patients/{id}
  // modalHistory = list of InvoiceOut objects for this patient's purchases
  const [modalPatient,  setModalPatient]  = useState(null);
  const [modalHistory,  setModalHistory]  = useState([]);
  const [modalLoading,  setModalLoading]  = useState(false);
  const [modalMode,     setModalMode]     = useState('view'); // 'view' | 'edit'
  const [editForm,      setEditForm]      = useState(BLANK_FORM);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError,     setEditError]     = useState('');

  // Prescription history for the open patient
  const [rxList,          setRxList]          = useState([]);
  const [deletingRxId,    setDeletingRxId]    = useState(null);  // which rx is being deleted
  const [rxDeleteConfirm, setRxDeleteConfirm] = useState(null);  // rx object awaiting confirm

  // ── Register form state ─────────────────────────────────────────────────────
  const [regForm,       setRegForm]       = useState(BLANK_FORM);
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regSuccess,    setRegSuccess]    = useState('');
  const [regError,      setRegError]      = useState('');
  // Set when the backend rejects a duplicate phone (409) — holds the existing
  // patient so we can offer "Select Existing" / "Register Anyway".
  const [dupPatient,    setDupPatient]    = useState(null);

  // ── Fetch departments and tags on mount ─────────────────────────────────────
  useEffect(() => {
    async function fetchMeta() {
      try {
        const [dRes, tRes] = await Promise.all([
          api.get('/inventory/departments'),
          api.get('/patients/tags'),
        ]);
        setDepartments(dRes.data);
        setAllTags(tRes.data);
      } catch (err) {
        console.error('Failed to load departments/tags', err);
      }
    }
    fetchMeta();
  }, []);

  // ── Debounced patient search ─────────────────────────────────────────────────
  useEffect(() => {
    setListLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.get('/patients/', {
          params: { query: query || undefined, page: 1, limit: 50 },
        });
        setPatients(res.data);
      } catch {
        setPatients([]);
      } finally {
        setListLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  // ── Open patient detail modal ────────────────────────────────────────────────
  async function openPatient(listItem) {
    setModalPatient(null);
    setModalHistory([]);
    setRxList([]);
    setRxDeleteConfirm(null);
    setModalMode('view');
    setEditError('');
    // Show the modal immediately with a loading state
    setModalPatient({ id: listItem.id, name: listItem.name, _loading: true });
    setModalLoading(true);

    try {
      const [detailRes, historyRes, rxRes] = await Promise.all([
        api.get(`/patients/${listItem.id}`),
        api.get(`/patients/${listItem.id}/purchases`),
        api.get(`/prescriptions/patient/${listItem.id}`).catch(() => ({ data: [] })),
      ]);
      setModalPatient(detailRes.data);
      setModalHistory(historyRes.data);
      setRxList(rxRes.data || []);
    } catch (err) {
      console.error('Failed to load patient detail', err);
      setModalPatient(null);
    } finally {
      setModalLoading(false);
    }
  }

  function closeModal() {
    setModalPatient(null);
    setModalHistory([]);
    setRxList([]);
    setRxDeleteConfirm(null);
    setModalMode('view');
    setEditError('');
  }

  // ── Enter edit mode in modal ─────────────────────────────────────────────────
  function startEdit() {
    if (!modalPatient) return;
    setEditForm({
      name:               modalPatient.name        || '',
      mobile:             modalPatient.mobile      || '',
      age:                modalPatient.age != null ? String(modalPatient.age) : '',
      gender:             modalPatient.gender      || 'M',
      patient_type:       modalPatient.patient_type || 'PRESCRIPTION',
      preferred_language: modalPatient.preferred_language || 'BOTH',
      email:              modalPatient.email       || '',
      address:            modalPatient.address     || '',
      department_ids:     (modalPatient.departments || []).map(d => d.id),
      tag_ids:            (modalPatient.tags       || []).map(t => t.id),
    });
    setEditError('');
    setModalMode('edit');
  }

  // ── Save edit ────────────────────────────────────────────────────────────────
  async function saveEdit(e) {
    e.preventDefault();
    if (editSubmitting) return;
    setEditSubmitting(true);
    setEditError('');
    try {
      const payload = {
        name:               editForm.name.trim(),
        mobile:             editForm.mobile.trim(),
        age:                editForm.age !== '' ? parseInt(editForm.age, 10) : null,
        gender:             editForm.gender,
        patient_type:       editForm.patient_type,
        preferred_language: editForm.preferred_language,
        email:              editForm.email.trim() || null,
        address:            editForm.address.trim() || null,
        department_ids:     editForm.department_ids,
        tag_ids:            editForm.tag_ids,
      };
      const res = await api.put(`/patients/${modalPatient.id}`, payload);
      setModalPatient(res.data);
      setModalMode('view');
      // Refresh the list so updated info shows there too
      const listRes = await api.get('/patients/', {
        params: { query: query || undefined, page: 1, limit: 50 },
      });
      setPatients(listRes.data);
    } catch (err) {
      setEditError(err.response?.data?.detail || 'Failed to save changes.');
    } finally {
      setEditSubmitting(false);
    }
  }

  // ── Delete a prescription ────────────────────────────────────────────────────
  async function deleteRx(rx) {
    setDeletingRxId(rx.id);
    try {
      await api.delete(`/prescriptions/${rx.id}`);
      setRxList(prev => prev.filter(r => r.id !== rx.id));
    } catch (err) {
      alert(err.response?.data?.detail || 'Could not delete prescription.');
    } finally {
      setDeletingRxId(null);
      setRxDeleteConfirm(null);
    }
  }

  // ── Register new patient ─────────────────────────────────────────────────────
  // `force` skips the backend's duplicate-phone guard (used by "Register Anyway").
  async function doRegister(force = false) {
    if (regSubmitting) return;
    setRegSubmitting(true);
    setRegError('');
    setRegSuccess('');
    setDupPatient(null);
    try {
      const payload = {
        name:               regForm.name.trim(),
        mobile:             regForm.mobile.trim(),
        age:                regForm.age !== '' ? parseInt(regForm.age, 10) : null,
        gender:             regForm.gender,
        patient_type:       regForm.patient_type,
        preferred_language: regForm.preferred_language,
        email:              regForm.email.trim() || null,
        address:            regForm.address.trim() || null,
        department_ids:     regForm.department_ids,
        tag_ids:            regForm.tag_ids,
      };
      await api.post('/patients/', payload, force ? { params: { force: true } } : undefined);
      setRegSuccess('Patient registered successfully!');
      setRegForm(BLANK_FORM);
      // Reload list and switch to it
      const listRes = await api.get('/patients/', { params: { page: 1, limit: 50 } });
      setPatients(listRes.data);
      setQuery('');
      setTimeout(() => {
        setRegSuccess('');
        setActiveTab('list');
      }, 1500);
    } catch (err) {
      const detail = err.response?.data?.detail;
      // A 409 with a structured detail means the phone number is already taken.
      if (err.response?.status === 409 && detail && typeof detail === 'object') {
        setDupPatient({
          id:   detail.existing_patient_id,
          name: detail.existing_patient_name,
        });
      } else {
        setRegError(
          typeof detail === 'string' ? detail : (detail?.message || 'Failed to register patient.'),
        );
      }
    } finally {
      setRegSubmitting(false);
    }
  }

  function submitRegister(e) {
    e.preventDefault();
    doRegister(false);
  }

  // "Select Existing Patient" from the duplicate prompt — open their record.
  function selectExistingDuplicate() {
    if (!dupPatient) return;
    const p = dupPatient;
    setDupPatient(null);
    setActiveTab('list');
    openPatient({ id: p.id, name: p.name });
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="fade-up">

      {/* ── Page header + tabs ── */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)', marginBottom: 14 }}>
          Patients
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {[
            { key: 'list',     label: 'Patient List' },
            { key: 'register', label: '+ Register Patient' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                padding: '8px 20px',
                fontWeight: 600,
                fontSize: 13,
                background: activeTab === tab.key ? 'var(--brand)' : 'rgba(255,255,255,0.55)',
                color:      activeTab === tab.key ? '#fff' : 'var(--text-secondary)',
                border:     activeTab === tab.key ? 'none' : '1px solid var(--border)',
                borderRadius: 'var(--radius)',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── TAB 1: Patient List ── */}
      {activeTab === 'list' && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Search bar */}
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name or mobile number…"
              style={{ maxWidth: 360 }}
            />
          </div>

          {listLoading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              Loading…
            </div>
          ) : patients.length === 0 ? (
            <div style={{ padding: 60, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>👥</div>
              <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>
                No patients yet.
              </div>
              <div style={{ color: 'var(--text-muted)', marginBottom: 18, fontSize: 13 }}>
                Register the first patient →
              </div>
              <button
                className="btn-primary"
                onClick={() => setActiveTab('register')}
              >
                Register Patient
              </button>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  {['Name', 'Mobile', 'Age', 'Type', 'Departments', 'Tags', 'Last Visit', 'Purchases'].map(h => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {patients.map(p => (
                  <tr key={p.id} onClick={() => openPatient(p)}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                    </td>
                    <td style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                      {p.mobile || '—'}
                    </td>
                    <td>{p.age ?? '—'}</td>
                    <td>
                      <TypeBadge type={p.patient_type} />
                    </td>
                    <td>
                      {p.departments.length > 0
                        ? <span style={{ fontSize: 12, color: 'var(--info)' }}>
                            {p.departments.join(', ')}
                          </span>
                        : <span style={{ color: 'var(--text-hint)', fontSize: 12 }}>—</span>
                      }
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {p.tags.slice(0, 3).map(t => (
                          <span key={t} className="badge badge-neutral" style={{ fontSize: 10 }}>{t}</span>
                        ))}
                        {p.tags.length > 3 && (
                          <span className="badge badge-neutral" style={{ fontSize: 10 }}>
                            +{p.tags.length - 3}
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {fmtDate(p.last_visit)}
                    </td>
                    <td style={{ fontWeight: 600, color: p.total_purchases > 0 ? 'var(--ok)' : 'var(--text-hint)' }}>
                      {p.total_purchases}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── TAB 2: Register Patient ── */}
      {activeTab === 'register' && (
        <div className="card" style={{ maxWidth: 740 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>
            Register New Patient
          </h2>

          {regSuccess && (
            <div style={successBannerStyle}>{regSuccess}</div>
          )}
          {regError && (
            <div style={errorBannerStyle}>{regError}</div>
          )}
          {dupPatient && (
            <div style={{
              background: 'var(--warn-bg)', border: '1px solid rgba(217,119,6,0.3)',
              borderRadius: 'var(--radius)', padding: '12px 16px', marginBottom: 16,
              fontSize: 13, color: 'var(--text)',
            }}>
              <div style={{ marginBottom: 10 }}>
                A patient named <strong>{dupPatient.name}</strong> is already registered
                with this phone number. Do you want to select them instead?
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={selectExistingDuplicate}
                  style={{ fontSize: 13, padding: '8px 14px' }}
                >
                  Select Existing Patient
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => doRegister(true)}
                  disabled={regSubmitting}
                  style={{ fontSize: 13, padding: '8px 14px' }}
                >
                  {regSubmitting ? 'Registering…' : 'Register Anyway'}
                </button>
              </div>
            </div>
          )}

          <form onSubmit={submitRegister}>
            <PatientFormFields
              form={regForm}
              setForm={setRegForm}
              departments={departments}
              allTags={allTags}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={regSubmitting}
              style={{ marginTop: 24, width: '100%', padding: '12px' }}
            >
              {regSubmitting ? 'Registering…' : 'Register Patient'}
            </button>
          </form>
        </div>
      )}

      {/* ── Patient Detail Modal (rendered via portal to escape Layout's overflow) ── */}
      {modalPatient && createPortal(
        <div
          style={overlayStyle}
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div style={modalStyle}>

            {/* Modal header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 19, fontWeight: 700 }}>
                  {modalPatient.name}
                </div>
                {!modalLoading && !modalPatient._loading && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                    Registered: {fmtDate(modalPatient.registration_date)}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {modalMode === 'view' && !modalLoading && !modalPatient._loading && (
                  <button className="btn-secondary" onClick={startEdit} style={{ fontSize: 12 }}>
                    ✏️ Edit
                  </button>
                )}
                <button
                  onClick={closeModal}
                  style={{ background: 'transparent', border: 'none', fontSize: 22, padding: '0 4px', color: 'var(--text-muted)', lineHeight: 1 }}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Loading state */}
            {(modalLoading || modalPatient._loading) && (
              <div style={{ padding: '30px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                Loading…
              </div>
            )}

            {/* VIEW MODE */}
            {!modalLoading && !modalPatient._loading && modalMode === 'view' && (
              <div>
                {/* Demographics */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px', marginBottom: 18 }}>
                  <InfoRow label="Mobile"   value={modalPatient.mobile || '—'} />
                  <InfoRow label="Age"      value={modalPatient.age != null ? `${modalPatient.age} yrs` : '—'} />
                  <InfoRow label="Gender"   value={genderLabel(modalPatient.gender)} />
                  <InfoRow label="Type"     value={<TypeBadge type={modalPatient.patient_type} />} />
                  <InfoRow label="Language" value={langLabel(modalPatient.preferred_language)} />
                  <InfoRow label="Email"    value={modalPatient.email || '—'} />
                  {modalPatient.address && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <InfoRow label="Address" value={modalPatient.address} />
                    </div>
                  )}
                </div>

                {/* Departments */}
                {modalPatient.departments?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={sectionLabelStyle}>Departments</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {modalPatient.departments.map(d => (
                        <span key={d.id} className="badge badge-info">{d.name}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Tags */}
                {modalPatient.tags?.length > 0 && (
                  <div style={{ marginBottom: 18 }}>
                    <div style={sectionLabelStyle}>Tags</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {modalPatient.tags.map(t => (
                        <span key={t.id} className="badge badge-accent">{t.name}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Smart history summary card */}
                <PatientSummaryCard patientId={modalPatient.id} />

                {/* Purchase history */}
                <div>
                  <div style={sectionLabelStyle}>Purchase History</div>
                  {modalHistory.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
                      No purchases yet.
                    </div>
                  ) : (
                    <div style={{ maxHeight: 220, overflowY: 'auto', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                      <table style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th>Invoice</th>
                            <th>Date</th>
                            <th>Total</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {modalHistory.map(inv => (
                            <tr key={inv.invoice_number} style={{ cursor: 'default' }}>
                              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                                {inv.invoice_number}
                              </td>
                              <td style={{ fontSize: 12 }}>
                                {fmtDateTime(inv.invoice_date)}
                              </td>
                              <td style={{ fontWeight: 600 }}>{inr(inv.total_amount)}</td>
                              <td>
                                <span className={`badge ${inv.status === 'COMPLETED' ? 'badge-ok' : 'badge-danger'}`}>
                                  {inv.status}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* ── Prescriptions section (only shown when patient has at least one) ── */}
                {rxList.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <div style={sectionLabelStyle}>Prescriptions</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {rxList.map(rx => (
                        <div key={rx.id} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          background: 'rgba(255,255,255,0.45)', backdropFilter: 'blur(12px)',
                          border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)',
                          padding: '10px 12px',
                        }}>
                          {/* Thumbnail or PDF icon */}
                          <div style={{
                            width: 44, height: 44, flexShrink: 0, borderRadius: 6,
                            overflow: 'hidden', border: '1px solid var(--glass-border)',
                            background: 'rgba(255,255,255,0.60)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {rx.mime_type !== 'application/pdf' ? (
                              <img
                                src={`/api/prescriptions/${rx.id}/image`}
                                alt="Rx"
                                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              />
                            ) : (
                              <span style={{ fontSize: 20 }}>📄</span>
                            )}
                          </div>

                          {/* Info */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                              {fmtDateTime(rx.uploaded_at)}
                              {rx.invoice_number && (
                                <span style={{ marginLeft: 8, fontFamily: 'monospace', fontSize: 11, color: 'var(--accent)' }}>
                                  {rx.invoice_number}
                                </span>
                              )}
                            </div>
                            {rx.dispensed_medicines?.length > 0 && (
                              <div style={{
                                fontSize: 11, color: 'var(--text-secondary)', marginTop: 2,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {rx.dispensed_medicines.join(' · ')}
                              </div>
                            )}
                            {!rx.invoice_number && (
                              <div style={{ fontSize: 11, color: 'var(--text-hint)', marginTop: 2 }}>
                                Bill not linked
                              </div>
                            )}
                          </div>

                          {/* Actions */}
                          <a
                            href={`/api/prescriptions/${rx.id}/image`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              fontSize: 11, fontWeight: 600, color: 'var(--accent)',
                              textDecoration: 'none', padding: '4px 10px',
                              background: 'var(--accent-light)',
                              border: '1px solid rgba(99,102,241,0.25)',
                              borderRadius: 20, flexShrink: 0,
                            }}
                          >
                            View Rx
                          </a>

                          {/* Delete — only shown to Owner/Admin */}
                          {rxDeleteConfirm?.id === rx.id ? (
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              <button
                                onClick={() => deleteRx(rx)}
                                disabled={deletingRxId === rx.id}
                                style={{
                                  fontSize: 11, padding: '4px 10px', borderRadius: 20,
                                  background: 'var(--danger)', color: '#fff', border: 'none',
                                  cursor: 'pointer', fontWeight: 600,
                                }}
                              >
                                {deletingRxId === rx.id ? '…' : 'Confirm'}
                              </button>
                              <button
                                onClick={() => setRxDeleteConfirm(null)}
                                style={{
                                  fontSize: 11, padding: '4px 10px', borderRadius: 20,
                                  background: 'transparent', color: 'var(--text-secondary)',
                                  border: '1px solid var(--border)', cursor: 'pointer',
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setRxDeleteConfirm(rx)}
                              title="Delete prescription"
                              style={{
                                background: 'none', border: 'none', color: 'var(--danger)',
                                fontSize: 15, cursor: 'pointer', padding: '0 4px', flexShrink: 0,
                              }}
                            >
                              🗑
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* EDIT MODE */}
            {!modalLoading && !modalPatient._loading && modalMode === 'edit' && (
              <div>
                {editError && (
                  <div style={{ ...errorBannerStyle, marginBottom: 16 }}>{editError}</div>
                )}
                <form onSubmit={saveEdit}>
                  <PatientFormFields
                    form={editForm}
                    setForm={setEditForm}
                    departments={departments}
                    allTags={allTags}
                  />
                  <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setModalMode('view')}
                      style={{ flex: 1 }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="btn-primary"
                      disabled={editSubmitting}
                      style={{ flex: 2 }}
                    >
                      {editSubmitting ? 'Saving…' : 'Save Changes'}
                    </button>
                  </div>
                </form>
              </div>
            )}

          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Shared form fields component ────────────────────────────────────────────
/**
 * Reused for both Register tab and Edit mode in the modal.
 * Props:
 *   form        — the current form values object
 *   setForm     — state setter for the form
 *   departments — list of {id, name} from /api/inventory/departments
 *   allTags     — list of {id, name} from /api/patients/tags
 */
function PatientFormFields({ form, setForm, departments, allTags }) {
  function field(key) {
    return {
      value: form[key],
      onChange: e => setForm(prev => ({ ...prev, [key]: e.target.value })),
    };
  }

  function toggleId(key, id) {
    setForm(prev => {
      const list = prev[key];
      return {
        ...prev,
        [key]: list.includes(id) ? list.filter(x => x !== id) : [...list, id],
      };
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Row 1: Name + Mobile */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={labelStyle}>
          Full Name *
          <input {...field('name')} placeholder="e.g. Rajesh Kumar" required />
        </label>
        <label style={labelStyle}>
          Mobile Number *
          <input {...field('mobile')} placeholder="e.g. 9876543210" required />
        </label>
      </div>

      {/* Row 2: Age + Gender */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        <label style={labelStyle}>
          Age
          <input
            type="number" min={0} max={130}
            value={form.age}
            onChange={e => setForm(prev => ({ ...prev, age: e.target.value }))}
            placeholder="e.g. 45"
          />
        </label>
        <div style={labelStyle}>
          Gender
          <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
            {[['M', 'Male'], ['F', 'Female'], ['Other', 'Other']].map(([val, lbl]) => (
              <RadioOption key={val} name={`gender_${Math.random()}`}
                value={val} label={lbl}
                checked={form.gender === val}
                onChange={() => setForm(prev => ({ ...prev, gender: val }))}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Row 3: Patient Type */}
      <div style={labelStyle}>
        Patient Type *
        <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
          {[['PRESCRIPTION', 'Prescription Patient'], ['SELF_MEDICATION', 'Self Medication']].map(([val, lbl]) => (
            <RadioOption key={val} name={`ptype_${Math.random()}`}
              value={val} label={lbl}
              checked={form.patient_type === val}
              onChange={() => setForm(prev => ({ ...prev, patient_type: val }))}
            />
          ))}
        </div>
      </div>

      {/* Row 4: Preferred Language */}
      <div style={labelStyle}>
        Preferred Language
        <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
          {[['AS', 'Assamese'], ['EN', 'English'], ['BOTH', 'Both']].map(([val, lbl]) => (
            <RadioOption key={val} name={`lang_${Math.random()}`}
              value={val} label={lbl}
              checked={form.preferred_language === val}
              onChange={() => setForm(prev => ({ ...prev, preferred_language: val }))}
            />
          ))}
        </div>
      </div>

      {/* Row 5: Email */}
      <label style={labelStyle}>
        Email (optional)
        <input type="email" {...field('email')} placeholder="e.g. rajesh@example.com" />
      </label>

      {/* Row 6: Address */}
      <label style={labelStyle}>
        Address (optional)
        <textarea
          {...field('address')}
          placeholder="Street, locality, city…"
          rows={2}
          style={{ resize: 'vertical' }}
        />
      </label>

      {/* Row 7: Departments (checkboxes) */}
      {departments.length > 0 && (
        <div style={labelStyle}>
          Departments
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            {departments.map(d => {
              const checked = form.department_ids.includes(d.id);
              return (
                <label
                  key={d.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 12px',
                    border: `1.5px solid ${checked ? 'var(--info)' : 'var(--border)'}`,
                    borderRadius: 20,
                    background: checked ? 'var(--info-bg)' : 'rgba(255,255,255,0.4)',
                    color: checked ? 'var(--info)' : 'var(--text-secondary)',
                    fontSize: 12, fontWeight: checked ? 600 : 400,
                    cursor: 'pointer', userSelect: 'none',
                    transition: 'all 0.15s',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleId('department_ids', d.id)}
                    style={{ width: 'auto', margin: 0 }}
                  />
                  {d.name}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 8: Tags (toggle pills) */}
      {allTags.length > 0 && (
        <div style={labelStyle}>
          Tags
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {allTags.map(t => {
              const selected = form.tag_ids.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleId('tag_ids', t.id)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 20,
                    fontSize: 12,
                    fontWeight: selected ? 600 : 400,
                    border: `1.5px solid ${selected ? 'var(--brand)' : 'var(--border)'}`,
                    background: selected ? 'var(--brand-light)' : 'rgba(255,255,255,0.4)',
                    color: selected ? 'var(--brand)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  {selected ? '✓ ' : ''}{t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Small shared sub-components ─────────────────────────────────────────────

function TypeBadge({ type }) {
  if (type === 'PRESCRIPTION') {
    return <span className="badge badge-info">Rx</span>;
  }
  return <span className="badge badge-ok">OTC</span>;
}

function InfoRow({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.06em', color: 'var(--text-hint)', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13 }}>{value}</div>
    </div>
  );
}

function RadioOption({ name, value, label, checked, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        style={{ width: 'auto', margin: 0 }}
      />
      {label}
    </label>
  );
}

// ─── Style helpers ────────────────────────────────────────────────────────────

function genderLabel(g) {
  return g === 'M' ? 'Male' : g === 'F' ? 'Female' : g || '—';
}

function langLabel(l) {
  return l === 'AS' ? 'Assamese' : l === 'EN' ? 'English' : l === 'BOTH' ? 'Both' : l || '—';
}

const labelStyle = {
  display: 'flex', flexDirection: 'column', gap: 5,
  fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)',
};

const sectionLabelStyle = {
  fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.08em', color: 'var(--text-hint)', marginBottom: 8,
};

const overlayStyle = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.40)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000,
};

const modalStyle = {
  width: '92%', maxWidth: 720, maxHeight: '90vh', overflowY: 'auto',
  padding: 28,
  background: 'rgba(255,255,255,0.68)',
  backdropFilter: 'blur(28px)',
  WebkitBackdropFilter: 'blur(28px)',
  border: '1px solid rgba(255,255,255,0.80)',
  borderRadius: 'var(--radius-xl)',
  boxShadow: '0 20px 60px rgba(99,102,241,0.14)',
};

const successBannerStyle = {
  background: 'var(--ok-bg)', border: '1px solid rgba(5,150,105,0.25)',
  borderRadius: 'var(--radius)', padding: '10px 14px',
  color: 'var(--ok)', fontSize: 13, fontWeight: 600, marginBottom: 16,
};

const errorBannerStyle = {
  background: 'var(--danger-bg)', border: '1px solid rgba(225,29,72,0.2)',
  borderRadius: 'var(--radius)', padding: '10px 14px',
  color: 'var(--danger)', fontSize: 13, marginBottom: 16,
};
