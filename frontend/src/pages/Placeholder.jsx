/* A simple "coming soon" page used for modules we haven't built yet,
   so the navigation works end-to-end while we develop each module. */
export default function Placeholder({ title }) {
  return (
    <div>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>{title}</h1>
      <p style={{ color: 'var(--text-muted)' }}>This module is coming soon.</p>
    </div>
  );
}
