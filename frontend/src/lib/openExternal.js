/**
 * Open a web address in the computer's own browser.
 *
 * Inside the installed app (Tauri) a normal link would open INSIDE Curavo's
 * window, so we ask Tauri's shell plugin to open the real browser - that is
 * where the owner is already signed in to Google.  Running in a plain
 * browser (development), a new tab does the same job.
 */
export async function openExternal(url) {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('plugin:shell|open', { path: url });
      return true;
    } catch {
      /* fall through to window.open */
    }
  }
  return !!window.open(url, '_blank', 'noopener');
}
