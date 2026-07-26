import { Navigate } from 'react-router-dom';
import { isLoggedIn } from '../lib/auth';

/**
 * ProtectedRoute — guards every page that requires a login.
 *
 * Usage in App.jsx:
 *   <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
 *     ...child routes...
 *   </Route>
 *
 * If the user is not logged in they are redirected to /login.
 * The `replace` prop means the /login URL replaces the history entry so
 * clicking "back" in the browser doesn't take them to the blocked page.
 */
export default function ProtectedRoute({ children }) {
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />;
  }
  return children;
}
