// Client for the Millionaire-only Omkar management API (/api/omkars/).

import {
  csrfToken,
  describeApiError,
  fieldErrorsFrom as clientFieldErrorsFrom,
  request,
  sendJson,
  type FieldErrors as ClientFieldErrors,
} from './client'
import type { Page, XAccountStatus } from './xAccounts'

export interface OmkarXAccount {
  id: number
  handle: string
  display_name: string
  status: XAccountStatus
}

export interface Omkar {
  id: number
  username: string
  first_name: string
  last_name: string
  email: string
  /** WhatsApp number in international format, e.g. +919876543210; '' when not saved. */
  phone_number: string
  is_active: boolean
  date_joined: string
  x_accounts: OmkarXAccount[]
}

export interface OmkarCreateInput {
  username: string
  first_name: string
  last_name: string
  email: string
  phone_number: string
  password: string
}

export interface OmkarUpdateInput {
  first_name: string
  last_name: string
  email: string
  phone_number: string
  is_active: boolean
}

export interface OmkarQuery {
  search?: string
  isActive?: boolean
  page?: number
  pageSize?: number
}

export const OMKARS_PAGE_SIZE = 50
export const OMKAR_TARGET = 50
export const MAX_X_ACCOUNTS_PER_OMKAR = 2

const BASE = '/api/omkars/'

export async function listOmkars(query: OmkarQuery = {}): Promise<Page<Omkar>> {
  const params = new URLSearchParams()
  if (query.search) params.set('search', query.search)
  if (query.isActive !== undefined) params.set('is_active', String(query.isActive))
  if (query.page && query.page > 1) params.set('page', String(query.page))
  params.set('page_size', String(query.pageSize ?? OMKARS_PAGE_SIZE))
  const response = await request(`${BASE}?${params}`)
  return response.json()
}

export async function createOmkar(input: OmkarCreateInput): Promise<Omkar> {
  const response = await sendJson('POST', BASE, await csrfToken(), input)
  return response.json()
}

export async function updateOmkar(id: number, changes: Partial<OmkarUpdateInput>): Promise<Omkar> {
  const response = await sendJson('PATCH', `${BASE}${id}/`, await csrfToken(), changes)
  return response.json()
}

export function omkarName(omkar: Pick<Omkar, 'first_name' | 'last_name' | 'username'>): string {
  return [omkar.first_name, omkar.last_name].filter(Boolean).join(' ') || omkar.username
}

const OMKAR_FIELDS = ['username', 'first_name', 'last_name', 'email', 'phone_number', 'password', 'is_active'] as const

export type OmkarFieldErrors = ClientFieldErrors<(typeof OMKAR_FIELDS)[number]>

export function omkarFieldErrorsFrom(err: unknown): OmkarFieldErrors | null {
  return clientFieldErrorsFrom(err, OMKAR_FIELDS)
}

export function describeOmkarError(err: unknown): string {
  return describeApiError(err, 'You do not have permission to manage Omkars.')
}
