import { useState } from 'react'
import { ApiError, describeError, logout as logoutRequest } from '../api/auth'
import { useAuth } from './AuthContext'

/** Logs out via the API; clearing auth state makes ProtectedRoute redirect to /login. */
export function useLogout() {
  const { clearUser } = useAuth()
  const [loggingOut, setLoggingOut] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function logout() {
    setLoggingOut(true)
    setError(null)
    try {
      await logoutRequest()
      clearUser()
    } catch (err) {
      // An expired session is already logged out server-side.
      if (err instanceof ApiError && err.status === 401) {
        clearUser()
        return
      }
      setError(describeError(err))
      setLoggingOut(false)
    }
  }

  return { logout, loggingOut, error }
}
