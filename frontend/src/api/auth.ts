// Client for the Django session-auth endpoints. The session lives in an HttpOnly
// cookie managed by the browser; nothing is persisted by this code.

import { ApiError, NetworkError, csrfToken, fetchCsrfToken, request, sendJson } from './client'

export { ApiError, NetworkError }

export type Role = 'MILLIONAIRE' | 'OMKAR'

export interface User {
  id: number
  username: string
  display_name: string
  role: Role
}

/** Returns the signed-in user, or null when there is no valid session. */
export async function getCurrentUser(): Promise<User | null> {
  try {
    const response = await request('/api/auth/me/')
    return await response.json()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null
    throw err
  }
}

/** Signs in; the backend rejects the login unless the account's role is `expectedRole`. */
export async function login(username: string, password: string, expectedRole: Role): Promise<User> {
  // Always fetch a fresh token: it sets the csrftoken cookie if it is missing.
  const token = await fetchCsrfToken()
  const response = await sendJson('POST', '/api/auth/login/', token, {
    username,
    password,
    expected_role: expectedRole,
  })
  return response.json()
}

export async function logout(): Promise<void> {
  // Django rotates the CSRF token on login, so read the current cookie value.
  await sendJson('POST', '/api/auth/logout/', await csrfToken())
}

/** Maps an API or network failure to a message suitable for display. */
export function describeError(err: unknown): string {
  if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
    return "Can't reach the OM2 server. Check your connection and try again."
  }
  if (err instanceof ApiError) {
    if (err.status === 400) return 'Invalid username or password for this login type.'
    if (err.status === 403) return 'Security check failed. Refresh the page and try again.'
    if (err.status === 429) return 'Too many sign-in attempts. Please wait a minute and try again.'
  }
  return 'Something went wrong. Please try again.'
}
