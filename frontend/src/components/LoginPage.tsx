import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { describeError, login, type Role, type User } from '../api/auth'
import { Spinner } from './Spinner'

interface LoginPageProps {
  onLogin: (user: User) => void
  notice?: string | null
}

const TABS: { role: Role; label: string; heading: string; description: string }[] = [
  {
    role: 'OMKAR',
    label: 'Omkar Login',
    heading: 'Omkar sign in',
    description: 'View your assigned posts and publish them to your X accounts.',
  },
  {
    role: 'MILLIONAIRE',
    label: 'Millionaire Login',
    heading: 'Millionaire sign in',
    description: 'Manage accounts, content, approvals and distribution.',
  },
]

const inputClass =
  'block w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-50 sm:text-sm'

export function LoginPage({ onLogin, notice }: LoginPageProps) {
  const [role, setRole] = useState<Role>('OMKAR')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const activeIndex = TABS.findIndex((tab) => tab.role === role)
  const active = TABS[activeIndex]

  function selectTab(index: number) {
    if (submitting) return
    setRole(TABS[index].role)
    setError(null)
    setPassword('')
    tabRefs.current[index]?.focus()
  }

  // Arrow/Home/End keyboard support per the WAI-ARIA tabs pattern.
  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const last = TABS.length - 1
    const next =
      event.key === 'ArrowRight' ? (activeIndex === last ? 0 : activeIndex + 1)
      : event.key === 'ArrowLeft' ? (activeIndex === 0 ? last : activeIndex - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (next === null) return
    event.preventDefault()
    selectTab(next)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const user = await login(username.trim(), password, role)
      onLogin(user)
    } catch (err) {
      setError(describeError(err))
      setPassword('')
      setSubmitting(false)
    }
  }

  const message = error ?? notice

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-white to-indigo-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white shadow-sm">
            OM2
          </div>
          <p className="text-sm font-medium tracking-wide text-slate-500">Operation Million Mark</p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <div
            role="tablist"
            aria-label="Login type"
            className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1"
          >
            {TABS.map((tab, index) => {
              const selected = tab.role === role
              return (
                <button
                  key={tab.role}
                  ref={(el) => {
                    tabRefs.current[index] = el
                  }}
                  id={`login-tab-${tab.role}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="login-panel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(index)}
                  onKeyDown={handleTabKeyDown}
                  disabled={submitting && !selected}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
                    selected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>

          <div id="login-panel" role="tabpanel" aria-labelledby={`login-tab-${role}`}>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">{active.heading}</h1>
            <p className="mt-1 text-sm text-slate-500">{active.description}</p>

            <form
              onSubmit={handleSubmit}
              aria-describedby={message ? 'login-message' : undefined}
              className="mt-6 space-y-5"
            >
              {message && (
                <div
                  id="login-message"
                  role="alert"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                >
                  {message}
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="username" className="block text-sm font-medium text-slate-700">
                  Username
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={submitting}
                  aria-invalid={error ? true : undefined}
                  className={inputClass}
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                  Password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                  aria-invalid={error ? true : undefined}
                  className={inputClass}
                />
              </div>

              <button
                type="submit"
                disabled={submitting || !username.trim() || !password}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <Spinner />}
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Accounts are created by OM2 administrators.
        </p>
      </div>
    </main>
  )
}
