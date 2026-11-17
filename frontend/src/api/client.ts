// Shared fetch helpers for the Django API. The session lives in an HttpOnly cookie
// managed by the browser; unsafe requests send Django's CSRF token as a header.

export class ApiError extends Error {
  status: number
  /** Parsed JSON error body (e.g. DRF field errors), when the server sent one. */
  data: unknown

  constructor(status: number, message: string, data: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Network request failed')
    this.name = 'NetworkError'
  }
}

export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...init.headers },
    })
  } catch {
    throw new NetworkError()
  }
  if (!response.ok) {
    let detail = response.statusText
    let data: unknown = null
    try {
      data = await response.json()
      const body = data as { detail?: unknown } | null
      if (typeof body?.detail === 'string') detail = body.detail
    } catch {
      // Non-JSON error body (e.g. dev proxy failure); keep statusText.
    }
    throw new ApiError(response.status, detail, data)
  }
  return response
}

function readCookie(name: string): string | null {
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

export async function fetchCsrfToken(): Promise<string> {
  const response = await request('/api/auth/csrf/')
  const body: { csrfToken: string } = await response.json()
  return body.csrfToken
}

/** Current CSRF token: the cookie value (Django rotates it on login), else a fresh one. */
export async function csrfToken(): Promise<string> {
  return readCookie('csrftoken') ?? (await fetchCsrfToken())
}

export async function sendJson(
  method: 'POST' | 'PATCH',
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export type FieldErrors<F extends string> = Partial<Record<F | 'form', string>>

/** Turns a DRF 400 body ({field: [messages]}) into one message per form field. */
export function fieldErrorsFrom<F extends string>(err: unknown, fields: readonly F[]): FieldErrors<F> | null {
  if (!(err instanceof ApiError) || err.status !== 400 || !err.data || typeof err.data !== 'object') {
    return null
  }
  const data = err.data as Record<string, unknown>
  const first = (value: unknown) =>
    Array.isArray(value) && typeof value[0] === 'string' ? value[0] : typeof value === 'string' ? value : undefined
  const errors: FieldErrors<F> = {}
  for (const field of fields) {
    const message = first(data[field])
    if (message) errors[field] = message
  }
  const form = first(data.non_field_errors) ?? first(data.detail)
  if (form) errors.form = form
  if (!Object.keys(errors).length) {
    // An error on a field this form doesn't show: surface its message at form level.
    const other = Object.values(data).map(first).find(Boolean)
    errors.form = other ?? 'Please check the form and try again.'
  }
  return errors
}

/** Maps a non-validation failure to a message suitable for display. */
export function describeApiError(err: unknown, forbiddenMessage: string): string {
  if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
    return "Can't reach the OM2 server. Check your connection and try again."
  }
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session has expired. Please sign in again.'
    if (err.status === 403) {
      return err.message.includes('CSRF') ? 'Security check failed. Refresh the page and try again.' : forbiddenMessage
    }
    if (err.status === 404) return 'That record or page could not be found.'
  }
  return 'Something went wrong. Please try again.'
}
