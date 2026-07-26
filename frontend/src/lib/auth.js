/**
 * Authentication helpers — store and retrieve the logged-in user's token.
 *
 * We use sessionStorage (not localStorage) intentionally: sessionStorage
 * clears automatically when the browser tab or window is closed.  On a
 * shared pharmacy counter PC that is the right behaviour — closing the
 * browser logs the user out without any extra steps.
 */

const TOKEN_KEY = 'hcc_token';
const USER_KEY  = 'hcc_user';

/** Save the JWT token and user object after a successful login. */
export function saveToken(token, user) {
  sessionStorage.setItem(TOKEN_KEY, token);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** Return the JWT string, or null if nobody is logged in. */
export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

/**
 * Return the user object that was saved at login, or null.
 * Shape: { id, username, full_name, role_name }
 */
export function getUser() {
  const raw = sessionStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Remove token and user — effectively logs the user out. */
export function clearAuth() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

/** Returns true if a token is present (user is logged in). */
export function isLoggedIn() {
  return Boolean(getToken());
}
