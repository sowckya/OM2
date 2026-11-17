import type { ContentDNA, ContentDNAInput } from '../api/contentDna'
import type { Omkar } from '../api/omkars'
import type { XAccount } from '../api/xAccounts'
import { json } from './utils'

export const CREATED_AT = '2026-10-24T10:00:00Z' // 24 Oct 2026, 15:30 IST
export const DUPLICATE = 'An X account with this handle already exists.'
export const BAD_HANDLE = 'Enter a valid X handle: 1–15 letters, numbers or underscores, without @.'
export const LIMIT_REACHED = 'This Omkar already has 2 X accounts.'
export const INACTIVE_OMKAR = 'This Omkar is inactive and cannot be assigned X accounts.'
export const DNA_MISSING = 'Content DNA is not configured for this X account.'
export const DNA_EXISTS = 'This X account already has Content DNA. Update it instead.'

export const VALID_DNA: ContentDNAInput = {
  primary_themes: ['Cricket'],
  secondary_themes: [],
  languages: ['ENGLISH'],
  tone: ['Witty'],
  target_audience: 'Cricket fans',
  writing_style: 'Short and punchy',
  allowed_formats: ['TEXT'],
  topics_to_avoid: [],
  example_posts: [],
  daily_post_target: 3,
  additional_instructions: '',
}

export interface RecordedRequest {
  method: string
  url: string
  body: unknown
  csrf: string | null
}

type FakeOmkar = Omkar

type Seed = Pick<XAccount, 'handle'> &
  Partial<Omit<XAccount, 'assigned_omkar' | 'content_dna_configured'>> & { omkarId?: number; dna?: Partial<ContentDNAInput> }

/**
 * In-memory stand-in for /api/x-accounts/ that mirrors the Django API: normalization,
 * validation errors, duplicate handles, CSRF header, search, filters, pagination and
 * Omkar assignment rules. Pass `omkars` to share Omkar records with fakeOmkarsApi.
 */
export function fakeXAccountsApi(seed: Seed[] = [], options: { omkars?: FakeOmkar[] } = {}) {
  const omkars = options.omkars ?? []
  let nextId = 1
  const dna = new Map<number, ContentDNA>()
  const accounts: (Omit<XAccount, 'assigned_omkar' | 'content_dna_configured'> & { omkarId: number | null })[] = seed.map(
    ({ omkarId, dna: profile, ...a }) => {
      const id = nextId++
      if (profile) dna.set(id, { ...VALID_DNA, ...profile, x_account: id, created_at: CREATED_AT, updated_at: CREATED_AT })
      return {
      id,
      display_name: a.handle,
      status: 'ACTIVE' as const,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      omkarId: omkarId ?? null,
      ...a,
      }
    },
  )
  const requests: RecordedRequest[] = []
  /** Push to make the next X-account request fail. */
  const failures: Array<'network' | number> = []

  function serialize(account: (typeof accounts)[number]): XAccount {
    const { omkarId, ...rest } = account
    const owner = omkars.find((o) => o.id === omkarId)
    return {
      ...rest,
      content_dna_configured: dna.has(account.id),
      assigned_omkar: owner
        ? {
            id: owner.id,
            username: owner.username,
            display_name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.username,
            is_active: owner.is_active,
          }
        : null,
    }
  }

  function validate(input: Record<string, unknown>, current?: (typeof accounts)[number]) {
    const errors: Record<string, string[]> = {}
    const out: Partial<(typeof accounts)[number]> = {}
    if ('handle' in input || !current) {
      const handle = String(input.handle ?? '').trim().replace(/^@/, '').toLowerCase()
      if (!/^[a-z0-9_]{1,15}$/.test(handle)) errors.handle = [BAD_HANDLE]
      else if (accounts.some((a) => a.handle === handle && a.id !== current?.id)) errors.handle = [DUPLICATE]
      else out.handle = handle
    }
    if ('display_name' in input || !current) {
      const name = String(input.display_name ?? '').trim()
      if (!name) errors.display_name = ['This field may not be blank.']
      else out.display_name = name
    }
    if ('status' in input) {
      if (input.status !== 'ACTIVE' && input.status !== 'PAUSED') {
        errors.status = [`"${String(input.status)}" is not a valid choice.`]
      } else out.status = input.status
    }
    if ('assigned_omkar_id' in input) {
      const omkarId = input.assigned_omkar_id as number | null
      if (omkarId === null) out.omkarId = null
      else if (omkarId !== current?.omkarId) {
        const omkar = omkars.find((o) => o.id === omkarId)
        const owned = accounts.filter((a) => a.omkarId === omkarId && a.id !== current?.id).length
        if (!omkar) errors.assigned_omkar_id = ['Omkar not found.']
        else if (!omkar.is_active) errors.assigned_omkar_id = [INACTIVE_OMKAR]
        else if (owned >= 2) errors.assigned_omkar_id = [LIMIT_REACHED]
        else out.omkarId = omkarId
      }
    }
    return { errors, out }
  }

  async function handler(url: string, init?: RequestInit): Promise<Response | undefined> {
    if (!url.startsWith('/api/x-accounts/')) return undefined
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body, csrf: headers['X-CSRFToken'] ?? null })

    const failure = failures.shift()
    if (failure === 'network') throw new TypeError('Failed to fetch')
    if (failure) return json(failure, { detail: 'Server error.' })

    if (method !== 'GET' && !headers['X-CSRFToken']) {
      return json(403, { detail: 'CSRF Failed: CSRF token missing.' })
    }

    const parsed = new URL(url, 'http://localhost')
    const idMatch = parsed.pathname.match(/^\/api\/x-accounts\/(\d+)\/$/)
    const dnaMatch = parsed.pathname.match(/^\/api\/x-accounts\/(\d+)\/content-dna\/$/)

    if (dnaMatch) {
      const account = accounts.find((a) => a.id === Number(dnaMatch[1]))
      if (!account) return json(404, { detail: 'No XAccount matches the given query.' })
      const current = dna.get(account.id)
      if (method === 'POST' && current) return json(409, { detail: DNA_EXISTS, configured: true })
      if (method !== 'POST' && !current) return json(404, { detail: DNA_MISSING, configured: false })
      if (method === 'GET') return json(200, current)
      if (method === 'POST' || method === 'PATCH') {
        const merged = { ...(current ?? { secondary_themes: [], topics_to_avoid: [], example_posts: [], additional_instructions: '' }), ...body }
        const errors = validateDna(merged)
        if (Object.keys(errors).length) return json(400, errors)
        const now = new Date().toISOString()
        const saved = { ...merged, x_account: account.id, created_at: current?.created_at ?? now, updated_at: now } as ContentDNA
        dna.set(account.id, saved)
        return json(method === 'POST' ? 201 : 200, saved)
      }
    }

    if (parsed.pathname === '/api/x-accounts/' && method === 'GET') {
      const search = (parsed.searchParams.get('search') ?? '').toLowerCase()
      const handleTerm = search.replace(/^@/, '')
      const status = parsed.searchParams.get('status')
      const assigned = parsed.searchParams.get('assigned')
      const pageSize = Number(parsed.searchParams.get('page_size') ?? 50)
      const page = Number(parsed.searchParams.get('page') ?? 1)
      const matches = accounts
        .filter((a) => !search || a.handle.includes(handleTerm) || a.display_name.toLowerCase().includes(search))
        .filter((a) => !status || a.status === status)
        .filter((a) => assigned === null || (assigned === 'true') === (a.omkarId !== null))
        .sort((a, b) => a.handle.localeCompare(b.handle))
      const pages = Math.max(1, Math.ceil(matches.length / pageSize))
      if (page > pages) return json(404, { detail: 'Invalid page.' })
      const link = (p: number) => {
        const next = new URL(parsed)
        next.searchParams.set('page', String(p))
        return next.toString()
      }
      return json(200, {
        count: matches.length,
        next: page < pages ? link(page + 1) : null,
        previous: page > 1 ? link(page - 1) : null,
        results: matches.slice((page - 1) * pageSize, page * pageSize).map(serialize),
      })
    }

    if (parsed.pathname === '/api/x-accounts/' && method === 'POST') {
      const { errors, out } = validate(body ?? {})
      if (Object.keys(errors).length) return json(400, errors)
      const now = new Date().toISOString()
      const account = { id: nextId++, status: 'ACTIVE' as const, omkarId: null, ...out, created_at: now, updated_at: now }
      accounts.push(account as (typeof accounts)[number])
      return json(201, serialize(account as (typeof accounts)[number]))
    }

    if (idMatch) {
      const account = accounts.find((a) => a.id === Number(idMatch[1]))
      if (!account) return json(404, { detail: 'No XAccount matches the given query.' })
      if (method === 'GET') return json(200, serialize(account))
      if (method === 'PATCH') {
        const { errors, out } = validate(body ?? {}, account)
        if (Object.keys(errors).length) return json(400, errors)
        Object.assign(account, out, { updated_at: new Date().toISOString() })
        return json(200, serialize(account))
      }
    }
    return json(405, { detail: 'Method not allowed.' })
  }

  return { handler, accounts, dna, requests, failures }
}

/** A subset of the Django Content DNA rules, with the same messages. */
function validateDna(input: Record<string, unknown>) {
  const errors: Record<string, string[]> = {}
  const lists: [string, string, number, number, string[] | null][] = [
    ['primary_themes', 'primary theme', 1, 5, null],
    ['secondary_themes', 'secondary themes', 0, 10, null],
    ['languages', 'language', 1, 3, ['ENGLISH', 'TELUGU', 'TINGLISH']],
    ['tone', 'tone', 1, 6, null],
    ['allowed_formats', 'format', 1, 3, ['TEXT', 'THREAD', 'POLL']],
    ['topics_to_avoid', 'topics to avoid', 0, 20, null],
    ['example_posts', 'example posts', 0, 10, null],
  ]
  for (const [field, label, min, max, choices] of lists) {
    const values = input[field]
    if (!Array.isArray(values)) {
      errors[field] = ['This field is required.']
      continue
    }
    if (values.length < min) errors[field] = [`Add at least one ${label}.`]
    else if (values.length > max) errors[field] = [`Use at most ${max} ${label}.`]
    else if (values.some((v) => !String(v).trim())) errors[field] = [`Entry ${values.findIndex((v) => !String(v).trim()) + 1} is blank.`]
    else if (choices && values.some((v) => !choices.includes(v))) errors[field] = [`“${values.find((v) => !choices.includes(v))}” is not a valid option.`]
  }
  for (const field of ['target_audience', 'writing_style']) {
    if (!String(input[field] ?? '').trim()) errors[field] = ['This field cannot be blank.']
  }
  const target = input.daily_post_target
  if (typeof target !== 'number' || !Number.isInteger(target)) errors.daily_post_target = ['Enter a whole number.']
  else if (target < 1) errors.daily_post_target = ['Set a target of at least 1 post per day.']
  else if (target > 20) errors.daily_post_target = ['Set a target of at most 20 posts per day.']
  return errors
}
