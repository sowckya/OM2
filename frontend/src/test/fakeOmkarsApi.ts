import type { Omkar } from '../api/omkars'
import { fakeXAccountsApi, type RecordedRequest } from './fakeXAccountsApi'
import { json } from './utils'

export const DUPLICATE_USERNAME = 'A user with this username already exists.'
export const DUPLICATE_EMAIL = 'An Omkar with this email address already exists.'
export const PHONE_NUMBER = 'Enter the number with its country code, e.g. +91 98765 43210.'
export const WEAK_PASSWORD = 'This password is too short. It must contain at least 8 characters.'

type OmkarSeed = Pick<Omkar, 'username'> & Partial<Omit<Omkar, 'x_accounts'>>
type AccountSeed = Parameters<typeof fakeXAccountsApi>[0]

/** Mirrors the backend: strips spacing, needs + and a country code. null when invalid. */
function normalizePhone(value: string): string | null {
  let compact = value.replace(/[\s().-]/g, '')
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`
  return !compact || /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null
}

/**
 * In-memory stand-ins for /api/omkars/ and /api/x-accounts/ sharing one data set, so
 * assignments made through the X account API show up on Omkars and vice versa.
 */
export function fakeManagementApi(omkarSeed: OmkarSeed[] = [], accountSeed: AccountSeed = []) {
  let nextId = 100
  const omkars: Omkar[] = omkarSeed.map((o) => ({
    id: nextId++,
    first_name: o.username.charAt(0).toUpperCase() + o.username.slice(1),
    last_name: '',
    email: `${o.username}@example.com`,
    phone_number: '',
    is_active: true,
    date_joined: '2026-10-24T10:00:00Z',
    x_accounts: [],
    ...o,
  }))
  const x = fakeXAccountsApi(accountSeed, { omkars })
  const requests: RecordedRequest[] = []
  const failures: Array<'network' | number> = []

  function serialize(omkar: Omkar): Omkar {
    return {
      ...omkar,
      x_accounts: x.accounts
        .filter((a) => a.omkarId === omkar.id)
        .sort((a, b) => a.handle.localeCompare(b.handle))
        .map(({ id, handle, display_name, status }) => ({ id, handle, display_name, status })),
    }
  }

  function validate(input: Record<string, unknown>, current?: Omkar) {
    const errors: Record<string, string[]> = {}
    const allowed = current
      ? ['first_name', 'last_name', 'email', 'phone_number', 'is_active']
      : ['username', 'first_name', 'last_name', 'email', 'phone_number', 'password']
    for (const key of Object.keys(input)) if (!allowed.includes(key)) errors[key] = ['This field cannot be set.']
    if (!current) {
      const username = String(input.username ?? '').trim()
      if (!username) errors.username = ['This field may not be blank.']
      else if (omkars.some((o) => o.username.toLowerCase() === username.toLowerCase())) errors.username = [DUPLICATE_USERNAME]
      const password = String(input.password ?? '')
      if (password.length < 8) errors.password = [WEAK_PASSWORD]
    }
    if ('first_name' in input || !current) {
      if (!String(input.first_name ?? '').trim()) errors.first_name = ['This field may not be blank.']
    }
    if ('email' in input || !current) {
      const email = String(input.email ?? '').trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = ['Enter a valid email address.']
      else if (omkars.some((o) => o.email.toLowerCase() === email.toLowerCase() && o.id !== current?.id)) {
        errors.email = [DUPLICATE_EMAIL]
      }
    }
    if ('phone_number' in input) {
      const phone = normalizePhone(String(input.phone_number))
      if (phone === null) errors.phone_number = [PHONE_NUMBER]
      else input.phone_number = phone
    }
    return errors
  }

  async function omkarHandler(url: string, init?: RequestInit): Promise<Response | undefined> {
    if (!url.startsWith('/api/omkars/')) return undefined
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method, url, body: body && { ...body }, csrf: headers['X-CSRFToken'] ?? null })

    const failure = failures.shift()
    if (failure === 'network') throw new TypeError('Failed to fetch')
    if (failure) return json(failure, { detail: 'Server error.' })
    if (method !== 'GET' && !headers['X-CSRFToken']) return json(403, { detail: 'CSRF Failed: CSRF token missing.' })

    const parsed = new URL(url, 'http://localhost')
    const idMatch = parsed.pathname.match(/^\/api\/omkars\/(\d+)\/$/)

    if (parsed.pathname === '/api/omkars/' && method === 'GET') {
      const terms = (parsed.searchParams.get('search') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const isActive = parsed.searchParams.get('is_active')
      const pageSize = Number(parsed.searchParams.get('page_size') ?? 50)
      const page = Number(parsed.searchParams.get('page') ?? 1)
      const matches = omkars
        .filter((o) =>
          terms.every((t) => [o.username, o.first_name, o.last_name, o.email].some((f) => f.toLowerCase().includes(t))),
        )
        .filter((o) => isActive === null || String(o.is_active) === isActive)
        .sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase()))
      const pages = Math.max(1, Math.ceil(matches.length / pageSize))
      if (page > pages) return json(404, { detail: 'Invalid page.' })
      return json(200, {
        count: matches.length,
        next: page < pages ? `http://localhost/api/omkars/?page=${page + 1}` : null,
        previous: page > 1 ? `http://localhost/api/omkars/?page=${page - 1}` : null,
        results: matches.slice((page - 1) * pageSize, page * pageSize).map(serialize),
      })
    }

    if (parsed.pathname === '/api/omkars/' && method === 'POST') {
      const errors = validate(body ?? {})
      if (Object.keys(errors).length) return json(400, errors)
      const omkar: Omkar = {
        id: nextId++,
        username: body.username.trim(),
        first_name: body.first_name.trim(),
        last_name: (body.last_name ?? '').trim(),
        email: body.email.trim(),
        phone_number: body.phone_number ?? '',
        is_active: true,
        date_joined: new Date().toISOString(),
        x_accounts: [],
      }
      omkars.push(omkar)
      return json(201, serialize(omkar))
    }

    if (idMatch) {
      const omkar = omkars.find((o) => o.id === Number(idMatch[1]))
      if (!omkar) return json(404, { detail: 'No User matches the given query.' })
      if (method === 'GET') return json(200, serialize(omkar))
      if (method === 'PATCH') {
        const errors = validate(body ?? {}, omkar)
        if (Object.keys(errors).length) return json(400, errors)
        Object.assign(omkar, body)
        return json(200, serialize(omkar))
      }
    }
    return json(405, { detail: 'Method not allowed.' })
  }

  async function handler(url: string, init?: RequestInit) {
    return (await omkarHandler(url, init)) ?? (await x.handler(url, init))
  }

  return { handler, omkars, accounts: x.accounts, requests, failures, x }
}
