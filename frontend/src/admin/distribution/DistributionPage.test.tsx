import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeDistributionApi, group } from '../../test/fakeDistributionApi'
import { MILLIONAIRE, OMKAR, currentPath, fakeBackend, renderAt } from '../../test/utils'

const URL = '/admin/distribution'

const GROUPS = [
  group(100, 'Ravi', [
    ...Array.from({ length: 6 }, (_, i) => ({ id: i + 1, handle: i % 2 ? 'om2_cricket' : 'om2_food' })),
    { id: 7, handle: 'om2_cricket', sent_at: '2026-11-01T09:00:00Z' },
    { id: 8, handle: 'om2_cricket', unavailable_reason: '@om2_cricket is paused.' },
  ]),
  group(101, 'Sita', [{ id: 9, handle: 'om2_films' }]),
  group(102, 'Vani', [{ id: 10, handle: 'om2_music' }], { unavailable_reason: 'Vani has no WhatsApp number saved.' }),
]

function setup(groups = GROUPS, unassigned = 2) {
  const api = fakeDistributionApi(groups, unassigned)
  fakeBackend(MILLIONAIRE, {}, api.handler)
  renderAt(URL)
  return api
}

const omkar = (name: string) => screen.getByRole('listitem', { name })
const postBox = (id: number, handle: string) => screen.getByRole('checkbox', { name: `Select post ${id} for @${handle}` }) as HTMLInputElement
const prepareButton = () => screen.getByRole('button', { name: /Prepare messages/ })

function stubTab() {
  const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() }
  const open = vi.fn().mockReturnValue(tab)
  vi.stubGlobal('open', open)
  return { tab, open }
}

async function prepareAll(api: ReturnType<typeof fakeDistributionApi>) {
  await screen.findByRole('listitem', { name: 'Ravi' })
  fireEvent.click(screen.getByRole('button', { name: 'Select all ready' }))
  fireEvent.click(prepareButton())
  await screen.findByRole('list', { name: 'Messages in batch 1' })
  return api.batches[0]
}

beforeEach(() => {
  document.cookie = 'csrftoken=token'
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('preparing messages', () => {
  it('groups approved posts by Omkar with readiness and reasons', async () => {
    setup()
    expect(await screen.findByRole('heading', { name: 'Send approved posts to Omkars', level: 1 })).toBeTruthy()
    const ravi = await screen.findByRole('listitem', { name: 'Ravi' })
    expect(within(ravi).getByText('@om2_cricket · @om2_food')).toBeTruthy()
    expect(within(ravi).getByText('8 posts')).toBeTruthy()
    expect(within(ravi).getByText('WhatsApp ready')).toBeTruthy()
    expect(within(ravi).getByText('@om2_cricket is paused.')).toBeTruthy()
    expect(within(ravi).getByText(/^Sent /)).toBeTruthy()
    expect(postBox(8, 'om2_cricket').disabled).toBe(true)
    expect(postBox(7, 'om2_cricket').disabled).toBe(true)

    const vani = omkar('Vani')
    expect(within(vani).getByText('Vani has no WhatsApp number saved.')).toBeTruthy()
    expect(within(vani).queryByText('WhatsApp ready')).toBeNull()
    expect(postBox(10, 'om2_music').disabled).toBe(true)
    expect(screen.getByText(/2 approved posts are on accounts without an Omkar/)).toBeTruthy()
  })

  it('selects all ready posts, a whole Omkar or single posts', async () => {
    setup()
    await screen.findByRole('listitem', { name: 'Ravi' })
    fireEvent.click(screen.getByRole('button', { name: 'Select all ready' }))
    expect(screen.getByText('7 selected')).toBeTruthy() // 6 for Ravi + 1 for Sita; not sent, paused or blocked
    expect(screen.getByText('7 posts for 2 Omkars · about 3 messages')).toBeTruthy()

    const raviBox = screen.getByRole('checkbox', { name: 'Select all posts for Ravi' }) as HTMLInputElement
    fireEvent.click(raviBox)
    expect(screen.getByText('1 selected')).toBeTruthy()
    fireEvent.click(postBox(3, 'om2_food'))
    expect(raviBox.indeterminate).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByText('0 selected')).toBeTruthy()
  })

  it('allows already sent posts only when included on purpose', async () => {
    const api = setup()
    await screen.findByRole('listitem', { name: 'Ravi' })
    fireEvent.click(screen.getByLabelText('Include already sent (1)'))
    fireEvent.click(postBox(7, 'om2_cricket'))
    fireEvent.click(prepareButton())
    await screen.findByRole('list', { name: 'Messages in batch 1' })
    expect(api.requests.find((r) => r.method === 'POST')?.body).toEqual({ item_ids: [7], include_sent: true })
  })

  it('prepares a batch and shows its queue', async () => {
    const api = setup()
    await prepareAll(api)
    const post = api.requests.find((r) => r.method === 'POST')!
    expect(post.body).toEqual({ item_ids: [1, 2, 3, 4, 5, 6, 9], include_sent: false })
    expect(post.csrf).toBe('token')
    expect(screen.getByRole('tab', { name: 'Queue · 3', selected: true })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'Message 1 of 2 for Ravi' })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'Message 2 of 2 for Ravi' })).toBeTruthy()
    expect(within(screen.getByRole('listitem', { name: 'Message 1 of 1 for Sita' })).getByText('Pending')).toBeTruthy()

    // The prepared posts are now locked into the batch.
    fireEvent.click(screen.getByRole('tab', { name: 'Prepare' }))
    expect(await within(await screen.findByRole('listitem', { name: 'Sita' })).findByText('Already in batch 1.')).toBeTruthy()
  })

  it('shows why preparing failed', async () => {
    const api = setup()
    await screen.findByRole('listitem', { name: 'Ravi' })
    api.failures.push({ status: 409, body: { detail: 'Some selected posts can’t be sent any more. Refresh and try again.' } })
    fireEvent.click(postBox(9, 'om2_films'))
    fireEvent.click(prepareButton())
    expect((await screen.findByRole('alert')).textContent).toBe('Some selected posts can’t be sent any more. Refresh and try again.')
    fireEvent.click(prepareButton())
    expect(api.batches).toHaveLength(0)
  })
})

describe('queue', () => {
  it('opens WhatsApp, records it, and asks before opening again', async () => {
    const api = setup()
    await prepareAll(api)
    const row = screen.getByRole('listitem', { name: 'Message 1 of 1 for Sita' })
    const { tab, open } = stubTab()
    fireEvent.click(within(row).getByRole('button', { name: /Open WhatsApp/ }))
    expect(open).toHaveBeenCalledWith('', '_blank')
    await vi.waitFor(() => expect(tab.location.href).toMatch(/^https:\/\/wa\.me\/919876500101\?text=/))
    expect(tab.opener).toBeNull()
    expect(await within(row).findByText('Opened')).toBeTruthy()

    fireEvent.click(within(row).getByRole('button', { name: /Open WhatsApp/ }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Open this message again?' })
    expect(open).toHaveBeenCalledTimes(1)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open again' }))
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    expect(api.batches[0].messages.at(-1)?.open_count).toBe(2)
  })

  it('marks a message as sent only after confirmation', async () => {
    const api = setup()
    await prepareAll(api)
    const row = screen.getByRole('listitem', { name: 'Message 1 of 1 for Sita' })
    fireEvent.click(within(row).getByRole('button', { name: 'Mark as sent' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Mark as sent?' })
    expect(dialog.textContent).toContain('doesn’t mean the posts are published on X')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, I sent it' }))
    expect(await within(row).findByText('Sent (confirmed)')).toBeTruthy()
    expect(within(row).queryByRole('button', { name: /Open WhatsApp/ })).toBeNull()
    expect(api.requests.filter((r) => r.method === 'POST').map((r) => r.url)).toContain(`/api/distribution/messages/${api.batches[0].messages.at(-1)!.id}/confirm-sent/`)
  })

  it('previews, copies and cancels a message', async () => {
    const api = setup()
    await prepareAll(api)
    const row = screen.getByRole('listitem', { name: 'Message 1 of 1 for Sita' })
    fireEvent.click(within(row).getByRole('button', { name: 'Preview' }))
    expect(within(row).getByText(/Post 9 by @om2_films/)).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel message' }))
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Cancel this message?' })).getByRole('button', { name: 'Cancel message' }))
    expect(await within(row).findByText('Cancelled')).toBeTruthy()
    expect(api.batches[0].messages.at(-1)?.status).toBe('CANCELLED')
  })

  it('shows server refusals, such as a stale message', async () => {
    const api = setup()
    await prepareAll(api)
    const { tab } = stubTab()
    api.failures.push({ status: 409, body: { detail: 'A post for @om2_films changed after this message was prepared. Cancel this message and prepare it again.' } })
    fireEvent.click(within(screen.getByRole('listitem', { name: 'Message 1 of 1 for Sita' })).getByRole('button', { name: /Open WhatsApp/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('changed after this message was prepared')
    expect(tab.close).toHaveBeenCalled()
    expect(tab.location.href).toBe('')
  })
})

describe('protection', () => {
  it('redirects Omkars without requesting distribution data', async () => {
    const api = fakeDistributionApi(GROUPS)
    fakeBackend(OMKAR, {}, api.handler)
    renderAt(URL)
    await vi.waitFor(() => expect(currentPath()).toBe('/omkar/dashboard'))
    expect(api.requests).toEqual([])
  })
})

describe('guided distribution', () => {
  const guide = () => screen.getByRole('region', { name: 'Guided distribution' })
  const progress = () => within(guide()).getByRole('progressbar', { name: 'Batch progress' })

  async function startGuided(api: ReturnType<typeof fakeDistributionApi>) {
    await prepareAll(api)
    fireEvent.click(screen.getByRole('button', { name: 'Start distribution' }))
    return guide()
  }

  it('walks through messages: open, confirm sending, then the next one', async () => {
    const api = setup()
    await startGuided(api)
    expect(within(guide()).getByText('Message 1 of 3')).toBeTruthy()
    expect(within(guide()).getByRole('heading', { name: 'Ravi' })).toBeTruthy()
    expect(within(guide()).getByText(/@om2_food · @om2_cricket · 5 posts · part 1 of 2/)).toBeTruthy()
    expect(progress().getAttribute('aria-valuenow')).toBe('0')
    // Before opening there is no way to mark it sent.
    expect(within(guide()).queryByRole('button', { name: 'Yes, I sent it' })).toBeNull()

    const { tab } = stubTab()
    fireEvent.click(within(guide()).getByRole('button', { name: /Open WhatsApp/ }))
    await vi.waitFor(() => expect(tab.location.href).toMatch(/^https:\/\/wa\.me\//))
    expect(await within(guide()).findByText('Did you press Send in WhatsApp?')).toBeTruthy()
    expect(within(guide()).getByText('Opened')).toBeTruthy()
    // Opening alone never counts as sent.
    expect(api.batches[0].messages[0].status).toBe('OPENED')
    expect(progress().getAttribute('aria-valuenow')).toBe('0')

    fireEvent.click(within(guide()).getByRole('button', { name: 'Yes, I sent it' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Mark as sent?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, I sent it' }))
    expect(await within(guide()).findByText('Message 2 of 3')).toBeTruthy()
    expect(api.batches[0].messages[0].status).toBe('SENT')
    expect(progress().getAttribute('aria-valuenow')).toBe('1')
    expect(within(guide()).getByText('1 of 3 messages done')).toBeTruthy()
  })

  it('skips, moves back and forth, previews and copies', async () => {
    const api = setup()
    await startGuided(api)
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    stubTab()
    fireEvent.click(within(guide()).getByRole('button', { name: /Open WhatsApp/ }))
    fireEvent.click(await within(guide()).findByRole('button', { name: 'Skip for now' }))
    expect(within(guide()).getByText('Message 2 of 3')).toBeTruthy()
    // Skipping changes nothing on the server.
    expect(api.batches[0].messages[0].status).toBe('OPENED')

    fireEvent.click(within(guide()).getByRole('button', { name: 'Next →' }))
    expect(within(guide()).getByRole('heading', { name: 'Sita' })).toBeTruthy()
    expect((within(guide()).getByRole('button', { name: 'Next →' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(guide()).getByRole('button', { name: 'Preview' }))
    expect(within(guide()).getByText(/Post 9 by @om2_films/)).toBeTruthy()
    fireEvent.click(within(guide()).getByRole('button', { name: 'Copy message' }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(api.batches[0].messages[2].text))
    expect(await within(guide()).findByRole('button', { name: 'Copied' })).toBeTruthy()

    fireEvent.click(within(guide()).getByRole('button', { name: '← Previous' }))
    fireEvent.click(within(guide()).getByRole('button', { name: '← Previous' }))
    expect(within(guide()).getByText('Message 1 of 3')).toBeTruthy()
    expect(within(guide()).getByText('Did you press Send in WhatsApp?')).toBeTruthy()
  })

  it('resumes after a refresh at the message waiting for confirmation', async () => {
    const api = setup()
    await startGuided(api)
    fireEvent.click(within(guide()).getByRole('button', { name: 'Next →' }))
    stubTab()
    fireEvent.click(within(guide()).getByRole('button', { name: /Open WhatsApp/ }))
    await vi.waitFor(() => expect(api.batches[0].messages[1].status).toBe('OPENED'))

    cleanup()
    fakeBackend(MILLIONAIRE, {}, api.handler)
    renderAt(`${URL}?batch=1&guide=1`)
    const resumed = await screen.findByRole('region', { name: 'Guided distribution' })
    expect(within(resumed).getByText('Message 2 of 3')).toBeTruthy()
    expect(within(resumed).getByText('Did you press Send in WhatsApp?')).toBeTruthy()

    // Back in the queue, the button offers to resume.
    fireEvent.click(within(resumed).getByRole('button', { name: 'Back to queue' }))
    expect(await screen.findByRole('button', { name: 'Resume distribution' })).toBeTruthy()
  })

  it('shows refusals for stale messages and lets you cancel them', async () => {
    const api = setup()
    await startGuided(api)
    const { tab } = stubTab()
    api.failures.push({ status: 409, body: { detail: 'Ravi’s WhatsApp number changed after this message was prepared. Cancel this message and prepare it again.' } })
    fireEvent.click(within(guide()).getByRole('button', { name: /Open WhatsApp/ }))
    const alert = await within(guide()).findByRole('alert')
    expect(alert.textContent).toContain('WhatsApp number changed')
    expect(tab.close).toHaveBeenCalled()

    fireEvent.click(within(alert).getByRole('button', { name: 'Cancel this message' }))
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Cancel this message?' })).getByRole('button', { name: 'Cancel message' }))
    expect(await within(guide()).findByText('Message 2 of 3')).toBeTruthy()
    expect(api.batches[0].messages[0].status).toBe('CANCELLED')
  })

  it('handles already sent messages and finishes the batch', async () => {
    const api = setup()
    await prepareAll(api)
    // Two messages were handled in the queue view first.
    for (const name of ['Message 1 of 2 for Ravi', 'Message 2 of 2 for Ravi']) {
      fireEvent.click(within(screen.getByRole('listitem', { name })).getByRole('button', { name: 'Mark as sent' }))
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Mark as sent?' })).getByRole('button', { name: 'Yes, I sent it' }))
      await within(screen.getByRole('listitem', { name })).findByText('Sent (confirmed)')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Resume distribution' }))
    expect(within(guide()).getByRole('heading', { name: 'Sita' })).toBeTruthy()
    fireEvent.click(within(guide()).getByRole('button', { name: '← Previous' }))
    expect(within(guide()).getByText(/^Marked sent/)).toBeTruthy()
    expect(within(guide()).queryByRole('button', { name: /Open WhatsApp/ })).toBeNull()
    fireEvent.click(within(guide()).getByRole('button', { name: 'Next pending message' }))

    stubTab()
    fireEvent.click(within(guide()).getByRole('button', { name: /Open WhatsApp/ }))
    fireEvent.click(await within(guide()).findByRole('button', { name: 'Yes, I sent it' }))
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Mark as sent?' })).getByRole('button', { name: 'Yes, I sent it' }))
    expect(await within(guide()).findByText('All messages handled')).toBeTruthy()
    expect(progress().getAttribute('aria-valuenow')).toBe('3')
  })
})
