import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_DNA, fakeContentApi } from '../../test/fakeContentApi'
import { MILLIONAIRE, OMKAR, currentPath, fakeBackend, renderAt } from '../../test/utils'

const URL = '/admin/content-studio'

function setup(accounts: Parameters<typeof fakeContentApi>[0] = [{ handle: 'om2_cricket', dna: {} }, { handle: 'om2_food', dna: {} }, { handle: 'no_dna' }]) {
  const api = fakeContentApi(accounts)
  fakeBackend(MILLIONAIRE, {}, api.handler)
  renderAt(URL)
  return api
}

const posts = (api: ReturnType<typeof fakeContentApi>, method: string, path: string) =>
  api.requests.filter((r) => r.method === method && r.url.startsWith(path))
const accountBox = (handle: string) => screen.getByRole('checkbox', { name: new RegExp(`@${handle}`) }) as HTMLInputElement
const generateButton = () => screen.getByRole('button', { name: /^Generate/ })
const draftsFor = (handle: string) => screen.getByRole('article', { name: `Drafts for @${handle}` })

async function ready() {
  await vi.waitFor(() => expect(accountBox('om2_cricket')).toBeTruthy())
}

function openOptions() {
  const toggle = screen.getByRole('button', { name: 'More options' })
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle)
}

async function generate(handles: string[], count = 3) {
  for (const handle of handles) fireEvent.click(accountBox(handle))
  openOptions()
  fireEvent.click(within(screen.getByRole('group', { name: 'Options per account' })).getByLabelText(String(count)))
  fireEvent.click(generateButton())
  await screen.findByRole('region', { name: 'Generated drafts' })
}

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AI Content Studio', () => {
  it('labels the mock provider and lists accounts, disabling those without Content DNA', async () => {
    setup()
    expect(await screen.findByRole('heading', { name: 'Create content for your accounts', level: 1 })).toBeTruthy()
    await ready()
    expect(screen.getByRole('note').textContent).toContain('Mock provider active — no real AI')
    expect(accountBox('om2_cricket').disabled).toBe(false)
    expect(accountBox('no_dna').disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'Set up Content DNA' }).getAttribute('href')).toBe('/admin/x-accounts/3/content-dna')
    expect(screen.getByText('No generations yet.')).toBeTruthy()
  })

  it('generates options for several accounts with CSRF and shows labelled drafts', async () => {
    const api = setup()
    await ready()
    openOptions()
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'POLL' } })
    fireEvent.change(screen.getByLabelText('Instructions for this batch (optional)'), { target: { value: ' Weekend match ' } })
    await generate(['om2_cricket', 'om2_food'], 2)

    const [request] = posts(api, 'POST', '/api/content/generate/')
    expect(request.body).toEqual({ x_account_ids: [1, 2], count: 2, format: 'POLL', instructions: 'Weekend match' })
    expect(request.csrf).toBe('token')
    expect(screen.getByRole('status').textContent).toContain('Generated 4 drafts for 2 accounts.')

    const cricket = draftsFor('om2_cricket')
    const options = within(cricket).getAllByRole('listitem', { name: /^Option/ })
    expect(options).toHaveLength(2)
    expect(within(options[0]).getByText('Mock AI')).toBeTruthy()
    // Warnings are summarised in one line and expand to the full list.
    const warnings = within(options[0]).getByRole('list', { name: 'Warnings' })
    expect(warnings.textContent).toContain('Written by the mock provider')
    expect(warnings.closest('details')?.open).toBe(false)
    expect(within(options[0]).getByRole('list', { name: 'Poll options' })).toBeTruthy()
    expect(within(cricket).getByText(/mock-templates-v1 · 340 tokens/)).toBeTruthy()

    const history = screen.getByRole('region', { name: 'Generation history' })
    await vi.waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(2))
    expect(within(history).getAllByText('Mock')).toHaveLength(2)
  })

  it('filters accounts by Content DNA readiness and shows an empty drafts area', async () => {
    setup()
    await ready()
    expect(screen.getByText('Select accounts to generate')).toBeTruthy()
    const views = screen.getByRole('group', { name: 'Show accounts' })
    expect(within(views).getAllByRole('button').map((b) => b.textContent)).toEqual(['All 3', 'Ready 2', 'Needs DNA 1'])
    fireEvent.click(within(views).getByRole('button', { name: 'Needs DNA 1' }))
    expect(screen.queryByRole('checkbox', { name: /@om2_cricket/ })).toBeNull()
    expect(accountBox('no_dna')).toBeTruthy()
    fireEvent.click(within(views).getByRole('button', { name: 'Ready 2' }))
    expect(screen.queryByRole('checkbox', { name: /@no_dna/ })).toBeNull()
    fireEvent.click(accountBox('om2_food'))
    expect(screen.getByText('Up to 3 drafts across 1 account')).toBeTruthy()
  })

  it('collapses and expands account groups of drafts', async () => {
    setup()
    await ready()
    await generate(['om2_cricket', 'om2_food'], 1)
    const toggle = within(draftsFor('om2_cricket')).getByRole('button', { name: /@om2_cricket/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(within(draftsFor('om2_cricket')).queryByRole('listitem', { name: 'Option 1' })).toBeNull()
    expect(within(draftsFor('om2_food')).getByRole('listitem', { name: 'Option 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(within(draftsFor('om2_cricket')).getByRole('listitem', { name: 'Option 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryAllByRole('listitem', { name: /^Option/ })).toHaveLength(0)
  })

  it('keeps generation settings under More options', async () => {
    setup()
    await ready()
    const toggle = screen.getByRole('button', { name: 'More options' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Format')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('group', { name: 'Options per account' })).toBeTruthy()
    expect(screen.getByLabelText('Instructions for this batch (optional)')).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByLabelText('Format')).toBeNull()
  })

  it('selects every ready account, including ones hidden by search and on later pages', async () => {
    const seeds = Array.from({ length: 105 }, (_, i) => ({ handle: `acct_${String(i).padStart(3, '0')}`, ...(i < 3 ? { dna: {} } : {}) }))
    const api = setup([...seeds, { handle: 'zz_last', dna: {} }])
    await vi.waitFor(() => expect(accountBox('zz_last')).toBeTruthy())
    expect(api.x.requests.filter((r) => r.url.includes('page=2'))).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Filter accounts'), { target: { value: 'acct_001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select all ready' }))
    expect(screen.getByText('4 selected')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Select all ready' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Filter accounts'), { target: { value: '' } })
    expect(accountBox('zz_last').checked).toBe(true)
    expect(accountBox('acct_050').checked).toBe(false)
  })

  it('explains the per-generation account limit and can trim the selection', async () => {
    const api = setup(Array.from({ length: 23 }, (_, i) => ({ handle: `ready_${String(i).padStart(2, '0')}`, dna: {} })))
    await vi.waitFor(() => expect(accountBox('ready_00')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Select all ready' }))
    expect(screen.getByText('23 selected')).toBeTruthy()
    expect(screen.getByText(/Each generation can include up to 20 accounts\. Remove 3/)).toBeTruthy()

    fireEvent.click(generateButton())
    expect(screen.getByRole('alert').textContent).toBe('Choose at most 20 accounts at a time.')
    expect(posts(api, 'POST', '/api/content/generate/')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Keep first 20' }))
    expect(screen.getByText('20 selected')).toBeTruthy()
    expect(screen.queryByText(/Each generation can include/)).toBeNull()
    fireEvent.click(generateButton())
    await screen.findByRole('region', { name: 'Generated drafts' })
    expect((posts(api, 'POST', '/api/content/generate/')[0].body as { x_account_ids: number[] }).x_account_ids).toHaveLength(20)
  })

  it('opens a draft’s history from the review', async () => {
    const api = setup()
    await ready()
    await generate(['om2_cricket'], 1)
    const option = within(draftsFor('om2_cricket')).getByRole('listitem', { name: 'Option 1' })
    fireEvent.click(within(option).getByRole('button', { name: 'History' }))
    const dialog = await screen.findByRole('dialog', { name: 'Post for @om2_cricket' })
    await vi.waitFor(() => expect(posts(api, 'GET', '/api/content/items/1/revisions/')).toHaveLength(1))
    expect(dialog).toBeTruthy()
  })

  it('requires choosing an account', async () => {
    const api = setup()
    await ready()
    fireEvent.click(generateButton())
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one account with Content DNA.')
    expect(posts(api, 'POST', '/api/content/generate/')).toHaveLength(0)
  })

  it('selects all configured accounts and filters the list', async () => {
    setup()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Select all ready' }))
    expect([accountBox('om2_cricket').checked, accountBox('om2_food').checked, accountBox('no_dna').checked]).toEqual([true, true, false])
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Filter accounts'), { target: { value: '@food' } })
    expect(screen.queryByRole('checkbox', { name: /@om2_cricket/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(accountBox('om2_food').checked).toBe(false)
  })

  it('reports accounts that could not be generated', async () => {
    const api = setup()
    await ready()
    api.x.dna.delete(2) // Content DNA removed after the page loaded.
    await generate(['om2_cricket', 'om2_food'], 1)
    expect(screen.getByRole('status').textContent).toContain('1 account could not be generated')
    expect(within(draftsFor('om2_food')).getByRole('alert').textContent).toContain(NO_DNA)
  })

  it('approves a mock draft only after confirming its warnings', async () => {
    const api = setup()
    await ready()
    await generate(['om2_cricket'], 1)
    const option = within(draftsFor('om2_cricket')).getByRole('listitem', { name: 'Option 1' })
    fireEvent.click(within(option).getByRole('button', { name: 'Approve' }))

    const confirm = await screen.findByRole('alertdialog', { name: 'Approve with warnings?' })
    expect(within(confirm).getByText(/Written by the mock provider/)).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve anyway' }))
    await vi.waitFor(() => expect(within(option).getByText('Approved')).toBeTruthy())
    expect(posts(api, 'POST', '/api/content/items/1/approve/')[0].body).toEqual({ acknowledge_warnings: true })
    expect(within(option).queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('rejects a draft with a reason', async () => {
    const api = setup()
    await ready()
    await generate(['om2_cricket'], 1)
    const option = within(draftsFor('om2_cricket')).getByRole('listitem', { name: 'Option 1' })
    fireEvent.click(within(option).getByRole('button', { name: 'Reject' }))
    const dialog = await screen.findByRole('dialog', { name: 'Reject this post?' })
    fireEvent.change(within(dialog).getByLabelText('Reason (optional)'), { target: { value: 'Off-brand' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject post' }))
    await vi.waitFor(() => expect(within(option).getByText('Rejected')).toBeTruthy())
    expect(api.items[0].rejection_reason).toBe('Off-brand')
    expect(within(option).getByRole('button', { name: 'Restore to draft' })).toBeTruthy()
  })

  it('edits a generated draft, sending its version', async () => {
    const api = setup()
    await ready()
    await generate(['om2_cricket'], 1)
    const option = within(draftsFor('om2_cricket')).getByRole('listitem', { name: 'Option 1' })
    fireEvent.click(within(option).getByRole('button', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit post for @om2_cricket' })
    fireEvent.change(within(dialog).getByLabelText('Post'), { target: { value: ' Rewritten by me ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await vi.waitFor(() => expect(within(option).getByText('Rewritten by me')).toBeTruthy())
    expect(posts(api, 'PATCH', '/api/content/items/1/')[0].body).toEqual({
      format: 'TEXT',
      body: 'Rewritten by me',
      thread_posts: [],
      poll_options: [],
      version: 1,
    })
    expect(within(option).queryByText(/Written by the mock provider/)).toBeNull()
  })

  it('writes a manual thread post', async () => {
    const api = setup()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Write manually' }))
    const dialog = await screen.findByRole('dialog', { name: 'Write a post' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }))
    expect(within(dialog).getByText('Choose an X account.')).toBeTruthy()
    expect(within(dialog).getByText('Write the post.')).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText('X account'), { target: { value: '2' } })
    fireEvent.click(within(dialog).getByLabelText('Thread'))
    fireEvent.change(within(dialog).getByLabelText('Post 1'), { target: { value: 'First part' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }))
    expect(within(dialog).getByText('Post 2 is empty.')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Post 2'), { target: { value: 'Second part' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '+ Add post' }))
    fireEvent.change(within(dialog).getByLabelText('Post 3'), { target: { value: 'Third part' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove post 3' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save draft' }))

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByRole('status').textContent).toContain('Draft for @om2_food saved to the Content Library.')
    expect(posts(api, 'POST', '/api/content/items/')[0].body).toEqual({
      x_account_id: 2,
      format: 'THREAD',
      body: '',
      thread_posts: ['First part', 'Second part'],
      poll_options: [],
    })
  })

  it('shows generation failures and load failures with Retry', async () => {
    const api = setup()
    await ready()
    fireEvent.click(accountBox('om2_cricket'))
    api.failures.push(500)
    fireEvent.click(generateButton())
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    cleanup()

    const broken = fakeContentApi([{ handle: 'om2_cricket', dna: {} }])
    broken.failures.push('network')
    fakeBackend(MILLIONAIRE, {}, broken.handler)
    renderAt(URL)
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await ready()
  })

  it('returns to login when the session expires', async () => {
    const api = setup()
    await ready()
    fireEvent.click(accountBox('om2_cricket'))
    api.failures.push(401)
    fireEvent.click(generateButton())
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
  })

  it('redirects Omkars and signed-out visitors without requesting data', async () => {
    for (const user of [OMKAR, null]) {
      const api = fakeContentApi([{ handle: 'secret', dna: {} }])
      fakeBackend(user, {}, api.handler)
      renderAt(URL)
      await vi.waitFor(() => expect(currentPath()).toBe(user ? '/omkar/dashboard' : '/login'))
      expect(api.requests).toHaveLength(0)
      expect(api.x.requests).toHaveLength(0)
      cleanup()
    }
  })
})
