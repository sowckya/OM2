import { fireEvent, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router'
import { expect, vi } from 'vitest'
import type { Role, User } from '../api/auth'
import App from '../App'
import { AuthProvider } from '../auth/AuthProvider'

// Shared helpers for app-level tests: a fake Django auth API and a router harness.

export const MILLIONAIRE: User = { id: 1, username: 'm1', display_name: 'Mona M', role: 'MILLIONAIRE' }
export const OMKAR: User = { id: 2, username: 'o1', display_name: 'Om K', role: 'OMKAR' }
export const INVALID = 'Invalid username or password for this login type.'
export const TAB_LABELS: Record<Role, string> = { OMKAR: 'Omkar Login', MILLIONAIRE: 'Millionaire Login' }

export const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

export type ExtraRoutes = (url: string, init?: RequestInit) => Promise<Response | undefined>

/** Minimal fake of the Django auth API, backed by an in-memory session. */
export function fakeBackend(
  initialUser: User | null,
  accounts: Record<string, User> = {},
  extraRoutes?: ExtraRoutes,
) {
  let sessionUser = initialUser
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url === '/api/auth/csrf/') return json(200, { csrfToken: 'token' })
    if (url === '/api/auth/me/') {
      return sessionUser ? json(200, sessionUser) : json(401, { detail: 'Not authenticated.' })
    }
    if (url === '/api/auth/login/' && method === 'POST') {
      const { username, password, expected_role } = JSON.parse(String(init?.body))
      const user = accounts[username]
      if (!user || password !== 'correct-pass' || user.role !== expected_role) {
        return json(400, { detail: INVALID })
      }
      sessionUser = user
      return json(200, user)
    }
    if (url === '/api/auth/logout/' && method === 'POST') {
      if (!sessionUser) return json(401, { detail: 'Not authenticated.' })
      sessionUser = null
      return json(204)
    }
    const handled = await extraRoutes?.(url, init)
    if (handled) return handled
    return json(404, { detail: 'Not found.' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>
}

/** Renders the app in a memory data router, matching main.tsx's setup. */
export function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <AuthProvider>
            <App />
            <LocationProbe />
          </AuthProvider>
        ),
      },
    ],
    { initialEntries: [path] },
  )
  return { ...render(<RouterProvider router={router} />), router }
}

export const currentPath = () => screen.getByTestId('location').textContent

export async function signIn(username: string, tab: Role, password = 'correct-pass') {
  fireEvent.click(await screen.findByRole('tab', { name: TAB_LABELS[tab] }))
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: username } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

export const MILLIONAIRE_HEADING = { name: 'Welcome back, Mona M' }

/** Neither dashboard is on screen (used while loading or after a rejected login). */
export function expectNoDashboard() {
  expect(screen.queryByRole('heading', { name: /Welcome back/ })).toBeNull()
  expect(screen.queryByText('Omkar Dashboard — Coming Soon')).toBeNull()
}
