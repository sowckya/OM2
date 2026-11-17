import { Navigate, Outlet } from 'react-router'
import { useAuth } from '../auth/AuthContext'
import { DASHBOARD_PATHS } from '../auth/roles'
import { SessionLoading } from '../components/SessionLoading'

/** Renders child routes (e.g. /login) only when signed out; otherwise sends users home. */
export function PublicOnlyRoute() {
  const { auth } = useAuth()

  if (auth.status === 'checking') return <SessionLoading />
  if (auth.status === 'authenticated') {
    return <Navigate to={DASHBOARD_PATHS[auth.user.role]} replace />
  }
  return <Outlet />
}
