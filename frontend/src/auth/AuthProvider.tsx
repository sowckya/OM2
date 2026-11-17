import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { describeError, getCurrentUser, type User } from '../api/auth'
import { AuthContext, type AuthState } from './AuthContext'

export function AuthProvider({ children }: { children: ReactNode }) {
  // Auth state lives only in memory; the session itself is the HttpOnly cookie,
  // so a page refresh restores it by asking the backend again.
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' })

  useEffect(() => {
    let cancelled = false
    getCurrentUser()
      .then((user) => {
        if (cancelled) return
        setAuth(user ? { status: 'authenticated', user } : { status: 'anonymous', notice: null })
      })
      .catch((err) => {
        if (!cancelled) setAuth({ status: 'anonymous', notice: describeError(err) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(
    () => ({
      auth,
      setUser: (user: User) => setAuth({ status: 'authenticated', user }),
      clearUser: () => setAuth({ status: 'anonymous', notice: null }),
    }),
    [auth],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
