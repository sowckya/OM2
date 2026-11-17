import { useAuth } from '../auth/AuthContext'
import { useLogout } from '../auth/useLogout'
import { Spinner } from './Spinner'

interface ComingSoonProps {
  title: string
}

/** Dashboard placeholder; rendered only inside a ProtectedRoute. */
export function ComingSoon({ title }: ComingSoonProps) {
  const { auth } = useAuth()
  const { logout: handleLogout, loggingOut, error } = useLogout()

  if (auth.status !== 'authenticated') return null
  const { user } = auth

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
          <span className="text-lg font-bold text-indigo-600">OM2</span>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{user.display_name}</span>
            <button
              type="button"
              onClick={handleLogout}
              disabled={loggingOut}
              className="flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loggingOut && <Spinner />}
              {loggingOut ? 'Logging out…' : 'Logout'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-16 text-center">
        {error && (
          <div
            role="alert"
            className="mx-auto mb-6 max-w-md rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error}
          </div>
        )}
        <p className="text-sm text-slate-500">Signed in as {user.display_name}</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          {title}
        </h1>
      </main>
    </div>
  )
}
