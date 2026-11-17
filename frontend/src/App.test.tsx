import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  INVALID,
  MILLIONAIRE,
  MILLIONAIRE_HEADING,
  OMKAR,
  currentPath,
  expectNoDashboard,
  fakeBackend,
  json,
  renderAt,
  signIn,
} from './test/utils'

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('session check', () => {
  it('shows a loading state, not the protected page, while checking the session', async () => {
    let resolveMe: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => (resolveMe = resolve))))
    renderAt('/admin/dashboard')

    expect(screen.getByRole('status').textContent).toContain('Checking your session')
    expectNoDashboard()

    await act(async () => resolveMe(json(401, { detail: 'Not authenticated.' })))
    expect(await screen.findByRole('tablist', { name: 'Login type' })).toBeTruthy()
    expect(currentPath()).toBe('/login')
  })

  it('keeps a Millionaire on their dashboard after a refresh', async () => {
    fakeBackend(MILLIONAIRE)
    renderAt('/admin/dashboard')
    expect(await screen.findByRole('heading', MILLIONAIRE_HEADING)).toBeTruthy()
    expect(currentPath()).toBe('/admin/dashboard')
  })

  it('keeps an Omkar on their dashboard after a refresh', async () => {
    fakeBackend(OMKAR)
    renderAt('/omkar/dashboard')
    expect(await screen.findByText('Omkar Dashboard — Coming Soon')).toBeTruthy()
    expect(currentPath()).toBe('/omkar/dashboard')
  })

  it('shows a connection error on the login page when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))))
    renderAt('/')
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    expect(currentPath()).toBe('/login')
  })
})

describe('redirects', () => {
  it.each([
    ['/', null, '/login'],
    ['/', MILLIONAIRE, '/admin/dashboard'],
    ['/', OMKAR, '/omkar/dashboard'],
    ['/admin/dashboard', null, '/login'],
    ['/omkar/dashboard', null, '/login'],
    ['/login', MILLIONAIRE, '/admin/dashboard'],
    ['/login', OMKAR, '/omkar/dashboard'],
    ['/no-such-page', null, '/login'],
    ['/no-such-page', OMKAR, '/omkar/dashboard'],
  ])('%s with user %o goes to %s', async (start, user, expected) => {
    fakeBackend(user)
    renderAt(start)
    await vi.waitFor(() => expect(currentPath()).toBe(expected))
  })

  it('blocks an Omkar from the Millionaire dashboard', async () => {
    fakeBackend(OMKAR)
    renderAt('/admin/dashboard')
    expect(await screen.findByText('Omkar Dashboard — Coming Soon')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /Welcome back/ })).toBeNull()
    expect(currentPath()).toBe('/omkar/dashboard')
  })

  it('blocks a Millionaire from the Omkar dashboard', async () => {
    fakeBackend(MILLIONAIRE)
    renderAt('/omkar/dashboard')
    expect(await screen.findByRole('heading', MILLIONAIRE_HEADING)).toBeTruthy()
    expect(screen.queryByText('Omkar Dashboard — Coming Soon')).toBeNull()
    expect(currentPath()).toBe('/admin/dashboard')
  })
})

describe('login and logout', () => {
  const accounts = { m1: MILLIONAIRE, o1: OMKAR }

  it('sends a Millionaire to /admin/dashboard after login on the Millionaire tab', async () => {
    const fetchMock = fakeBackend(null, accounts)
    renderAt('/login')
    await signIn('m1', 'MILLIONAIRE')
    expect(await screen.findByRole('heading', MILLIONAIRE_HEADING)).toBeTruthy()
    expect(currentPath()).toBe('/admin/dashboard')
    const loginCall = fetchMock.mock.calls.find(([url]) => url === '/api/auth/login/')
    expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({
      username: 'm1',
      password: 'correct-pass',
      expected_role: 'MILLIONAIRE',
    })
  })

  it('sends an Omkar to /omkar/dashboard after login, even when they tried an admin URL', async () => {
    fakeBackend(null, accounts)
    renderAt('/admin/dashboard')
    await signIn('o1', 'OMKAR')
    expect(await screen.findByText('Omkar Dashboard — Coming Soon')).toBeTruthy()
    expect(currentPath()).toBe('/omkar/dashboard')
  })

  it('shows an error and stays on /login for invalid credentials', async () => {
    fakeBackend(null, accounts)
    renderAt('/login')
    await signIn('m1', 'MILLIONAIRE', 'wrong-pass')
    expect((await screen.findByRole('alert')).textContent).toBe(INVALID)
    expect(currentPath()).toBe('/login')
  })

  it.each([
    ['o1', 'MILLIONAIRE'],
    ['m1', 'OMKAR'],
  ] as const)('rejects %s on the %s tab without creating a session', async (username, tab) => {
    const fetchMock = fakeBackend(null, accounts)
    renderAt('/login')
    await signIn(username, tab)
    expect((await screen.findByRole('alert')).textContent).toBe(INVALID)
    expect(currentPath()).toBe('/login')
    expectNoDashboard()
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')

    cleanup() // "refresh": the backend still reports no session
    renderAt('/admin/dashboard')
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
    expect(fetchMock).toHaveBeenLastCalledWith('/api/auth/me/', expect.anything())
  })

  it('logs out, returns to /login, and the protected page stays blocked', async () => {
    const fetchMock = fakeBackend(MILLIONAIRE)
    renderAt('/admin/dashboard')
    fireEvent.click(await screen.findByRole('button', { name: 'Logout' }))

    expect(await screen.findByRole('tablist', { name: 'Login type' })).toBeTruthy()
    expect(currentPath()).toBe('/login')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout/',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ 'X-CSRFToken': 'token' }) }),
    )

    cleanup() // "refresh": a fresh app sees no session
    renderAt('/admin/dashboard')
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
  })
})

describe('login tabs', () => {
  const selectedTab = () => screen.getByRole('tab', { selected: true })

  it('selects the Omkar tab by default and shows OM2 branding', async () => {
    fakeBackend(null)
    renderAt('/login')
    expect((await screen.findByRole('tab', { selected: true })).textContent).toBe('Omkar Login')
    expect(screen.getByRole('heading', { name: 'Omkar sign in' })).toBeTruthy()
    expect(screen.getByText('OM2')).toBeTruthy()
    expect(screen.getByText('Operation Million Mark')).toBeTruthy()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(selectedTab().id)
  })

  it('switches heading and description when the Millionaire tab is clicked', async () => {
    fakeBackend(null)
    renderAt('/login')
    fireEvent.click(await screen.findByRole('tab', { name: 'Millionaire Login' }))
    expect(selectedTab().textContent).toBe('Millionaire Login')
    expect(screen.getByRole('heading', { name: 'Millionaire sign in' })).toBeTruthy()
    expect(screen.getByText(/Manage accounts, content/)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Omkar sign in' })).toBeNull()
  })

  it('supports arrow-key navigation between tabs', async () => {
    fakeBackend(null)
    renderAt('/login')
    const omkarTab = await screen.findByRole('tab', { name: 'Omkar Login' })
    fireEvent.keyDown(omkarTab, { key: 'ArrowRight' })
    expect(selectedTab().textContent).toBe('Millionaire Login')
    expect(document.activeElement).toBe(selectedTab())
    fireEvent.keyDown(selectedTab(), { key: 'ArrowRight' })
    expect(selectedTab().textContent).toBe('Omkar Login')
  })

  it('clears a previous error when switching tabs', async () => {
    fakeBackend(null, { o1: OMKAR })
    renderAt('/login')
    await signIn('o1', 'MILLIONAIRE')
    expect((await screen.findByRole('alert')).textContent).toBe(INVALID)
    fireEvent.click(screen.getByRole('tab', { name: 'Omkar Login' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
