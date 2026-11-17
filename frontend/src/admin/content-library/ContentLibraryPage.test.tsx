import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STALE, fakeContentApi } from '../../test/fakeContentApi'
import { MILLIONAIRE, OMKAR, currentPath, fakeBackend, renderAt } from '../../test/utils'

const URL = '/admin/library'

const ACCOUNTS = [{ handle: 'om2_cricket', dna: {} }, { handle: 'om2_food' }]
const ITEMS: Parameters<typeof fakeContentApi>[1] = [
  { accountId: 1, body: 'Clean manual post about nets' },
  { accountId: 1, body: 'Mock idea about the match', mock: true, theme: 'Cricket' },
  { accountId: 2, body: 'Biryani tonight', status: 'APPROVED' },
  { accountId: 2, format: 'POLL', body: 'Dosa or idli?', poll_options: ['Dosa', 'Idli'], status: 'REJECTED', rejection_reason: 'Done before' },
]

function setup(items = ITEMS) {
  const api = fakeContentApi(ACCOUNTS, items)
  fakeBackend(MILLIONAIRE, {}, api.handler)
  renderAt(URL)
  return api
}

const table = () => screen.getByRole('table')
const rows = () => within(table()).getAllByRole('row').slice(1)
const postTexts = () => rows().map((r) => within(r).getAllByRole('cell')[1].textContent)
const lastList = (api: ReturnType<typeof fakeContentApi>) =>
  api.requests.filter((r) => r.method === 'GET' && r.url.startsWith('/api/content/items/?')).at(-1)!.url
const select = (id: number, handle: string) => fireEvent.click(within(table()).getByRole('checkbox', { name: `Select post ${id} for @${handle}` }))

async function waitForRows(n: number) {
  await vi.waitFor(() => expect(rows()).toHaveLength(n))
}

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Content Library list', () => {
  it('lists posts with status, source and warnings', async () => {
    setup()
    expect(await screen.findByRole('heading', { name: 'Content Library', level: 1 })).toBeTruthy()
    await waitForRows(4)
    const [poll, approved, mock, clean] = rows()
    expect(within(poll).getByText('Rejected')).toBeTruthy()
    expect(within(poll).getAllByRole('cell')[1].textContent).toContain('Dosa or idli? • Dosa • Idli')
    expect(within(approved).getByText('Approved')).toBeTruthy()
    expect(within(mock).getByText('Mock AI')).toBeTruthy()
    expect(within(mock).getByText('⚠ 1 warning')).toBeTruthy()
    expect(within(clean).getByText('Manual')).toBeTruthy()
    expect(screen.getByText('Showing 1–4 of 4')).toBeTruthy()
    // Only drafts can be selected for approval.
    expect((within(approved).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    expect((within(clean).getByRole('checkbox') as HTMLInputElement).disabled).toBe(false)
  })

  it('filters by status, account, source, format, warnings, dates and search', async () => {
    const api = setup()
    await waitForRows(4)
    fireEvent.click(within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name: 'Drafts' }))
    await waitForRows(2)
    expect(lastList(api)).toContain('status=DRAFT')

    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'AI' } })
    await waitForRows(1)
    expect(lastList(api)).toContain('source=AI')

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitForRows(4)

    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '2' } })
    await waitForRows(2)
    expect(lastList(api)).toContain('x_account=2')
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'POLL' } })
    await waitForRows(1)
    expect(lastList(api)).toContain('post_format=POLL')
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))

    fireEvent.click(screen.getByLabelText('Only posts with warnings'))
    await waitForRows(1)
    expect(lastList(api)).toContain('flagged=true')
    fireEvent.click(screen.getByLabelText('Only posts with warnings'))

    fireEvent.change(screen.getByLabelText('Created from'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Created to'), { target: { value: '2026-10-31' } })
    await vi.waitFor(() => expect(lastList(api)).toContain('created_after=2026-10-01&created_before=2026-10-31'))
    await waitForRows(4)

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search posts' }), { target: { value: 'biryani' } })
    await waitForRows(1)
    expect(lastList(api)).toContain('search=biryani')
  })

  it('starts from filters in the URL and removes them with chips', async () => {
    const api = fakeContentApi(ACCOUNTS, ITEMS)
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(`${URL}?source=ai&status=DRAFT&bogus=1`)
    await waitForRows(1)
    expect(lastList(api)).toContain('status=DRAFT&source=AI')
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('AI')
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: AI generated' }))
    await waitForRows(2)
    expect(lastList(api)).not.toContain('source=')
    expect(screen.getByRole('button', { name: 'Drafts' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows a loading skeleton, and a Filters toggle for small screens', async () => {
    setup()
    expect(await screen.findByText('Loading content…')).toBeTruthy()
    await waitForRows(4)
    const toggle = screen.getByRole('button', { name: 'Filters' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'POLL' } })
    await waitForRows(1)
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Filters, 1 active' }))
    expect(screen.getByRole('button', { name: 'Filters, 1 active' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('shows empty states', async () => {
    setup([])
    expect(await screen.findByText('No content yet')).toBeTruthy()
    cleanup()
    setup()
    await waitForRows(4)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing matches' } })
    expect(await screen.findByText('No posts match your filters')).toBeTruthy()
  })

  it('pages through more than 25 posts', async () => {
    const api = setup(Array.from({ length: 30 }, (_, i) => ({ accountId: 1, body: `Post number ${i}` })))
    await waitForRows(25)
    expect(screen.getByText('Page 1 of 2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitForRows(5)
    expect(lastList(api)).toContain('page=2')
    expect(screen.getByText('Showing 26–30 of 30')).toBeTruthy()
  })

  it('shows a load error with Retry', async () => {
    const api = fakeContentApi(ACCOUNTS, ITEMS)
    api.failures.push('network')
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(URL)
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitForRows(4)
  })
})

describe('row actions', () => {
  it('approves and rejects drafts straight from the list', async () => {
    const api = setup()
    await waitForRows(4)
    const clean = rows()[3]
    expect(within(rows()[1]).queryByRole('button', { name: 'Approve' })).toBeNull() // already approved
    fireEvent.click(within(clean).getByRole('button', { name: 'Approve' }))
    expect((await screen.findByRole('status')).textContent).toContain('Post for @om2_cricket approved.')
    await vi.waitFor(() => expect(within(rows()[3]).getByText('Approved')).toBeTruthy())

    fireEvent.click(within(rows()[2]).getByRole('button', { name: 'Reject' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reject this post?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject post' }))
    await vi.waitFor(() => expect(api.items[1].status).toBe('REJECTED'))
  })
})

describe('Send to WhatsApp', () => {
  const WA_URL = 'https://wa.me/919876543210?text=Hi%20Ravi'
  const share = (url: string | null, reason: string | null = null) => ({
    url,
    recipient: { id: 100, display_name: 'Ravi' },
    unavailable_reason: reason,
    x_link_shortened: false,
  })

  const SHORT_URL = 'https://wa.me/919876543210?text=Hi%20Ravi%20https%3A%2F%2Ftinyurl.com%2Fabc'
  function stubTab() {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
    const open = vi.fn().mockReturnValue(tab)
    vi.stubGlobal('open', open)
    return { tab, open }
  }

  it('opens an already shortened link directly, without changing the post', async () => {
    const api = setup([{ accountId: 2, body: 'Biryani tonight', status: 'APPROVED', whatsapp: { ...share(SHORT_URL), x_link_shortened: true } }])
    await waitForRows(1)
    const { open } = stubTab()
    const link = within(rows()[0]).getByRole('link', { name: 'Send to WhatsApp: Ravi' })
    expect(link.getAttribute('href')).toBe(SHORT_URL)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')

    const before = api.requests.length
    fireEvent.click(link)
    expect(open).not.toHaveBeenCalled() // the link's own navigation opens WhatsApp
    expect(api.requests.slice(before)).toEqual([])
    // Nothing is sent to OM2: the post stays Approved, never "sent" or "published".
    expect(api.items[0].status).toBe('APPROVED')
    expect(within(rows()[0]).getByText('Approved')).toBeTruthy()
  })

  it('gets the short link on click for posts approved before shortening', async () => {
    const api = setup([{ accountId: 2, body: 'Biryani tonight', status: 'APPROVED', whatsapp: share(WA_URL) }])
    await waitForRows(1)
    // Opening the post on the server creates the short link.
    api.items[0].whatsapp = { ...share(SHORT_URL), x_link_shortened: true }
    const { tab, open } = stubTab()
    fireEvent.click(within(rows()[0]).getByRole('link', { name: 'Send to WhatsApp: Ravi' }))

    expect(open).toHaveBeenCalledWith('', '_blank')
    await vi.waitFor(() => expect(tab.location.href).toBe(SHORT_URL))
    expect(tab.opener).toBeNull()
    expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([])
    expect(api.requests.at(-1)?.url).toBe(`/api/content/items/${api.items[0].id}/`)
    expect(within(rows()[0]).getByRole('link', { name: 'Send to WhatsApp: Ravi' }).getAttribute('href')).toBe(SHORT_URL)
    expect(api.items[0].status).toBe('APPROVED')
  })

  it('falls back to the full link when the short link cannot be fetched', async () => {
    const api = setup([{ accountId: 2, body: 'Biryani tonight', status: 'APPROVED', whatsapp: share(WA_URL) }])
    await waitForRows(1)
    const { tab } = stubTab()
    api.failures.push(500)
    fireEvent.click(within(rows()[0]).getByRole('link', { name: 'Send to WhatsApp: Ravi' }))
    await vi.waitFor(() => expect(tab.location.href).toBe(WA_URL))
  })

  it('does not open WhatsApp when the post can no longer be sent', async () => {
    const api = setup([{ accountId: 2, body: 'Biryani tonight', status: 'APPROVED', whatsapp: share(WA_URL) }])
    await waitForRows(1)
    api.items[0].whatsapp = share(null, 'Ravi has no WhatsApp number saved.')
    const { tab } = stubTab()
    fireEvent.click(within(rows()[0]).getByRole('link', { name: 'Send to WhatsApp: Ravi' }))
    await vi.waitFor(() => expect(tab.close).toHaveBeenCalled())
    expect(tab.location.href).toBe('')
    expect(within(rows()[0]).getByText('Ravi has no WhatsApp number saved.')).toBeTruthy()
  })

  it('explains why a post cannot be sent', async () => {
    setup([{ accountId: 2, body: 'Biryani tonight', status: 'APPROVED', whatsapp: share(null, 'Ravi has no WhatsApp number saved.') }])
    await waitForRows(1)
    const button = within(rows()[0]).getByRole('button', { name: 'Send to WhatsApp' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe('Ravi has no WhatsApp number saved.')
    expect(within(rows()[0]).queryByRole('link', { name: /Send to WhatsApp/ })).toBeNull()
  })

  it('is not offered for drafts or rejected posts', async () => {
    setup()
    await waitForRows(4)
    expect(screen.queryByRole('link', { name: /Send to WhatsApp/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send to WhatsApp/ })).toBeNull()
  })
})

describe('bulk approval', () => {
  it('approves clean drafts directly', async () => {
    const api = setup()
    await waitForRows(4)
    select(1, 'om2_cricket')
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }))
    expect((await screen.findByRole('status')).textContent).toContain('1 post approved.')
    const request = api.requests.find((r) => r.url === '/api/content/items/bulk-approve/')!
    expect(request.body).toEqual({ ids: [1], acknowledge_warnings: false })
    expect(request.csrf).toBe('token')
    await vi.waitFor(() => expect(within(rows()[3]).getByText('Approved')).toBeTruthy())
  })

  it('asks for confirmation when selected drafts have warnings', async () => {
    const api = setup()
    await waitForRows(4)
    fireEvent.click(within(table()).getByRole('checkbox', { name: 'Select all drafts on this page' }))
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Approve posts with warnings?' })
    expect(confirm.textContent).toContain('1 of the 2 selected posts have warnings')
    expect(api.items.filter((i) => i.status === 'APPROVED')).toHaveLength(1)

    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve all anyway' }))
    expect((await screen.findByRole('status')).textContent).toContain('2 posts approved.')
    expect(api.items.filter((i) => i.status === 'APPROVED')).toHaveLength(3)
    expect(screen.queryByText('2 selected')).toBeNull()
  })
})

describe('post detail', () => {
  async function open(id: number, handle: string) {
    fireEvent.click(within(table()).getByRole('button', { name: `View post ${id} for @${handle}` }))
    const dialog = await screen.findByRole('dialog', { name: `Post for @${handle}` })
    await within(dialog).findByRole('region', { name: 'History' })
    return dialog
  }

  it('shows the post, warnings, metadata, Content DNA used and history', async () => {
    setup()
    await waitForRows(4)
    const dialog = await open(2, 'om2_cricket')
    // Shown in the preview and in the history entry's saved text.
    expect(within(dialog).getAllByText('Mock idea about the match')).toHaveLength(2)
    expect(within(dialog).getByRole('list', { name: 'Warnings' }).textContent).toContain('Written by the mock provider')
    expect(within(dialog).getByText('mock · mock-templates-v1')).toBeTruthy()
    expect(within(dialog).getByText('Content DNA used')).toBeTruthy()
    expect(within(dialog).getByText('Cricket fans')).toBeTruthy()
    expect(within(dialog).getByText(/Created · v1/)).toBeTruthy()
  })

  it('approves from the detail view and refreshes the list', async () => {
    const api = setup()
    await waitForRows(4)
    const dialog = await open(1, 'om2_cricket')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }))
    await vi.waitFor(() => expect(within(dialog).getByText(/Approved · v2/)).toBeTruthy())
    expect(api.items[0].status).toBe('APPROVED')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await vi.waitFor(() => expect(within(rows()[3]).getByText('Approved')).toBeTruthy())
  })

  it('restores a rejected post and shows its reason', async () => {
    setup()
    await waitForRows(4)
    const dialog = await open(4, 'om2_food')
    expect(within(dialog).getByText('Rejected: Done before')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore to draft' }))
    await vi.waitFor(() => expect(within(dialog).getByText(/Restored to draft · v2/)).toBeTruthy())
    expect(within(dialog).getByRole('button', { name: 'Edit' })).toBeTruthy()
  })

  it('edits an approved post, which returns it to draft', async () => {
    const api = setup()
    await waitForRows(4)
    const dialog = await open(3, 'om2_food')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
    const editor = await screen.findByRole('dialog', { name: 'Edit post for @om2_food' })
    expect(editor.textContent).toContain('Saving changes returns it to draft')
    fireEvent.change(within(editor).getByLabelText('Post'), { target: { value: 'Biryani tomorrow' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
    await vi.waitFor(() => expect(within(dialog).getByText(/Edited · v2/)).toBeTruthy())
    expect(api.items[2].status).toBe('DRAFT')
    expect(within(dialog).getByText('Edited after approval; needs approval again.')).toBeTruthy()
  })

  it('shows server validation and version conflicts in the editor', async () => {
    const api = setup()
    await waitForRows(4)
    const dialog = await open(1, 'om2_cricket')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
    const editor = await screen.findByRole('dialog', { name: 'Edit post for @om2_cricket' })
    api.items[0].version = 5 // Changed in another session.
    fireEvent.change(within(editor).getByLabelText('Post'), { target: { value: 'My edit' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
    expect((await within(editor).findByRole('alert')).textContent).toBe(STALE)
    expect(api.items[0].body).toBe('Clean manual post about nets')
  })

  it('rejects over-long posts before saving', async () => {
    const api = setup()
    await waitForRows(4)
    const dialog = await open(1, 'om2_cricket')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }))
    const editor = await screen.findByRole('dialog', { name: 'Edit post for @om2_cricket' })
    fireEvent.change(within(editor).getByLabelText('Post'), { target: { value: 'x'.repeat(281) } })
    expect(within(editor).getByText('281/280')).toBeTruthy()
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }))
    expect(within(editor).getByText('The post is over 280 characters.')).toBeTruthy()
    expect(api.requests.some((r) => r.method === 'PATCH')).toBe(false)
  })
})

describe('writing and protection', () => {
  it('writes a poll from the library', async () => {
    const api = setup()
    await waitForRows(4)
    fireEvent.click(screen.getByRole('button', { name: 'Write a post' }))
    const editor = await screen.findByRole('dialog', { name: 'Write a post' })
    fireEvent.change(within(editor).getByLabelText('X account'), { target: { value: '1' } })
    fireEvent.click(within(editor).getByLabelText('Poll'))
    fireEvent.change(within(editor).getByLabelText('Poll question'), { target: { value: 'Tea or coffee?' } })
    fireEvent.change(within(editor).getByLabelText('Option 1'), { target: { value: 'Tea' } })
    fireEvent.change(within(editor).getByLabelText('Option 2'), { target: { value: 'tea' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save draft' }))
    expect(within(editor).getByText('Option 2 repeats another option.')).toBeTruthy()
    fireEvent.change(within(editor).getByLabelText('Option 2'), { target: { value: 'Coffee' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Save draft' }))
    expect((await screen.findByRole('status')).textContent).toContain('Draft for @om2_cricket saved.')
    await waitForRows(5)
    expect(postTexts()[0]).toContain('Tea or coffee?')
    expect(api.items.at(-1)?.poll_options).toEqual(['Tea', 'Coffee'])
  })

  it('redirects Omkars and signed-out visitors without requesting data', async () => {
    for (const user of [OMKAR, null]) {
      const api = fakeContentApi(ACCOUNTS, ITEMS)
      fakeBackend(user, {}, api.handler)
      renderAt(URL)
      await vi.waitFor(() => expect(currentPath()).toBe(user ? '/omkar/dashboard' : '/login'))
      expect(api.requests).toHaveLength(0)
      cleanup()
    }
  })
})
