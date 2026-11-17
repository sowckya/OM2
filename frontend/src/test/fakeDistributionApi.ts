import type { Batch, CandidateGroup, Candidates, DistributionMessage, MessageStatus } from '../api/distribution'
import type { RecordedRequest } from './fakeXAccountsApi'
import { json } from './utils'

const AT = '2026-11-03T09:00:00Z'
const person = { id: 1, display_name: 'Mona M' }

/**
 * In-memory stand-in for /api/distribution/, mirroring the server rules the page relies on:
 * up to 5 posts per message, posts locked into one open message, status transitions.
 */
export function fakeDistributionApi(groups: CandidateGroup[], unassignedCount = 0) {
  const requests: RecordedRequest[] = []
  const failures: Array<{ status: number; body: unknown }> = []
  const batches: Batch[] = []
  let nextMessage = 1

  function candidates(): Candidates {
    const active = new Map<number, number>()
    const sent = new Map<number, string>()
    for (const b of batches)
      for (const m of b.messages)
        for (const p of m.posts) {
          if (m.status === 'PENDING' || m.status === 'OPENED') active.set(p.id, b.id)
          if (m.status === 'SENT') sent.set(p.id, m.sent_confirmed_at!)
        }
    return {
      unassigned_count: unassignedCount,
      omkars: groups.map((g) => ({
        ...g,
        posts: g.posts.map((p) => ({
          ...p,
          active_batch_id: active.get(p.id) ?? p.active_batch_id,
          sent_at: sent.get(p.id) ?? p.sent_at,
          unavailable_reason: g.unavailable_reason ?? (active.has(p.id) ? `Already in batch ${active.get(p.id)}.` : p.unavailable_reason),
        })),
      })),
    }
  }

  function setStatus(message: DistributionMessage, status: MessageStatus) {
    message.status = status
    if (status === 'OPENED') Object.assign(message, { open_count: message.open_count + 1, opened_at: AT, opened_by: person })
    if (status === 'SENT') Object.assign(message, { sent_confirmed_at: AT, sent_confirmed_by: person, url: null })
    if (status === 'CANCELLED') Object.assign(message, { cancelled_at: AT, url: null })
  }

  async function handler(url: string, init?: RequestInit): Promise<Response | undefined> {
    if (!url.startsWith('/api/distribution/')) return undefined
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body, csrf: headers['X-CSRFToken'] ?? null })
    const failure = failures.shift()
    if (failure) return json(failure.status, failure.body)
    if (method !== 'GET' && !headers['X-CSRFToken']) return json(403, { detail: 'CSRF Failed: CSRF token missing.' })

    if (url === '/api/distribution/candidates/') return json(200, candidates())
    if (url === '/api/distribution/batches/' && method === 'GET') {
      const results = [...batches].reverse().map((b) => ({
        id: b.id,
        created_at: b.created_at,
        created_by: person,
        counts: Object.fromEntries((['PENDING', 'OPENED', 'SENT', 'CANCELLED'] as MessageStatus[]).map((s) => [s, b.messages.filter((m) => m.status === s).length])),
      }))
      return json(200, { count: results.length, next: null, previous: null, results })
    }
    if (url === '/api/distribution/batches/' && method === 'POST') {
      const ids: number[] = body.item_ids
      const current = candidates()
      const batch: Batch = { id: batches.length + 1, created_at: AT, created_by: person, messages: [] }
      for (const g of current.omkars) {
        const posts = g.posts.filter((p) => ids.includes(p.id))
        for (let i = 0; i < posts.length; i += 5) {
          const chunk = posts.slice(i, i + 5)
          const text = `Hi ${g.omkar.display_name},\n\n${chunk.map((p) => `@${p.x_account.handle}\n${p.body}`).join('\n\n')}`
          batch.messages.push({
            id: nextMessage++,
            batch_id: batch.id,
            omkar: { id: g.omkar.id, display_name: g.omkar.display_name },
            phone_number: g.omkar.phone_number,
            position: i / 5 + 1,
            of: Math.ceil(posts.length / 5),
            status: 'PENDING',
            text,
            url: `https://wa.me/${g.omkar.phone_number.slice(1)}?text=${encodeURIComponent(text)}`,
            url_length: 100,
            warnings: [],
            posts: chunk.map((p) => ({ id: p.id, handle: p.x_account.handle, format: p.format, short_link: true })),
            open_count: 0,
            opened_at: null,
            opened_by: null,
            sent_confirmed_at: null,
            sent_confirmed_by: null,
            cancelled_at: null,
          })
        }
      }
      batches.push(batch)
      return json(201, batch)
    }
    const batchMatch = url.match(/^\/api\/distribution\/batches\/(\d+)\/$/)
    if (batchMatch) {
      const batch = batches.find((b) => b.id === Number(batchMatch[1]))
      return batch ? json(200, batch) : json(404, { detail: 'Not found.' })
    }
    const actionMatch = url.match(/^\/api\/distribution\/messages\/(\d+)\/(open|confirm-sent|cancel)\/$/)
    if (actionMatch && method === 'POST') {
      const message = batches.flatMap((b) => b.messages).find((m) => m.id === Number(actionMatch[1]))
      if (!message) return json(404, { detail: 'Not found.' })
      if (message.status === 'SENT') return json(409, { detail: 'This message was already confirmed as sent.' })
      const action = actionMatch[2]
      setStatus(message, action === 'open' ? 'OPENED' : action === 'confirm-sent' ? 'SENT' : 'CANCELLED')
      return json(200, message)
    }
    return json(405, { detail: 'Method not allowed.' })
  }

  return { handler, requests, failures, batches }
}

export function group(id: number, name: string, posts: Array<Partial<CandidateGroup['posts'][number]> & { id: number; handle: string }>, extra: Partial<CandidateGroup> = {}): CandidateGroup {
  return {
    omkar: { id, display_name: name, phone_number: `+9198765${String(id).padStart(5, '0')}` },
    unavailable_reason: null,
    accounts: [...new Set(posts.map((p) => p.handle))].sort().map((handle, i) => ({ id: id * 10 + i, handle, status: 'ACTIVE' })),
    posts: posts.map(({ handle, ...p }) => ({
      x_account: { id: 1, handle },
      format: 'TEXT',
      body: `Post ${p.id} by @${handle}`,
      thread_posts: [],
      poll_options: [],
      reviewed_at: AT,
      active_batch_id: null,
      sent_at: null,
      unavailable_reason: null,
      ...p,
    })),
    ...extra,
  }
}
