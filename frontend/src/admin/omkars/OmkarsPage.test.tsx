import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DUPLICATE_EMAIL, DUPLICATE_USERNAME, PHONE_NUMBER, WEAK_PASSWORD, fakeManagementApi } from '../../test/fakeOmkarsApi'
import { INACTIVE_OMKAR, LIMIT_REACHED } from '../../test/fakeXAccountsApi'
import { MILLIONAIRE, OMKAR, currentPath, fakeBackend, renderAt } from '../../test/utils'

const URL = '/admin/omkars'

type Seeds = Parameters<typeof fakeManagementApi>

function setup(omkars: Seeds[0] = [], accounts: Seeds[1] = [], path = URL) {
  const api = fakeManagementApi(omkars, accounts)
  fakeBackend(MILLIONAIRE, {}, api.handler)
  renderAt(path)
  return api
}

const table = () => screen.getByRole('table')
const row = (username: string) => within(table()).getByText(username, { selector: 'td' }).closest('tr')!
const usernames = () =>
  within(table())
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[1].textContent)
const total = () => screen.getByTestId('omkar-total').textContent
const dialog = () => screen.getByRole('dialog')
const field = (label: string) => within(dialog()).getByLabelText(label) as HTMLInputElement
const fill = (label: string, value: string) => fireEvent.change(field(label), { target: { value } })
const save = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }))
const chips = (username: string) =>
  within(row(username))
    .queryAllByRole('button', { name: /^Unassign/ })
    .map((b) => b.getAttribute('aria-label'))

async function waitForUsernames(expected: string[]) {
  await vi.waitFor(() => expect(usernames()).toEqual(expected))
}

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('listing Omkars', () => {
  it('shows loading, then Omkars with assigned accounts and the total against 50', async () => {
    setup(
      [
        { username: 'ravi', first_name: 'Ravi', last_name: 'Kumar', email: 'ravi@example.com' },
        { username: 'sita', first_name: 'Sita', is_active: false },
      ],
      [{ handle: 'telugu_one', omkarId: 100 }, { handle: 'cricket', omkarId: 100 }],
    )
    expect(await screen.findByRole('heading', { name: 'Omkars', level: 1 })).toBeTruthy()
    expect(screen.getByText('Loading Omkars…')).toBeTruthy()

    await waitForUsernames(['ravi', 'sita'])
    expect(total()).toBe('2')
    expect(screen.getByText('of 50 target')).toBeTruthy()
    const cells = within(row('ravi')).getAllByRole('cell').map((c) => c.textContent)
    expect(cells.slice(0, 4)).toEqual(['Ravi Kumar', 'ravi', 'ravi@example.com', 'Active'])
    expect(chips('ravi')).toEqual(['Unassign @cricket from ravi', 'Unassign @telugu_one from ravi'])
    expect(within(row('sita')).getByText('Inactive')).toBeTruthy()
    expect(within(row('sita')).getByText('No accounts')).toBeTruthy()
  })

  it('renders a mobile list with the same actions', async () => {
    setup([{ username: 'ravi', first_name: 'Ravi' }])
    const list = await screen.findByRole('list', { name: 'Omkars' })
    const item = within(list).getByRole('listitem')
    expect(within(item).getByRole('button', { name: 'Edit ravi' })).toBeTruthy()
    expect(within(item).getByRole('button', { name: 'Assign X account to ravi' })).toBeTruthy()
  })

  it('shows an empty state with an Add Omkar action', async () => {
    setup()
    expect(await screen.findByText('No Omkars yet')).toBeTruthy()
    expect(total()).toBe('0')
    const buttons = screen.getAllByRole('button', { name: /Add Omkar/ })
    fireEvent.click(buttons[buttons.length - 1])
    expect(within(dialog()).getByRole('heading', { name: 'Add Omkar' })).toBeTruthy()
  })
})

describe('search, filters and pagination', () => {
  const omkars = [
    { username: 'ravi', first_name: 'Ravi', last_name: 'Kumar' },
    { username: 'anil', first_name: 'Anil', last_name: 'Kumar', is_active: false },
    { username: 'sita', first_name: 'Sita', email: 'sita@mail.test' },
  ]

  it('searches by name, username or email and keeps the overall total', async () => {
    const api = setup(omkars)
    await waitForUsernames(['anil', 'ravi', 'sita'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Omkars' }), { target: { value: 'kumar' } })
    await waitForUsernames(['anil', 'ravi'])
    expect(api.requests.at(-1)?.url).toContain('search=kumar')
    expect(total()).toBe('3')

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'mail.test' } })
    await waitForUsernames(['sita'])
  })

  it('filters Active and Inactive', async () => {
    const api = setup(omkars)
    await waitForUsernames(['anil', 'ravi', 'sita'])
    const group = screen.getByRole('group', { name: 'Filter by status' })
    fireEvent.click(within(group).getByRole('button', { name: 'Inactive' }))
    await waitForUsernames(['anil'])
    expect(api.requests.at(-1)?.url).toContain('is_active=false')
    fireEvent.click(within(group).getByRole('button', { name: 'Active' }))
    await waitForUsernames(['ravi', 'sita'])
    fireEvent.click(within(group).getByRole('button', { name: 'All' }))
    await waitForUsernames(['anil', 'ravi', 'sita'])
  })

  it('shows a filtered empty state that clears filters', async () => {
    setup(omkars)
    await waitForUsernames(['anil', 'ravi', 'sita'])
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nobody' } })
    expect(await screen.findByText('No Omkars match your filters')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitForUsernames(['anil', 'ravi', 'sita'])
  })

  it('pages through more than 50 Omkars', async () => {
    const many = Array.from({ length: 75 }, (_, i) => ({ username: `omkar_${String(i).padStart(2, '0')}` }))
    const api = setup(many)
    await vi.waitFor(() => expect(usernames()).toHaveLength(50))
    expect(screen.getByText('Showing 1–50 of 75')).toBeTruthy()
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await vi.waitFor(() => expect(usernames()).toHaveLength(25))
    expect(usernames()[0]).toBe('omkar_50')
    expect(api.requests.at(-1)?.url).toContain('page=2')
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await vi.waitFor(() => expect(usernames()[0]).toBe('omkar_00'))
  })
})

describe('creating and editing Omkars', () => {
  it('creates an Omkar with an initial password, then refreshes the list', async () => {
    const api = setup([{ username: 'ravi' }])
    await waitForUsernames(['ravi'])
    fireEvent.click(screen.getByRole('button', { name: 'Add Omkar' }))
    expect(document.activeElement).toBe(field('Username'))
    expect(field('Initial password').type).toBe('password')
    expect(field('Initial password').autocomplete).toBe('new-password')

    fill('Username', 'sita_r')
    fill('First name', ' Sita ')
    fill('Email', 'sita@example.com')
    fill('WhatsApp number (optional)', '+91 98765 43210')
    fill('Initial password', 'Vivid-Mango-2026!')
    save()

    await waitForUsernames(['ravi', 'sita_r'])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Omkar sita_r was added.')
    expect(total()).toBe('2')
    const post = api.requests.find((r) => r.method === 'POST' && r.url.startsWith('/api/omkars/'))
    expect(post?.body).toEqual({
      username: 'sita_r',
      first_name: 'Sita',
      last_name: '',
      email: 'sita@example.com',
      phone_number: '+91 98765 43210',
      password: 'Vivid-Mango-2026!',
    })
    expect(api.omkars.find((o) => o.username === 'sita_r')?.phone_number).toBe('+919876543210')
    expect(post?.csrf).toBe('token')
    // Passwords are never shown back.
    expect(document.body.textContent).not.toContain('Vivid-Mango-2026!')
  })

  it('requires username, first name, email and password before calling the API', async () => {
    const api = setup()
    await screen.findByText('No Omkars yet')
    fireEvent.click(screen.getAllByRole('button', { name: /Add Omkar/ })[0])
    save()
    for (const message of ['Enter a username.', 'Enter a first name.', 'Enter an email address.', 'Enter an initial password.']) {
      expect(within(dialog()).getByText(message)).toBeTruthy()
    }
    expect(api.requests.some((r) => r.method === 'POST')).toBe(false)
  })

  it('shows backend validation errors beside the relevant fields', async () => {
    setup([{ username: 'ravi', email: 'ravi@example.com' }])
    await waitForUsernames(['ravi'])
    fireEvent.click(screen.getByRole('button', { name: 'Add Omkar' }))
    fill('Username', 'RAVI')
    fill('First name', 'Copy')
    fill('Email', 'RAVI@example.com')
    fill('Initial password', 'short')
    save()

    for (const [label, message] of [
      ['Username', DUPLICATE_USERNAME],
      ['Email', DUPLICATE_EMAIL],
      ['Initial password', WEAK_PASSWORD],
    ]) {
      const error = await within(dialog()).findByText(message)
      expect(field(label).getAttribute('aria-describedby')).toBe(error.id)
      expect(field(label).getAttribute('aria-invalid')).toBe('true')
    }
    expect(usernames()).toEqual(['ravi'])
  })

  it('edits profile and status without sending username or password', async () => {
    const api = setup(
      [{ username: 'ravi', first_name: 'Ravi', last_name: 'Kumar', email: 'ravi@example.com' }],
      [{ handle: 'kept_acct', omkarId: 100 }],
    )
    await waitForUsernames(['ravi'])
    fireEvent.click(within(row('ravi')).getByRole('button', { name: 'Edit ravi' }))

    expect(field('Username').value).toBe('ravi')
    expect(field('Username').disabled).toBe(true)
    expect(within(dialog()).queryByLabelText('Initial password')).toBeNull()
    expect(field('First name').value).toBe('Ravi')
    expect(field('Status').value).toBe('active')

    fill('Last name (optional)', 'Teja')
    fireEvent.change(field('Status'), { target: { value: 'inactive' } })
    save()

    await vi.waitFor(() => expect(within(row('ravi')).getByText('Inactive')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toContain('Omkar ravi was updated.')
    const patch = api.requests.find((r) => r.method === 'PATCH')
    expect(patch?.url).toBe('/api/omkars/100/')
    expect(patch?.body).toEqual({ first_name: 'Ravi', last_name: 'Teja', email: 'ravi@example.com', phone_number: '', is_active: false })
    // Existing assignments are kept, but no new ones can be added.
    expect(chips('ravi')).toEqual(['Unassign @kept_acct from ravi'])
    expect((within(row('ravi')).getByRole('button', { name: 'Assign X account to ravi' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('edits the WhatsApp number and shows the country code error', async () => {
    const api = setup([{ username: 'ravi', phone_number: '+919876543210' }])
    await waitForUsernames(['ravi'])
    fireEvent.click(within(row('ravi')).getByRole('button', { name: 'Edit ravi' }))
    expect(field('WhatsApp number (optional)').value).toBe('+919876543210')
    expect(field('WhatsApp number (optional)').type).toBe('tel')

    fill('WhatsApp number (optional)', '98765 43210')
    save()
    const error = await within(dialog()).findByText(PHONE_NUMBER)
    expect(field('WhatsApp number (optional)').getAttribute('aria-describedby')).toBe(error.id)
    expect(api.omkars[0].phone_number).toBe('+919876543210')

    fill('WhatsApp number (optional)', '')
    save()
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(api.omkars[0].phone_number).toBe('')
  })

  it('shows a duplicate email error when editing', async () => {
    setup([{ username: 'ravi', email: 'ravi@example.com' }, { username: 'sita', email: 'sita@example.com' }])
    await waitForUsernames(['ravi', 'sita'])
    fireEvent.click(within(row('sita')).getByRole('button', { name: 'Edit sita' }))
    fill('Email', 'Ravi@Example.com')
    save()
    expect(await within(dialog()).findByText(DUPLICATE_EMAIL)).toBeTruthy()
  })
})

describe('X account assignment', () => {
  const omkars = [
    { username: 'ravi', first_name: 'Ravi' },
    { username: 'sita', first_name: 'Sita' },
  ]

  async function openAssign(username: string) {
    fireEvent.click(within(row(username)).getByRole('button', { name: `Assign X account to ${username}` }))
    return screen.findByRole('dialog', { name: new RegExp(`Assign X account to`) })
  }

  it('assigns an unassigned account with CSRF and refreshes the Omkar', async () => {
    const api = setup(omkars, [{ handle: 'free_one' }, { handle: 'free_two' }, { handle: 'taken', omkarId: 101 }])
    await waitForUsernames(['ravi', 'sita'])
    const assign = await openAssign('ravi')

    await vi.waitFor(() => expect(within(assign).getAllByRole('radio')).toHaveLength(2))
    expect(within(assign).queryByText('@taken')).toBeNull()
    expect(api.x.requests.at(-1)?.url).toContain('assigned=false')

    fireEvent.click(within(assign).getByLabelText(/@free_two/))
    fireEvent.click(within(assign).getByRole('button', { name: 'Assign' }))

    await vi.waitFor(() => expect(chips('ravi')).toEqual(['Unassign @free_two from ravi']))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('@free_two was assigned to ravi.')
    const patch = api.x.requests.find((r) => r.method === 'PATCH')
    expect(patch?.url).toBe('/api/x-accounts/2/')
    expect(patch?.body).toEqual({ assigned_omkar_id: 100 })
    expect(patch?.csrf).toBe('token')
  })

  it('requires choosing an account', async () => {
    const api = setup(omkars, [{ handle: 'free_one' }])
    await waitForUsernames(['ravi', 'sita'])
    const assign = await openAssign('ravi')
    await within(assign).findByRole('radio')
    fireEvent.click(within(assign).getByRole('button', { name: 'Assign' }))
    expect(within(assign).getByRole('alert').textContent).toBe('Choose an X account to assign.')
    expect(api.x.requests.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('reassigns an account from another Omkar', async () => {
    setup(omkars, [{ handle: 'moving', omkarId: 101 }])
    await waitForUsernames(['ravi', 'sita'])
    expect(chips('sita')).toEqual(['Unassign @moving from sita'])
    const assign = await openAssign('ravi')
    expect(await within(assign).findByText('No unassigned X accounts available.')).toBeTruthy()

    fireEvent.click(within(assign).getByLabelText(/Include accounts assigned to other Omkars/))
    fireEvent.click(await within(assign).findByLabelText(/@moving/))
    expect(within(assign).getByText(/Assigned to Sita/)).toBeTruthy()
    expect(within(assign).getByText('This will move @moving from Sita to Ravi.')).toBeTruthy()
    fireEvent.click(within(assign).getByRole('button', { name: 'Reassign' }))

    await vi.waitFor(() => expect(chips('ravi')).toEqual(['Unassign @moving from ravi']))
    expect(chips('sita')).toEqual([])
  })

  it('unassigns an account', async () => {
    const api = setup(omkars, [{ handle: 'leaving', omkarId: 100 }])
    await waitForUsernames(['ravi', 'sita'])
    fireEvent.click(within(row('ravi')).getByRole('button', { name: 'Unassign @leaving from ravi' }))
    await vi.waitFor(() => expect(chips('ravi')).toEqual([]))
    expect(screen.getByRole('status').textContent).toContain('@leaving was unassigned from ravi.')
    expect(api.x.requests.find((r) => r.method === 'PATCH')?.body).toEqual({ assigned_omkar_id: null })
    expect(api.accounts[0].omkarId).toBeNull()
  })

  it('disables assigning once an Omkar has two accounts', async () => {
    setup(omkars, [{ handle: 'one', omkarId: 100 }, { handle: 'two', omkarId: 100 }, { handle: 'three' }])
    await waitForUsernames(['ravi', 'sita'])
    const button = within(row('ravi')).getByRole('button', { name: 'Assign X account to ravi' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Already has 2 X accounts')
    expect((within(row('sita')).getByRole('button', { name: 'Assign X account to sita' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the server limit error when another change fills the Omkar first', async () => {
    const api = setup(omkars, [{ handle: 'one', omkarId: 100 }, { handle: 'two' }, { handle: 'three' }])
    await waitForUsernames(['ravi', 'sita'])
    const assign = await openAssign('ravi')
    fireEvent.click(await within(assign).findByLabelText(/@three/))
    api.accounts.find((a) => a.handle === 'two')!.omkarId = 100 // concurrent assignment elsewhere
    fireEvent.click(within(assign).getByRole('button', { name: 'Assign' }))

    expect((await within(assign).findByRole('alert')).textContent).toBe(LIMIT_REACHED)
    expect(api.accounts.find((a) => a.handle === 'three')!.omkarId).toBeNull()
  })

  it('shows the server error when the Omkar was deactivated meanwhile', async () => {
    const api = setup(omkars, [{ handle: 'free' }])
    await waitForUsernames(['ravi', 'sita'])
    const assign = await openAssign('ravi')
    fireEvent.click(await within(assign).findByLabelText(/@free/))
    api.omkars[0].is_active = false
    fireEvent.click(within(assign).getByRole('button', { name: 'Assign' }))
    expect((await within(assign).findByRole('alert')).textContent).toBe(INACTIVE_OMKAR)
  })

  it('blocks assigning to inactive Omkars in the UI', async () => {
    setup([{ username: 'gone', is_active: false }], [{ handle: 'free' }])
    await waitForUsernames(['gone'])
    const button = within(row('gone')).getByRole('button', { name: 'Assign X account to gone' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Inactive Omkars can’t receive accounts')
  })

  it('shows assigned Omkars on the X Accounts page', async () => {
    setup([{ username: 'ravi', first_name: 'Ravi', last_name: 'Kumar', is_active: false }], [{ handle: 'owned', omkarId: 100 }, { handle: 'free' }], '/admin/x-accounts')
    await vi.waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3))
    const rows = within(screen.getByRole('table')).getAllByRole('row')
    expect(within(rows[1]).getAllByRole('cell')[2].textContent).toBe('Unassigned')
    expect(within(rows[2]).getAllByRole('cell')[2].textContent).toBe('Ravi Kumar (ravi)Inactive')
  })
})

describe('failures and protection', () => {
  it('shows an error with Retry when Omkars cannot load', async () => {
    const api = fakeManagementApi([{ username: 'ravi' }])
    api.failures.push('network')
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(URL)
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitForUsernames(['ravi'])
  })

  it('shows an error when unassigning fails and keeps the account', async () => {
    const api = setup([{ username: 'ravi' }], [{ handle: 'stays', omkarId: 100 }])
    await waitForUsernames(['ravi'])
    api.x.failures.push(500)
    fireEvent.click(within(row('ravi')).getByRole('button', { name: 'Unassign @stays from ravi' }))
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    expect(chips('ravi')).toEqual(['Unassign @stays from ravi'])
  })

  it('returns to login when the session expires', async () => {
    const api = fakeManagementApi()
    api.failures.push(401)
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(URL)
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
  })

  it('redirects Omkars and signed-out visitors without requesting data', async () => {
    for (const user of [OMKAR, null]) {
      const api = fakeManagementApi([{ username: 'secret' }])
      fakeBackend(user, {}, api.handler)
      renderAt(URL)
      await vi.waitFor(() => expect(currentPath()).toBe(user ? '/omkar/dashboard' : '/login'))
      expect(api.requests).toHaveLength(0)
      expect(api.x.requests).toHaveLength(0)
      cleanup()
    }
  })

  it('is reachable from the sidebar', async () => {
    setup([], [], '/admin/dashboard')
    const nav = (await screen.findAllByRole('navigation', { name: 'Admin' }))[0]
    fireEvent.click(within(nav).getByRole('link', { name: 'Omkars' }))
    expect(await screen.findByRole('heading', { name: 'Omkars', level: 1 })).toBeTruthy()
    expect(within(nav).getByRole('link', { name: 'Omkars' }).getAttribute('aria-current')).toBe('page')
  })
})
