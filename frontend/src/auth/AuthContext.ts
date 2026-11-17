import { createContext, useContext } from 'react'
import type { User } from '../api/auth'

export type AuthState =
  | { status: 'checking' }
  | { status: 'anonymous'; notice: string | null }
  | { status: 'authenticated'; user: User }

export interface AuthContextValue {
  auth: AuthState
  setUser: (user: User) => void
  clearUser: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}
