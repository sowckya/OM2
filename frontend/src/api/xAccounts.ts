// Client for the Millionaire-only X account API (/api/x-accounts/).

import {
  csrfToken,
  describeApiError,
  fieldErrorsFrom as clientFieldErrorsFrom,
  request,
  sendJson,
  type FieldErrors as ClientFieldErrors,
} from './client'

export type XAccountStatus = 'ACTIVE' | 'PAUSED'

export interface AssignedOmkar {
  id: number
  username: string
  display_name: string
  is_active: boolean
}

export interface XAccount {
  id: number
  handle: string
  display_name: string
  status: XAccountStatus
  assigned_omkar: AssignedOmkar | null
  /** Whether a Content DNA profile exists for this account. */
  content_dna_configured: boolean
  created_at: string
  updated_at: string
}

export interface XAccountInput {
  handle: string
  display_name: string
  status: XAccountStatus
}

export interface Page<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

export interface XAccountQuery {
  search?: string
  status?: XAccountStatus
  /** true: only accounts with an Omkar; false: only unassigned accounts. */
  assigned?: boolean
  page?: number
  pageSize?: number
}

/** Page size requested explicitly so the UI can compute page numbers. */
export const X_ACCOUNTS_PAGE_SIZE = 50
export const X_ACCOUNT_TARGET = 100

const BASE = '/api/x-accounts/'

export async function listXAccounts(query: XAccountQuery = {}): Promise<Page<XAccount>> {
  const params = new URLSearchParams()
  if (query.search) params.set('search', query.search)
  if (query.status) params.set('status', query.status)
  if (query.assigned !== undefined) params.set('assigned', String(query.assigned))
  if (query.page && query.page > 1) params.set('page', String(query.page))
  params.set('page_size', String(query.pageSize ?? X_ACCOUNTS_PAGE_SIZE))
  const response = await request(`${BASE}?${params}`)
  return response.json()
}

/** Every account, fetched page by page at the server's maximum page size. */
export async function listAllXAccounts(): Promise<XAccount[]> {
  const all: XAccount[] = []
  for (let page = 1; ; page++) {
    const result = await listXAccounts({ page, pageSize: 100 })
    all.push(...result.results)
    if (!result.next || !result.results.length) return all
  }
}

export async function getXAccount(id: number): Promise<XAccount> {
  const response = await request(`${BASE}${id}/`)
  return response.json()
}

export async function createXAccount(input: XAccountInput): Promise<XAccount> {
  const response = await sendJson('POST', BASE, await csrfToken(), input)
  return response.json()
}

/** Assigns an X account to an Omkar, or unassigns it with null. */
export async function assignXAccount(id: number, omkarId: number | null): Promise<XAccount> {
  const response = await sendJson('PATCH', `${BASE}${id}/`, await csrfToken(), { assigned_omkar_id: omkarId })
  return response.json()
}

export async function updateXAccount(id: number, changes: Partial<XAccountInput>): Promise<XAccount> {
  const response = await sendJson('PATCH', `${BASE}${id}/`, await csrfToken(), changes)
  return response.json()
}

export type FieldErrors = ClientFieldErrors<keyof XAccountInput | 'assigned_omkar_id'>

const X_ACCOUNT_FIELDS = ['handle', 'display_name', 'status', 'assigned_omkar_id'] as const

/** One message per form field from a DRF 400 response. */
export function fieldErrorsFrom(err: unknown): FieldErrors | null {
  return clientFieldErrorsFrom(err, X_ACCOUNT_FIELDS)
}

export function describeXAccountError(err: unknown): string {
  return describeApiError(err, 'You do not have permission to manage X accounts.')
}
