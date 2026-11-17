import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BAD_HANDLE, DUPLICATE, fakeXAccountsApi } from '../../test/fakeXAccountsApi'
import { MILLIONAIRE, OMKAR, currentPath, fakeBackend, renderAt } from '../../test/utils'

const URL = '/admin/x-accounts'

function setup(seed: Parameters<typeof fakeXAccountsApi>[0] = []) {
  const api = fakeXAccountsApi(seed)
  const fetchMock = fakeBackend(MILLIONAIRE, {}, api.handler)
  renderAt(URL)
  return { api, fetchMock }
}

const table = () => screen.getByRole('table')
/** Handles shown in the desktop table, in order. */
const tableHandles = () =>
  within(table())
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent)
const total = () => screen.getByTestId('account-total').textContent
const dialog = () => screen.getByRole('dialog')
const field = (label: string) => within(dialog()).getByLabelText(label) as HTMLInputElement

async function waitForHandles(expected: string[]) {
  await vi.waitFor(() => expect(tableHandles()).toEqual(expected))
}

function fill(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } })
}

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('listing accounts', () => {
  it('shows a loading state, then the accounts with total against the target', async () => {
    setup([
      { handle: 'om2_telugu', display_name: 'Telugu Thoughts' },
      { handle: 'om2_cricket', display_name: 'Cricket Daily', status: 'PAUSED' },
    ])
    expect(await screen.findByRole('heading', { name: 'X Accounts', level: 1 })).toBeTruthy()
    expect(screen.getByText('Loading X accounts…')).toBeTruthy()

    await waitForHandles(['@om2_cricket', '@om2_telugu'])
    expect(total()).toBe('2')
    expect(screen.getByText('of 100 target')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2')

    const [, cricket] = within(table()).getAllByRole('row')
    const cells = within(cricket).getAllByRole('cell').map((c) => c.textContent)
    expect(cells.slice(0, 6)).toEqual(['@om2_cricket', 'Cricket Daily', 'Unassigned', 'Paused', 'Not configured', '24 Oct 2026'])
    expect(within(cricket).getByRole('button', { name: 'Edit @om2_cricket' })).toBeTruthy()
    expect(screen.getByText('Showing 1–2 of 2')).toBeTruthy()
  })

  it('renders a mobile list with the same accounts and edit actions', async () => {
    setup([{ handle: 'om2_telugu', display_name: 'Telugu Thoughts' }])
    const list = await screen.findByRole('list', { name: 'X accounts' })
    const item = within(list).getByRole('listitem')
    expect(within(item).getByText('@om2_telugu')).toBeTruthy()
    expect(within(item).getByText('Telugu Thoughts')).toBeTruthy()
    fireEvent.click(within(item).getByRole('button', { name: 'Edit @om2_telugu' }))
    expect(dialog()).toBeTruthy()
  })

  it('shows an empty state with an add action when there are no accounts', async () => {
    setup()
    expect(await screen.findByText('No X accounts yet')).toBeTruthy()
    expect(total()).toBe('0')
    expect(screen.queryByRole('table')).toBeNull()
    const emptyAdd = screen.getAllByRole('button', { name: /Add X Account/ })
    fireEvent.click(emptyAdd[emptyAdd.length - 1])
    expect(within(dialog()).getByRole('heading', { name: 'Add X Account' })).toBeTruthy()
  })
})

describe('search and status filter', () => {
  const seed = [
    { handle: 'om2_telugu', display_name: 'Telugu Thoughts' },
    { handle: 'om2_cricket', display_name: 'Cricket Daily', status: 'PAUSED' as const },
    { handle: 'daily_poems', display_name: 'Evening Poetry' },
  ]

  it('searches by handle or display name (debounced) and keeps the overall total', async () => {
    const { api } = setup(seed)
    await waitForHandles(['@daily_poems', '@om2_cricket', '@om2_telugu'])

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search accounts' }), { target: { value: 'poetry' } })
    await waitForHandles(['@daily_poems'])
    expect(api.requests.at(-1)?.url).toContain('search=poetry')
    expect(total()).toBe('3')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '@om2' } })
    await waitForHandles(['@om2_cricket', '@om2_telugu'])
  })

  it('applies the search immediately on Enter', async () => {
    const { api } = setup(seed)
    await waitForHandles(['@daily_poems', '@om2_cricket', '@om2_telugu'])
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'telugu' } })
    fireEvent.submit(search)
    await waitForHandles(['@om2_telugu'])
    expect(api.requests.filter((r) => r.url.includes('search=telugu'))).toHaveLength(1)
  })

  it('filters by status', async () => {
    const { api } = setup(seed)
    await waitForHandles(['@daily_poems', '@om2_cricket', '@om2_telugu'])
    const group = screen.getByRole('group', { name: 'Filter by status' })
    expect(within(group).getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(within(group).getByRole('button', { name: 'Paused' }))
    await waitForHandles(['@om2_cricket'])
    expect(api.requests.at(-1)?.url).toContain('status=PAUSED')
    expect(within(group).getByRole('button', { name: 'Paused' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(within(group).getByRole('button', { name: 'Active' }))
    await waitForHandles(['@daily_poems', '@om2_telugu'])

    fireEvent.click(within(group).getByRole('button', { name: 'All' }))
    await waitForHandles(['@daily_poems', '@om2_cricket', '@om2_telugu'])
  })

  it('shows a filtered empty state that can clear the filters', async () => {
    setup(seed)
    await waitForHandles(['@daily_poems', '@om2_cricket', '@om2_telugu'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing-here' } })
    expect(await screen.findByText('No accounts match your filters')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitForHandles(['@daily_poems', '@om2_cricket', '@om2_telugu'])
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  })
})

describe('creating an account', () => {
  it('creates an account with CSRF, then refreshes the list and total', async () => {
    const { api } = setup([{ handle: 'om2_telugu', display_name: 'Telugu Thoughts' }])
    await waitForHandles(['@om2_telugu'])

    fireEvent.click(screen.getByRole('button', { name: 'Add X Account' }))
    expect(within(dialog()).getByRole('heading', { name: 'Add X Account' })).toBeTruthy()
    expect(document.activeElement).toBe(field('X handle'))
    expect(field('Status').value).toBe('ACTIVE')

    fill('X handle', '@New_Account')
    fill('Display name', '  New Account  ')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))

    await waitForHandles(['@new_account', '@om2_telugu'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('@new_account was added.')
    expect(total()).toBe('2')

    const post = api.requests.find((r) => r.method === 'POST')
    expect(post?.body).toEqual({ handle: '@New_Account', display_name: 'New Account', status: 'ACTIVE' })
    expect(post?.csrf).toBe('token')
  })

  it('refreshes the overall total after creating while a filter is active', async () => {
    setup([{ handle: 'paused_one', status: 'PAUSED' }])
    await waitForHandles(['@paused_one'])
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Paused' }))
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Paused' }).getAttribute('aria-pressed')).toBe('true'))

    fireEvent.click(screen.getByRole('button', { name: 'Add X Account' }))
    fill('X handle', 'second')
    fill('Display name', 'Second')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))
    await vi.waitFor(() => expect(total()).toBe('2'))
    expect(tableHandles()).toEqual(['@paused_one'])
  })

  it('cancels without saving, also via Escape', async () => {
    const { api } = setup()
    await screen.findByText('No X accounts yet')
    fireEvent.click(screen.getAllByRole('button', { name: /Add X Account/ })[0])
    fill('X handle', 'draft')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /Add X Account/ })[0])
    expect(field('X handle').value).toBe('')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.requests.some((r) => r.method !== 'GET')).toBe(false)
  })
})

describe('editing an account', () => {
  it('prefills the form and saves changes with PATCH', async () => {
    const { api } = setup([
      { handle: 'om2_telugu', display_name: 'Telugu Thoughts' },
      { handle: 'zz_other', display_name: 'Other' },
    ])
    await waitForHandles(['@om2_telugu', '@zz_other'])

    fireEvent.click(within(table()).getByRole('button', { name: 'Edit @om2_telugu' }))
    expect(within(dialog()).getByRole('heading', { name: 'Edit @om2_telugu' })).toBeTruthy()
    expect(field('X handle').value).toBe('om2_telugu')
    expect(field('Display name').value).toBe('Telugu Thoughts')
    expect(field('Status').value).toBe('ACTIVE')

    fill('Display name', 'Telugu Reflections')
    fireEvent.change(field('Status'), { target: { value: 'PAUSED' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))

    await vi.waitFor(() => expect(within(table()).getByText('Telugu Reflections')).toBeTruthy())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('@om2_telugu was updated.')
    const row = within(table()).getAllByRole('row')[1]
    expect(within(row).getByText('Paused')).toBeTruthy()

    const patch = api.requests.find((r) => r.method === 'PATCH')
    expect(patch?.url).toBe('/api/x-accounts/1/')
    expect(patch?.body).toEqual({ handle: 'om2_telugu', display_name: 'Telugu Reflections', status: 'PAUSED' })
    expect(patch?.csrf).toBe('token')
  })

  it('shows a duplicate-handle error when renaming to an existing handle', async () => {
    const { api } = setup([{ handle: 'taken' }, { handle: 'mine' }])
    await waitForHandles(['@mine', '@taken'])
    fireEvent.click(within(table()).getByRole('button', { name: 'Edit @mine' }))
    fill('X handle', 'TAKEN')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))

    expect(await within(dialog()).findByText(DUPLICATE)).toBeTruthy()
    expect(field('X handle').getAttribute('aria-invalid')).toBe('true')
    expect(api.accounts.find((a) => a.id === 2)?.handle).toBe('mine')
  })
})

describe('validation errors', () => {
  async function openAdd() {
    const result = setup([{ handle: 'om2_network', display_name: 'OM2 Network' }])
    await waitForHandles(['@om2_network'])
    fireEvent.click(screen.getByRole('button', { name: 'Add X Account' }))
    return result
  }

  it('requires handle and display name before calling the API', async () => {
    const { api } = await openAdd()
    fill('Display name', '   ')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))

    expect(within(dialog()).getByText('Enter the X handle.')).toBeTruthy()
    expect(within(dialog()).getByText('Enter a display name.')).toBeTruthy()
    expect(field('X handle').getAttribute('aria-invalid')).toBe('true')
    expect(api.requests.some((r) => r.method === 'POST')).toBe(false)
  })

  it('shows the backend duplicate-handle error on the handle field', async () => {
    await openAdd()
    fill('X handle', '@OM2_Network')
    fill('Display name', 'Copy')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))

    const message = await within(dialog()).findByText(DUPLICATE)
    expect(field('X handle').getAttribute('aria-describedby')).toBe(message.id)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(tableHandles()).toEqual(['@om2_network'])
  })

  it('shows the backend handle-format error and allows correcting it', async () => {
    const { api } = await openAdd()
    fill('X handle', 'bad-handle!')
    fill('Display name', 'Bad')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))
    expect(await within(dialog()).findByText(BAD_HANDLE)).toBeTruthy()

    fill('X handle', 'good_handle')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))
    await waitForHandles(['@good_handle', '@om2_network'])
    expect(api.requests.filter((r) => r.method === 'POST')).toHaveLength(2)
  })
})

describe('pagination', () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ handle: `acct_${String(i).padStart(3, '0')}` }))

  it('pages through results with Previous and Next', async () => {
    const { api } = setup(many)
    await vi.waitFor(() => expect(tableHandles()).toHaveLength(50))
    expect(tableHandles()[0]).toBe('@acct_000')
    expect(screen.getByText('Showing 1–50 of 120')).toBeTruthy()
    expect(screen.getByText('Page 1 of 3')).toBeTruthy()
    expect(total()).toBe('120')
    const previous = () => screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement
    const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement
    expect(previous().disabled).toBe(true)

    fireEvent.click(next())
    await vi.waitFor(() => expect(tableHandles()[0]).toBe('@acct_050'))
    expect(screen.getByText('Showing 51–100 of 120')).toBeTruthy()
    expect(api.requests.at(-1)?.url).toContain('page=2')

    fireEvent.click(next())
    await vi.waitFor(() => expect(tableHandles()).toHaveLength(20))
    expect(screen.getByText('Showing 101–120 of 120')).toBeTruthy()
    expect(next().disabled).toBe(true)

    fireEvent.click(previous())
    await vi.waitFor(() => expect(tableHandles()[0]).toBe('@acct_050'))
  })

  it('returns to page 1 when the filters change', async () => {
    const { api } = setup(many)
    await vi.waitFor(() => expect(tableHandles()).toHaveLength(50))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await vi.waitFor(() => expect(tableHandles()[0]).toBe('@acct_050'))
    fireEvent.click(screen.getByRole('button', { name: 'Active' }))
    await vi.waitFor(() => expect(tableHandles()[0]).toBe('@acct_000'))
    expect(api.requests.at(-1)?.url).not.toContain('page=')
  })

  it('hides pagination controls when everything fits on one page', async () => {
    setup([{ handle: 'only_one' }])
    await waitForHandles(['@only_one'])
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
  })
})

describe('API failures', () => {
  it('shows an error with Retry when the list cannot load', async () => {
    const api = fakeXAccountsApi([{ handle: 'om2_network' }])
    api.failures.push('network')
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(URL)

    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitForHandles(['@om2_network'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the dialog open with a message when saving fails on the server', async () => {
    const { api } = setup()
    await screen.findByText('No X accounts yet')
    fireEvent.click(screen.getAllByRole('button', { name: /Add X Account/ })[0])
    fill('X handle', 'server_down')
    fill('Display name', 'Server Down')
    api.failures.push(500)
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))

    expect((await within(dialog()).findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    expect(field('X handle').value).toBe('server_down')
    expect((within(dialog()).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows a permission message on 403', async () => {
    const api = fakeXAccountsApi()
    api.failures.push(403)
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(URL)
    expect((await screen.findByRole('alert')).textContent).toContain('do not have permission')
  })

  it('returns to the login page when the session has expired', async () => {
    const api = fakeXAccountsApi()
    api.failures.push(401)
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(URL)
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
  })
})

describe('role protection', () => {
  it('redirects an Omkar to their dashboard without requesting X accounts', async () => {
    const api = fakeXAccountsApi([{ handle: 'secret' }])
    fakeBackend(OMKAR, {}, api.handler)
    renderAt(URL)
    expect(await screen.findByText('Omkar Dashboard — Coming Soon')).toBeTruthy()
    expect(currentPath()).toBe('/omkar/dashboard')
    expect(api.requests).toHaveLength(0)
  })

  it('redirects signed-out visitors to login without requesting X accounts', async () => {
    const api = fakeXAccountsApi([{ handle: 'secret' }])
    fakeBackend(null, {}, api.handler)
    renderAt(URL)
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
    expect(api.requests).toHaveLength(0)
  })

  it('is reachable from the sidebar and marks X Accounts active', async () => {
    const api = fakeXAccountsApi()
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt('/admin/dashboard')
    const nav = (await screen.findAllByRole('navigation', { name: 'Admin' }))[0]
    fireEvent.click(within(nav).getByRole('link', { name: 'X Accounts' }))
    expect(await screen.findByRole('heading', { name: 'X Accounts', level: 1 })).toBeTruthy()
    expect(within(nav).getByRole('link', { name: 'X Accounts' }).getAttribute('aria-current')).toBe('page')
  })
})
