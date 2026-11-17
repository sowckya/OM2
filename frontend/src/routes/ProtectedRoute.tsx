import { Navigate, Outlet, useLocation } from 'react-router'
import type { Role } from '../api/auth'
import { useAuth } from '../auth/AuthContext'
import { DASHBOARD_PATHS } from '../auth/roles'
import { SessionLoading } from '../components/SessionLoading'

interface ProtectedRouteProps {
  allowedRoles: Role[]
}

/**
 * Renders child routes only for signed-in users with an allowed role.
 * This is a UX guard; the backend enforces roles on every API call.
 */
export function ProtectedRoute({ allowedRoles }: ProtectedRouteProps) {
  const { auth } = useAuth()
  const location = useLocation()

  if (auth.status === 'checking') return <SessionLoading />
  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  if (!allowedRoles.includes(auth.user.role)) {
    return <Navigate to={DASHBOARD_PATHS[auth.user.role]} replace />
  }
  return <Outlet />
}
