import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MILLIONAIRE,
  MILLIONAIRE_HEADING,
  OMKAR,
  currentPath,
  fakeBackend,
  renderAt,
} from '../test/utils'

const NAV_LABELS = [
  'Dashboard',
  'X Accounts',
  'Omkars',
  'AI Content Studio',
  'Content Library',
  'Calendar',
  'Distribution',
  'Analytics',
  'Settings',
]

/** The always-rendered desktop sidebar (the mobile drawer is a separate dialog). */
const desktopNav = () => screen.getAllByRole('navigation', { name: 'Admin' })[0]

async function renderDashboard(path = '/admin/dashboard') {
  fakeBackend(MILLIONAIRE)
  renderAt(path)
  await screen.findByRole('navigation', { name: 'Admin' })
}

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Millionaire dashboard', () => {
  it('renders the welcome heading and user in the header', async () => {
    await renderDashboard()
    expect(screen.getByRole('heading', MILLIONAIRE_HEADING)).toBeTruthy()
    expect(within(screen.getByRole('banner')).getByText('Mona M')).toBeTruthy()
  })

  it('shows honest zero counts with the network targets', async () => {
    await renderDashboard()
    const card = (name: string) => screen.getByRole('article', { name })

    expect(within(card('Total X Accounts')).getByText('of 100 target')).toBeTruthy()
    expect(within(card('Total Omkars')).getByText('of 50 target')).toBeTruthy()
    for (const name of ['Total X Accounts', 'Total Omkars', 'Ready Posts', 'Published Today']) {
      expect(within(card(name)).getByTestId('stat-value').textContent).toBe('0')
    }
    for (const bar of screen.getAllByRole('progressbar')) {
      expect(bar.getAttribute('aria-valuenow')).toBe('0')
    }
  })

  it("shows empty states for today's overview and recent activity", async () => {
    await renderDashboard()
    const overview = screen.getByRole('region', { name: "Today's Publishing Overview" })
    expect(within(overview).getByText('No posts scheduled for today')).toBeTruthy()
    for (const status of ['Scheduled', 'Available to Omkar', 'Submitted', 'Verified Published']) {
      expect(within(overview).getByText(status).nextElementSibling?.textContent).toBe('0')
    }
    const activity = screen.getByRole('region', { name: 'Recent Activity' })
    expect(within(activity).getByText('No activity yet')).toBeTruthy()
  })

  it('only calls the auth API (no business data is fetched or invented)', async () => {
    const fetchMock = fakeBackend(MILLIONAIRE)
    renderAt('/admin/dashboard')
    await screen.findByRole('heading', MILLIONAIRE_HEADING)
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.every((url) => url.startsWith('/api/auth/'))).toBe(true)
  })
})

describe('sidebar navigation', () => {
  it('lists all modules without Coming Soon badges', async () => {
    await renderDashboard()
    const links = within(desktopNav()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(NAV_LABELS)
    expect(within(desktopNav()).queryByText('Coming Soon')).toBeNull()
  })

  it('highlights the active page', async () => {
    await renderDashboard()
    const nav = desktopNav()
    expect(within(nav).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: /X Accounts/ }).getAttribute('aria-current')).toBeNull()
  })

  it('navigates to a Coming Soon module inside the layout', async () => {
    await renderDashboard()
    fireEvent.click(within(desktopNav()).getByRole('link', { name: /Calendar/ }))

    expect(currentPath()).toBe('/admin/calendar')
    expect(screen.getByRole('heading', { name: 'Calendar', level: 1 })).toBeTruthy()
    expect(within(screen.getByRole('main')).getByText('Coming Soon')).toBeTruthy()
    expect(within(desktopNav()).getByRole('link', { name: /Calendar/ }).getAttribute('aria-current')).toBe('page')
    expect(within(desktopNav()).getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('heading', MILLIONAIRE_HEADING)).toBeNull()
  })

  it('renders module placeholders on direct visits (refresh)', async () => {
    await renderDashboard('/admin/settings')
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy()
    expect(currentPath()).toBe('/admin/settings')
  })
})

describe('mobile menu', () => {
  const menuButton = () => screen.getByRole('button', { name: 'Open navigation menu' })
  const drawer = () => screen.queryByRole('dialog', { name: 'Navigation menu' })

  it('opens and closes with the menu and close buttons', async () => {
    await renderDashboard()
    expect(menuButton().getAttribute('aria-expanded')).toBe('false')
    expect(drawer()).toBeNull()

    fireEvent.click(menuButton())
    expect(menuButton().getAttribute('aria-expanded')).toBe('true')
    const dialog = drawer()!
    expect(within(dialog).getAllByRole('link')).toHaveLength(NAV_LABELS.length)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close navigation menu' }))

    fireEvent.click(screen.getByRole('button', { name: 'Close navigation menu' }))
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(menuButton())
  })

  it('closes on Escape and on backdrop click', async () => {
    await renderDashboard()
    fireEvent.click(menuButton())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(drawer()).toBeNull()

    fireEvent.click(menuButton())
    fireEvent.click(screen.getByTestId('sidebar-backdrop'))
    expect(drawer()).toBeNull()
  })

  it('closes after choosing a page', async () => {
    await renderDashboard()
    fireEvent.click(menuButton())
    fireEvent.click(within(drawer()!).getByRole('link', { name: /Calendar/ }))
    expect(drawer()).toBeNull()
    expect(currentPath()).toBe('/admin/calendar')
  })
})

describe('role protection and logout', () => {
  it.each(['/admin/dashboard', '/admin/x-accounts', '/admin/settings'])(
    'redirects an Omkar away from %s',
    async (path) => {
      fakeBackend(OMKAR)
      renderAt(path)
      expect(await screen.findByText('Omkar Dashboard — Coming Soon')).toBeTruthy()
      expect(currentPath()).toBe('/omkar/dashboard')
      expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull()
    },
  )

  it.each(['/admin/dashboard', '/admin/calendar'])('redirects signed-out visitors from %s', async (path) => {
    fakeBackend(null)
    renderAt(path)
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull()
  })

  it('keeps the Omkar dashboard unchanged (no admin layout)', async () => {
    fakeBackend(OMKAR)
    renderAt('/omkar/dashboard')
    expect(await screen.findByText('Omkar Dashboard — Coming Soon')).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Logout' })).toBeTruthy()
  })

  it('logs out from the admin header', async () => {
    await renderDashboard('/admin/analytics')
    fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Logout' }))
    expect(await screen.findByRole('tablist', { name: 'Login type' })).toBeTruthy()
    expect(currentPath()).toBe('/login')
  })
})
