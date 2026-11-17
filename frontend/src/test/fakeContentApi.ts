import type { ContentItem, GenerationRun, Revision, Warning } from '../api/content'
import { fakeXAccountsApi, type RecordedRequest } from './fakeXAccountsApi'
import { MILLIONAIRE, json } from './utils'

export const MOCK_WARNING: Warning = {
  code: 'MOCK_CONTENT',
  message: 'Written by the mock provider as sample text. Rewrite it before approving.',
}
export const NO_DNA = 'Content DNA is not configured for this account. Set it up before generating.'
export const STALE = 'This post was changed by someone else. Reload it to see the latest version.'

type AccountSeed = Parameters<typeof fakeXAccountsApi>[0]
type ItemSeed = Partial<Omit<ContentItem, 'x_account'>> & { accountId: number; mock?: boolean }

const person = { id: MILLIONAIRE.id, username: MILLIONAIRE.username, display_name: MILLIONAIRE.display_name }
const AT = '2026-10-25T10:00:00Z'

/**
 * In-memory stand-in for /api/content/ (plus /api/x-accounts/), mirroring the Django
 * rules the UI depends on: warnings needing acknowledgement, review transitions,
 * version conflicts, filters, pagination and the CSRF header.
 */
export function fakeContentApi(accountSeed: AccountSeed = [], itemSeed: ItemSeed[] = []) {
  const x = fakeXAccountsApi(accountSeed)
  let nextItem = 1
  let nextRun = 1
  const items: ContentItem[] = []
  const runs: GenerationRun[] = []
  const revisions = new Map<number, Revision[]>()
  const requests: RecordedRequest[] = []
  const failures: Array<'network' | number> = []

  const summary = (accountId: number) => {
    const a = x.accounts.find((acc) => acc.id === accountId)!
    return { id: a.id, handle: a.handle, display_name: a.display_name }
  }

  function record(item: ContentItem, action: Revision['action'], note = '') {
    const list = revisions.get(item.id) ?? []
    list.unshift({
      id: list.length + 1,
      version: item.version,
      action,
      status: item.status,
      format: item.format,
      body: item.body,
      thread_posts: item.thread_posts,
      poll_options: item.poll_options,
      note,
      changed_by: person,
      created_at: AT,
    })
    revisions.set(item.id, list)
  }

  function makeItem(seed: ItemSeed): ContentItem {
    const { accountId, mock, ...rest } = seed
    const validation = [...(mock ? [MOCK_WARNING] : []), ...(rest.validation_flags ?? [])]
    const item: ContentItem = {
      id: nextItem++,
      x_account: summary(accountId),
      source: mock ? 'AI' : 'MANUAL',
      status: 'DRAFT',
      format: 'TEXT',
      body: '',
      thread_posts: [],
      poll_options: [],
      theme: '',
      language: '',
      duplicate_flags: [],
      rejection_reason: '',
      generation: mock ? { id: 1, provider: 'mock', model_name: 'mock-templates-v1', is_mock: true } : null,
      created_by: person,
      reviewed_by: null,
      reviewed_at: null,
      version: 1,
      created_at: AT,
      updated_at: AT,
      whatsapp: null,
      dna_snapshot: x.dna.get(accountId) ?? null,
      ...rest,
      validation_flags: validation,
      warnings: validation,
    }
    items.push(item)
    record(item, 'CREATED')
    return item
  }

  itemSeed.forEach(makeItem)

  function refreshWarnings(item: ContentItem) {
    item.warnings = [
      ...item.validation_flags,
      ...item.duplicate_flags.map((f) => ({ code: 'DUPLICATE', message: `${f.kind} match: ${f.label}` })),
    ]
  }

  async function handler(url: string, init?: RequestInit): Promise<Response | undefined> {
    if (url.startsWith('/api/x-accounts/')) return x.handler(url, init)
    if (!url.startsWith('/api/content/')) return undefined
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    requests.push({ method, url, body: init?.body ? body : undefined, csrf: headers['X-CSRFToken'] ?? null })

    const failure = failures.shift()
    if (failure === 'network') throw new TypeError('Failed to fetch')
    if (failure) return json(failure, { detail: 'Server error.' })
    if (method !== 'GET' && !headers['X-CSRFToken']) return json(403, { detail: 'CSRF Failed: CSRF token missing.' })

    const parsed = new URL(url, 'http://localhost')
    const path = parsed.pathname
    const q = parsed.searchParams

    if (path === '/api/content/provider/') {
      return json(200, { name: 'mock', model_name: 'mock-templates-v1', label: 'Mock provider (sample text, no AI)', is_mock: true })
    }

    if (path === '/api/content/generate/' && method === 'POST') {
      const results = (body.x_account_ids as number[]).map((id) => {
        const account = summary(id)
        if (!x.dna.has(id)) return { x_account: account, run: null, items: [], error: NO_DNA }
        const run: GenerationRun = {
          id: nextRun++,
          x_account: account,
          requested_by: person,
          provider: 'mock',
          model_name: 'mock-templates-v1',
          is_mock: true,
          requested_count: body.count,
          requested_format: body.format,
          instructions: body.instructions,
          status: 'SUCCEEDED',
          error: '',
          input_tokens: 300,
          output_tokens: 40,
          estimated_cost_usd: '0.000000',
          duration_ms: 3,
          item_count: body.count,
          created_at: AT,
        }
        runs.unshift(run)
        const fmt = body.format || 'TEXT'
        const created = Array.from({ length: body.count }, (_, i) =>
          makeItem({
            accountId: id,
            mock: true,
            format: fmt,
            body: fmt === 'THREAD' ? '' : `Mock option ${i + 1} for @${account.handle}`,
            thread_posts: fmt === 'THREAD' ? [`Thread ${i + 1} part 1`, `Thread ${i + 1} part 2`] : [],
            poll_options: fmt === 'POLL' ? ['Yes', 'No'] : [],
            theme: 'Cricket',
          }),
        )
        return { x_account: account, run, items: created, error: null }
      })
      return json(200, { results })
    }

    if (path === '/api/content/runs/') {
      return json(200, { count: runs.length, next: null, previous: null, results: runs })
    }

    if (path === '/api/content/items/' && method === 'GET') {
      const search = (q.get('search') ?? '').toLowerCase()
      const pageSize = Number(q.get('page_size') ?? 25)
      const page = Number(q.get('page') ?? 1)
      const matches = items
        .filter((i) => !q.get('status') || i.status === q.get('status'))
        .filter((i) => !q.get('x_account') || i.x_account.id === Number(q.get('x_account')))
        .filter((i) => !q.get('source') || i.source === q.get('source'))
        .filter((i) => !q.get('post_format') || i.format === q.get('post_format'))
        .filter((i) => !q.get('flagged') || i.warnings.length > 0)
        .filter((i) => !search || [i.body, ...i.thread_posts, ...i.poll_options, i.theme, i.x_account.handle].join(' ').toLowerCase().includes(search))
        .slice()
        .reverse()
      const pages = Math.max(1, Math.ceil(matches.length / pageSize))
      if (page > pages) return json(404, { detail: 'Invalid page.' })
      return json(200, {
        count: matches.length,
        next: page < pages ? `next` : null,
        previous: page > 1 ? `previous` : null,
        results: matches.slice((page - 1) * pageSize, page * pageSize),
      })
    }

    if (path === '/api/content/items/' && method === 'POST') {
      const errors = validate(body)
      if (!body.x_account_id) errors.x_account_id = ['Choose an X account.']
      if (Object.keys(errors).length) return json(400, errors)
      const item = makeItem({ accountId: body.x_account_id, format: body.format, body: body.body, thread_posts: body.thread_posts, poll_options: body.poll_options })
      return json(201, item)
    }

    if (path === '/api/content/items/bulk-approve/' && method === 'POST') {
      const chosen = items.filter((i) => body.ids.includes(i.id))
      const flagged = chosen.filter((i) => i.warnings.length)
      if (flagged.length && !body.acknowledge_warnings) {
        return json(400, {
          acknowledge_warnings: [`${flagged.length} of these posts have warnings. Review them and confirm to approve anyway.`],
          flagged: flagged.map((i) => ({ id: i.id, warnings: i.warnings })),
        })
      }
      for (const item of chosen) {
        Object.assign(item, { status: 'APPROVED', reviewed_by: person, reviewed_at: AT, version: item.version + 1 })
        record(item, 'APPROVED', 'Bulk approved')
      }
      return json(200, { approved: chosen.map((i) => i.id) })
    }

    const match = path.match(/^\/api\/content\/items\/(\d+)\/(?:(approve|reject|restore|revisions)\/)?$/)
    if (match) {
      const item = items.find((i) => i.id === Number(match[1]))
      if (!item) return json(404, { detail: 'No ContentItem matches the given query.' })
      const action = match[2]
      if (!action && method === 'GET') return json(200, item)
      if (action === 'revisions') return json(200, revisions.get(item.id) ?? [])
      if (!action && method === 'PATCH') {
        if (body.version !== undefined && body.version !== item.version) return json(409, { detail: STALE })
        if (item.status === 'REJECTED') return json(409, { detail: 'Rejected posts can’t be edited. Restore it to a draft first.' })
        const errors = validate({ ...item, ...body })
        if (Object.keys(errors).length) return json(400, errors)
        const wasApproved = item.status === 'APPROVED'
        Object.assign(item, {
          format: body.format ?? item.format,
          body: body.body ?? item.body,
          thread_posts: body.thread_posts ?? item.thread_posts,
          poll_options: body.poll_options ?? item.poll_options,
          version: item.version + 1,
          status: 'DRAFT',
          reviewed_by: wasApproved ? null : item.reviewed_by,
          validation_flags: item.validation_flags.filter((f) => f.code !== 'MOCK_CONTENT'),
        })
        refreshWarnings(item)
        record(item, 'EDITED', wasApproved ? 'Edited after approval; needs approval again.' : '')
        return json(200, item)
      }
      if (action === 'approve') {
        if (item.status !== 'DRAFT') return json(409, { detail: 'Only drafts can be approved.' })
        if (item.warnings.length && !body.acknowledge_warnings) {
          return json(400, { acknowledge_warnings: ['This post has warnings. Review them and confirm to approve anyway.'], warnings: item.warnings })
        }
        Object.assign(item, { status: 'APPROVED', reviewed_by: person, reviewed_at: AT, version: item.version + 1 })
        record(item, 'APPROVED', item.warnings.length ? 'Approved with warnings' : '')
        return json(200, item)
      }
      if (action === 'reject') {
        if (item.status === 'REJECTED') return json(409, { detail: 'This post is already rejected.' })
        Object.assign(item, { status: 'REJECTED', rejection_reason: body.reason ?? '', reviewed_by: person, reviewed_at: AT, version: item.version + 1 })
        record(item, 'REJECTED', body.reason ?? '')
        return json(200, item)
      }
      if (action === 'restore') {
        if (item.status !== 'REJECTED') return json(409, { detail: 'Only rejected posts can be restored.' })
        Object.assign(item, { status: 'DRAFT', rejection_reason: '', reviewed_by: null, reviewed_at: null, version: item.version + 1 })
        record(item, 'RESTORED')
        return json(200, item)
      }
    }
    return json(405, { detail: 'Method not allowed.' })
  }

  return { handler, items, runs, requests, failures, x }
}

function validate(input: Record<string, unknown>): Record<string, string[]> {
  const errors: Record<string, string[]> = {}
  const fmt = input.format
  if (!fmt) return { format: ['Choose a format.'] }
  if (fmt === 'THREAD') {
    const posts = (input.thread_posts as string[]) ?? []
    if (posts.length < 2) errors.thread_posts = ['A thread needs 2 to 10 posts.']
    return errors
  }
  const body = String(input.body ?? '')
  if (!body) errors.body = [`Write the ${fmt === 'POLL' ? 'poll question' : 'post'}.`]
  else if (body.length > 280) errors.body = [`The post is ${body.length} characters; the limit is 280.`]
  return errors
}
