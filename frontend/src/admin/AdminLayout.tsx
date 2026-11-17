import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router'
import { useAuth } from '../auth/AuthContext'
import { useLogout } from '../auth/useLogout'
import { Spinner } from '../components/Spinner'
import { CloseIcon, LogoutIcon, MenuIcon } from './icons'
import { ADMIN_NAV } from './navigation'
import { Sidebar } from './Sidebar'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase()
}

/** Shell for Millionaire pages; rendered only inside a MILLIONAIRE ProtectedRoute. */
export function AdminLayout() {
  const { auth } = useAuth()
  const { logout, loggingOut, error } = useLogout()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  function closeMenu() {
    setMenuOpen(false)
    menuButtonRef.current?.focus()
  }

  // Mobile drawer: move focus in, close on Escape.
  useEffect(() => {
    if (!menuOpen) return
    closeButtonRef.current?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        menuButtonRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  if (auth.status !== 'authenticated') return null
  const { user } = auth
  const pageTitle = ADMIN_NAV.find((item) => item.path === location.pathname)?.label ?? 'Dashboard'

  return (
    <div className="min-h-screen bg-cream font-sans text-ink">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-24 lg:block">
        <Sidebar variant="rail" />
      </aside>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="lg:hidden">
          <div
            data-testid="sidebar-backdrop"
            className="fixed inset-0 z-40 bg-navy-950/60"
            onClick={closeMenu}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            id="admin-mobile-nav"
            className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] shadow-xl"
          >
            <Sidebar onNavigate={() => setMenuOpen(false)} />
            <button
              ref={closeButtonRef}
              type="button"
              onClick={closeMenu}
              aria-label="Close navigation menu"
              className="absolute top-4 right-3 rounded-lg p-1.5 text-[#aeb6c2] hover:bg-navy-800 hover:text-ivory focus-visible:outline-2 focus-visible:outline-brass"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      <div className="lg:pl-24">
        <header className="sticky top-0 z-20 border-b border-line bg-cream/90 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
            <button
              ref={menuButtonRef}
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={menuOpen}
              aria-controls="admin-mobile-nav"
              className="-ml-1 rounded-lg p-2 text-ink hover:bg-sand focus-visible:outline-2 focus-visible:outline-brass lg:hidden"
            >
              <MenuIcon />
            </button>
            <p className="flex-1 truncate text-sm font-medium text-muted">{pageTitle}</p>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3">
                <div
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy-900 text-xs font-medium text-brass-light"
                >
                  {initials(user.display_name)}
                </div>
                <div className="hidden min-w-0 flex-col justify-center sm:flex">
                  <p className="max-w-48 truncate text-sm leading-5 font-medium text-ink">
                    {user.display_name}
                  </p>
                  <p className="text-xs leading-4 text-muted">Millionaire</p>
                </div>
              </div>
              <div aria-hidden="true" className="hidden h-8 w-px bg-line sm:block" />
              <button
                type="button"
                onClick={logout}
                disabled={loggingOut}
                className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loggingOut ? <Spinner /> : <LogoutIcon />}
                <span>{loggingOut ? 'Logging out…' : 'Logout'}</span>
              </button>
            </div>
          </div>
          {error && (
            <div role="alert" className="border-t border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 sm:px-6 lg:px-8">
              {error}
            </div>
          )}
        </header>

        <main className="px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
