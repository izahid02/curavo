/**
 * Pharmacy settings — the shop's own identity, loaded ONCE and shared.
 *
 * WHY A CONTEXT AND NOT A FETCH PER COMPONENT:
 * The shop name appears in the sidebar, on the login card, at the top of every
 * printed receipt and in the browser tab title.  Four independent fetches would
 * mean four loading flickers and, worse, four chances to disagree with each
 * other for a second after a rename.  One provider at the root loads it once
 * and every consumer reads the same object.
 *
 * WHY IT IS SAFE TO LOAD BEFORE LOGIN:
 * GET /api/settings/pharmacy needs no token by design (the login screen renders
 * before anyone has one).  Everything it returns — name, address, phone, GSTIN
 * — is already printed on the shop's own bills.
 *
 * Usage:
 *   const { pharmacy, refresh } = usePharmacy();
 *   <h1>{pharmacy.pharmacy_name}</h1>
 *
 * `pharmacy` is NEVER null: until the request lands (or if it fails, e.g. the
 * backend sidecar is still starting) it holds DEFAULT_PHARMACY, so no screen
 * ever has to render a blank where the shop name goes.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api';

/** What every screen falls back to before the real settings arrive. */
export const DEFAULT_PHARMACY = {
  id: null,
  pharmacy_name: 'Health Care Centre',
  pharmacy_tagline: 'Pharmacy & Medical Store',
  pharmacy_address: null,
  pharmacy_phone: null,
  pharmacy_email: null,
  pharmacy_gstin: null,
  pharmacy_dl_number: null,
};

const PharmacyContext = createContext({
  pharmacy: DEFAULT_PHARMACY,
  loading: true,
  refresh: () => {},
  setPharmacy: () => {},
});

export function PharmacyProvider({ children }) {
  const [pharmacy, setPharmacy] = useState(DEFAULT_PHARMACY);
  const [loading, setLoading]   = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/settings/pharmacy');
      // Merge onto the defaults so a null column (e.g. no tagline yet) still
      // renders something sensible instead of the word "null".
      setPharmacy({ ...DEFAULT_PHARMACY, ...data });
    } catch {
      // Backend not up yet, or an older build with no settings endpoint.
      // Keeping the defaults is the right outcome — the app still works.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Keep the browser tab title in step with the shop name.  Doing it here
  // rather than in Layout means it is also correct on the login screen, which
  // sits outside the app shell.
  useEffect(() => {
    document.title = `${pharmacy.pharmacy_name} · Curavo`;
  }, [pharmacy.pharmacy_name]);

  return (
    <PharmacyContext.Provider value={{ pharmacy, loading, refresh, setPharmacy }}>
      {children}
    </PharmacyContext.Provider>
  );
}

/** Read the shared pharmacy settings from any component. */
export function usePharmacy() {
  return useContext(PharmacyContext);
}
