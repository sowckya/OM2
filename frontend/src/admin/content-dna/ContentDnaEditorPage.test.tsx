import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DNA_EXISTS, VALID_DNA, fakeXAccountsApi } from '../../test/fakeXAccountsApi'
import { MILLIONAIRE, OMKAR, currentPath, fakeBackend, json, renderAt, type ExtraRoutes } from '../../test/utils'

const EDITOR = '/admin/x-accounts/1/content-dna'

const CONFIGURED = {
  ...VALID_DNA,
  primary_themes: ['Cricket', 'Telugu cinema'],
  tone: ['Witty'],
  example_posts: ['Rain at Uppal again.'],
}

function setup(dna?: Partial<typeof VALID_DNA>, wrap?: (handler: ExtraRoutes) => ExtraRoutes, path = EDITOR) {
  const api = fakeXAccountsApi([{ handle: 'om2_cricket', display_name: 'Cricket Daily', dna }])
  fakeBackend(MILLIONAIRE, {}, wrap ? wrap(api.handler) : api.handler)
  const view = renderAt(path)
  return { api, ...view }
}

const dnaRequests = (api: ReturnType<typeof fakeXAccountsApi>, method: string) =>
  api.requests.filter((r) => r.method === method && r.url.endsWith('/content-dna/'))
const group = (name: string) => screen.getByRole('group', { name })
const chips = (name: string) =>
  within(group(name))
    .queryAllByRole('button', { name: /^Edit / })
    .map((b) => b.textContent)
const addEntry = (groupName: string, itemLabel: string, value: string, viaButton = false) => {
  const input = within(group(groupName)).getByRole('textbox', { name: `Add ${itemLabel}` })
  fireEvent.change(input, { target: { value } })
  if (viaButton) fireEvent.click(within(group(groupName)).getByRole('button', { name: 'Add' }))
  else fireEvent.keyDown(input, { key: 'Enter' })
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const submit = () => fireEvent.click(screen.getByRole('button', { name: /Create Content DNA|Save changes/ }))
const alertText = () => screen.getAllByRole('alert').map((a) => a.textContent).join(' ')

async function editorReady() {
  return screen.findByRole('form', { name: 'Content DNA' })
}

function fillRequired() {
  addEntry('Primary themes', 'primary theme', '  Cricket ')
  addEntry('Primary themes', 'primary theme', 'Telugu cinema', true)
  fireEvent.click(within(group('Languages')).getByLabelText(/English/))
  fireEvent.click(within(group('Languages')).getByLabelText(/Tinglish/))
  fireEvent.click(within(group('Tone')).getByRole('button', { name: 'Add tone Witty' }))
  type('Target audience', ' Cricket fans in Hyderabad ')
  type('Writing style', 'Short lines')
  fireEvent.click(within(group('Allowed formats')).getByLabelText(/Poll/))
  type('Daily posting target', '4')
}

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('X Accounts page', () => {
  it('shows each account’s Content DNA state and links to the editor', async () => {
    const api = fakeXAccountsApi([{ handle: 'has_dna', dna: {} }, { handle: 'no_dna' }])
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt('/admin/x-accounts')
    const table = await screen.findByRole('table')
    await vi.waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
    const [, first, second] = within(table).getAllByRole('row')
    expect(within(first).getByText('Configured')).toBeTruthy()
    expect(within(second).getByText('Not configured')).toBeTruthy()

    fireEvent.click(within(second).getByRole('link', { name: 'Content DNA for @no_dna' }))
    await editorReady()
    expect(currentPath()).toBe('/admin/x-accounts/2/content-dna')
    expect(screen.getByText('@no_dna')).toBeTruthy()
  })
})

describe('creating Content DNA', () => {
  it('loads an unconfigured account with an empty form', async () => {
    setup()
    expect(await screen.findByText('Loading Content DNA…')).toBeTruthy()
    await editorReady()
    expect(screen.getByRole('heading', { name: 'Content DNA', level: 1 })).toBeTruthy()
    expect(screen.getByText('Not configured')).toBeTruthy()
    expect(screen.getByText(/doesn’t have Content DNA yet/)).toBeTruthy()
    expect(chips('Primary themes')).toEqual([])
    expect((screen.getByLabelText('Daily posting target') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Create Content DNA' })).toBeTruthy()
  })

  it('creates a profile through the API with CSRF and trimmed values', async () => {
    const { api } = setup()
    await editorReady()
    fillRequired()
    addEntry('Secondary themes', 'secondary theme', 'Hyderabad food')
    addEntry('Topics to avoid', 'topic to avoid', 'Politics')
    fireEvent.click(screen.getByRole('button', { name: '+ Add example post' }))
    type('Example 1', ' Chai and cricket. ')
    type('Additional instructions (optional)', 'No hashtags')
    submit()

    expect((await screen.findByRole('status')).textContent).toContain('Content DNA created for this account.')
    const [post] = dnaRequests(api, 'POST')
    expect(post.csrf).toBe('token')
    expect(post.body).toEqual({
      primary_themes: ['Cricket', 'Telugu cinema'],
      secondary_themes: ['Hyderabad food'],
      languages: ['ENGLISH', 'TINGLISH'],
      tone: ['Witty'],
      target_audience: 'Cricket fans in Hyderabad',
      writing_style: 'Short lines',
      allowed_formats: ['POLL'],
      topics_to_avoid: ['Politics'],
      example_posts: ['Chai and cricket.'],
      daily_post_target: 4,
      additional_instructions: 'No hashtags',
    })
    expect(screen.getByText('Configured')).toBeTruthy()
    expect(screen.getByText('All changes saved')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
    expect(api.dna.get(1)?.daily_post_target).toBe(4)
  })

  it('checks required fields before calling the API', async () => {
    const { api } = setup()
    await editorReady()
    type('Daily posting target', '0')
    submit()
    expect(alertText()).toContain('Please fix the highlighted fields.')
    for (const message of [
      'Add at least one primary theme.',
      'Choose at least one language.',
      'Add at least one tone.',
      'Describe the target audience.',
      'Describe the writing style.',
      'Choose at least one format.',
      'Choose between 1 and 20 posts per day.',
    ]) {
      expect(screen.getByText(message)).toBeTruthy()
    }
    expect(screen.getByLabelText('Daily posting target').getAttribute('aria-invalid')).toBe('true')
    expect(dnaRequests(api, 'POST')).toHaveLength(0)

    // Fixing a field clears its message.
    addEntry('Primary themes', 'primary theme', 'Cricket')
    expect(screen.queryByText('Add at least one primary theme.')).toBeNull()
  })

  it('rejects blank, duplicate and too many entries in lists', async () => {
    setup()
    await editorReady()
    addEntry('Primary themes', 'primary theme', '   ')
    expect(within(group('Primary themes')).getByText('Type a primary theme first.')).toBeTruthy()
    addEntry('Primary themes', 'primary theme', 'Cricket')
    addEntry('Primary themes', 'primary theme', 'CRICKET')
    expect(within(group('Primary themes')).getByText('“CRICKET” is already listed.')).toBeTruthy()
    for (const theme of ['Two', 'Three', 'Four', 'Five']) addEntry('Primary themes', 'primary theme', theme)
    expect(chips('Primary themes')).toEqual(['Cricket', 'Two', 'Three', 'Four', 'Five'])
    const input = within(group('Primary themes')).getByRole('textbox', { name: 'Add primary theme' }) as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(within(group('Primary themes')).getByText('5 of 5')).toBeTruthy()
  })

  it('rejects an empty example post', async () => {
    const { api } = setup()
    await editorReady()
    fillRequired()
    fireEvent.click(screen.getByRole('button', { name: '+ Add example post' }))
    submit()
    expect(screen.getByText('Example 1 is empty. Write it or remove it.')).toBeTruthy()
    expect(dnaRequests(api, 'POST')).toHaveLength(0)
  })

  it('shows a conflict when another session created the profile first', async () => {
    const { api } = setup()
    await editorReady()
    fillRequired()
    api.dna.set(1, { ...VALID_DNA, tone: ['Calm'], x_account: 1, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' })
    submit()
    expect(await screen.findByText(/created for this account in another session/)).toBeTruthy()
    expect(dnaRequests(api, 'POST')).toHaveLength(1)
    expect(DNA_EXISTS).toContain('already has Content DNA')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await vi.waitFor(() => expect(chips('Tone')).toEqual(['Calm']))
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
  })
})

describe('editing Content DNA', () => {
  it('loads the saved profile', async () => {
    setup(CONFIGURED)
    await editorReady()
    expect(screen.getByText('Configured')).toBeTruthy()
    expect(screen.getByText(/Last saved 24 Oct 2026/)).toBeTruthy()
    expect(chips('Primary themes')).toEqual(['Cricket', 'Telugu cinema'])
    expect((within(group('Languages')).getByLabelText(/English/) as HTMLInputElement).checked).toBe(true)
    expect((within(group('Languages')).getByLabelText(/Telugu/) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('Example 1') as HTMLTextAreaElement).value).toBe('Rain at Uppal again.')
    expect((screen.getByLabelText('Daily posting target') as HTMLInputElement).value).toBe('3')
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('edits and removes individual entries, sending only changed fields', async () => {
    const { api } = setup(CONFIGURED)
    await editorReady()
    fireEvent.click(screen.getByRole('button', { name: 'Edit primary theme Telugu cinema' }))
    const editInput = within(group('Primary themes')).getByRole('textbox', { name: 'Edit primary theme Telugu cinema' })
    fireEvent.change(editInput, { target: { value: 'Tollywood' } })
    fireEvent.keyDown(editInput, { key: 'Enter' })
    expect(chips('Primary themes')).toEqual(['Cricket', 'Tollywood'])

    fireEvent.click(screen.getByRole('button', { name: 'Add tone Warm' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove tone Witty' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove example 1' }))
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    submit()

    expect((await screen.findByRole('status')).textContent).toContain('Content DNA saved.')
    const [patch] = dnaRequests(api, 'PATCH')
    expect(patch.csrf).toBe('token')
    expect(patch.body).toEqual({ primary_themes: ['Cricket', 'Tollywood'], tone: ['Warm'], example_posts: [] })
    expect(api.dna.get(1)?.tone).toEqual(['Warm'])
    expect(screen.getByText('All changes saved')).toBeTruthy()
  })

  it('cancels an inline edit with Escape and rejects duplicates when editing', async () => {
    setup(CONFIGURED)
    await editorReady()
    fireEvent.click(screen.getByRole('button', { name: 'Edit primary theme Cricket' }))
    let input = within(group('Primary themes')).getByRole('textbox', { name: 'Edit primary theme Cricket' })
    fireEvent.change(input, { target: { value: 'Something' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(chips('Primary themes')).toEqual(['Cricket', 'Telugu cinema'])

    fireEvent.click(screen.getByRole('button', { name: 'Edit primary theme Cricket' }))
    input = within(group('Primary themes')).getByRole('textbox', { name: 'Edit primary theme Cricket' })
    fireEvent.change(input, { target: { value: 'telugu CINEMA' } })
    fireEvent.click(within(group('Primary themes')).getByRole('button', { name: 'Done' }))
    expect(within(group('Primary themes')).getByText('“telugu CINEMA” is already listed.')).toBeTruthy()
  })

  it('shows server validation errors beside the field and keeps the edits', async () => {
    const message = '“Cricket” is already a primary theme.'
    const { api } = setup(CONFIGURED, (handler) => async (url, init) =>
      init?.method === 'PATCH' ? json(400, { secondary_themes: [message] }) : handler(url, init),
    )
    await editorReady()
    addEntry('Secondary themes', 'secondary theme', 'Cricket ')
    submit()
    expect(await within(group('Secondary themes')).findByText(message)).toBeTruthy()
    expect(alertText()).toContain('Please fix the highlighted fields.')
    expect(chips('Secondary themes')).toEqual(['Cricket'])
    expect(api.dna.get(1)?.secondary_themes).toEqual([])
  })

  it('discards unsaved changes', async () => {
    setup(CONFIGURED)
    await editorReady()
    fireEvent.click(screen.getByRole('button', { name: 'Remove primary theme Cricket' }))
    type('Daily posting target', '9')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(chips('Primary themes')).toEqual(['Cricket', 'Telugu cinema'])
    expect((screen.getByLabelText('Daily posting target') as HTMLInputElement).value).toBe('3')
    expect(screen.getByText('All changes saved')).toBeTruthy()
  })
})

describe('unsaved changes', () => {
  async function leaveViaSidebar() {
    const nav = screen.getAllByRole('navigation', { name: 'Admin' })[0]
    fireEvent.click(within(nav).getByRole('link', { name: 'Dashboard' }))
  }

  it('asks before leaving, and can stay or leave', async () => {
    setup(CONFIGURED)
    await editorReady()
    type('Writing style', 'Changed style')
    await leaveViaSidebar()
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stay on page' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(currentPath()).toBe(EDITOR)
    expect((screen.getByLabelText('Writing style') as HTMLTextAreaElement).value).toBe('Changed style')

    await leaveViaSidebar()
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave page' }))
    await vi.waitFor(() => expect(currentPath()).toBe('/admin/dashboard'))
  })

  it('does not ask when there are no changes or after saving', async () => {
    setup(CONFIGURED)
    await editorReady()
    type('Writing style', 'Changed style')
    submit()
    await screen.findByRole('status')
    await leaveViaSidebar()
    await vi.waitFor(() => expect(currentPath()).toBe('/admin/dashboard'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('warns when closing or reloading the tab only while changes are unsaved', async () => {
    setup(CONFIGURED)
    await editorReady()
    const unload = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(unload()).toBe(false)
    type('Writing style', 'Changed style')
    expect(unload()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(unload()).toBe(false)
  })
})

describe('failures and protection', () => {
  it('shows a load error with Retry', async () => {
    const { api } = setup(CONFIGURED, (handler) => {
      let failed = false
      return async (url, init) => {
        if (!failed && url.endsWith('/content-dna/')) {
          failed = true
          throw new TypeError('Failed to fetch')
        }
        return handler(url, init)
      }
    })
    expect((await screen.findByRole('alert')).textContent).toContain("Can't reach the OM2 server")
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await editorReady()
    expect(chips('Primary themes')).toEqual(['Cricket', 'Telugu cinema'])
    expect(api.requests.length).toBeGreaterThan(2)
  })

  it('keeps edits and shows an error when saving fails', async () => {
    const { api } = setup(CONFIGURED)
    await editorReady()
    type('Writing style', 'Changed style')
    api.failures.push(500)
    submit()
    expect(await screen.findByText(/Can't reach the OM2 server/)).toBeTruthy()
    expect((screen.getByLabelText('Writing style') as HTMLTextAreaElement).value).toBe('Changed style')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(api.dna.get(1)?.writing_style).toBe(VALID_DNA.writing_style)
  })

  it('reports an unknown account without Retry', async () => {
    setup(undefined, undefined, '/admin/x-accounts/99/content-dna')
    expect((await screen.findByRole('alert')).textContent).toBe('That X account could not be found.')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'X Accounts' }).getAttribute('href')).toBe('/admin/x-accounts')
  })

  it('rejects a malformed account id without requesting it', async () => {
    const { api } = setup(undefined, undefined, '/admin/x-accounts/abc/content-dna')
    expect((await screen.findByRole('alert')).textContent).toBe('That X account could not be found.')
    expect(api.requests).toHaveLength(0)
  })

  it('returns to login when the session expires', async () => {
    const { api } = setup(CONFIGURED)
    await editorReady()
    type('Writing style', 'Changed style')
    api.failures.push(401)
    submit()
    await vi.waitFor(() => expect(currentPath()).toBe('/login'))
  })

  it('redirects Omkars and signed-out visitors without requesting data', async () => {
    for (const user of [OMKAR, null]) {
      const api = fakeXAccountsApi([{ handle: 'secret', dna: {} }])
      fakeBackend(user, {}, api.handler)
      renderAt(EDITOR)
      await vi.waitFor(() => expect(currentPath()).toBe(user ? '/omkar/dashboard' : '/login'))
      expect(api.requests).toHaveLength(0)
      cleanup()
    }
  })
})
