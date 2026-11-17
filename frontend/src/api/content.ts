// Client for the Millionaire-only content API (/api/content/).

import type { ContentDNA, ContentFormat, Language } from './contentDna'
import {
  ApiError,
  csrfToken,
  describeApiError,
  fieldErrorsFrom as clientFieldErrorsFrom,
  request,
  sendJson,
  type FieldErrors as ClientFieldErrors,
} from './client'
import type { Page } from './xAccounts'

export type ContentStatus = 'DRAFT' | 'APPROVED' | 'REJECTED'
export type ContentSource = 'AI' | 'MANUAL'

export interface Person {
  id: number
  username: string
  display_name: string
}

export interface AccountSummary {
  id: number
  handle: string
  display_name: string
}

export interface Warning {
  code: string
  message: string
}

export interface DuplicateFlag {
  kind: 'EXACT' | 'SIMILAR'
  scope: 'ACCOUNT' | 'NETWORK'
  similarity: number
  item_id: number | null
  label: string
  excerpt: string
}

/**
 * A wa.me link that opens WhatsApp with the assigned Omkar's number and the post
 * prefilled. A Millionaire sends it manually; opening it changes nothing in OM2.
 */
export interface WhatsAppShare {
  /** null when the post can't be sent yet; see unavailable_reason. */
  url: string | null
  recipient: { id: number; display_name: string } | null
  unavailable_reason: string | null
  /** True when the message uses a cached TinyURL link instead of the full X compose link. */
  x_link_shortened: boolean
}

export interface ContentItem {
  id: number
  x_account: AccountSummary
  source: ContentSource
  status: ContentStatus
  format: ContentFormat
  body: string
  thread_posts: string[]
  poll_options: string[]
  theme: string
  language: Language | ''
  duplicate_flags: DuplicateFlag[]
  validation_flags: Warning[]
  /** Everything a reviewer must acknowledge before approving. */
  warnings: Warning[]
  rejection_reason: string
  generation: { id: number; provider: string; model_name: string; is_mock: boolean } | null
  created_by: Person | null
  reviewed_by: Person | null
  reviewed_at: string | null
  version: number
  created_at: string
  updated_at: string
  /** Send to WhatsApp details; null unless the post is approved. */
  whatsapp: WhatsAppShare | null
  /** Only in detail responses. */
  dna_snapshot?: Omit<ContentDNA, 'x_account' | 'created_at'> | null
}

export interface GenerationRun {
  id: number
  x_account: AccountSummary
  requested_by: Person | null
  provider: string
  model_name: string
  is_mock: boolean
  requested_count: number
  requested_format: ContentFormat | ''
  instructions: string
  status: 'SUCCEEDED' | 'FAILED'
  error: string
  input_tokens: number
  output_tokens: number
  estimated_cost_usd: string
  duration_ms: number
  item_count: number
  created_at: string
}

export interface Revision {
  id: number
  version: number
  action: 'CREATED' | 'EDITED' | 'APPROVED' | 'REJECTED' | 'RESTORED'
  status: ContentStatus
  format: ContentFormat
  body: string
  thread_posts: string[]
  poll_options: string[]
  note: string
  changed_by: Person | null
  created_at: string
}

export interface ProviderInfo {
  name: string
  model_name: string
  label: string
  is_mock: boolean
}

export interface GenerateInput {
  x_account_ids: number[]
  count: number
  format: ContentFormat | ''
  instructions: string
}

export interface GenerateResult {
  x_account: AccountSummary
  run: GenerationRun | null
  items: ContentItem[]
  error: string | null
}

export interface ContentInput {
  format: ContentFormat
  body: string
  thread_posts: string[]
  poll_options: string[]
}

export interface ContentQuery {
  search?: string
  xAccount?: number
  status?: ContentStatus
  source?: ContentSource
  format?: ContentFormat
  flagged?: boolean
  createdAfter?: string
  createdBefore?: string
  page?: number
  pageSize?: number
}

export const CONTENT_PAGE_SIZE = 25
export const MAX_OPTIONS = 5
export const MAX_ACCOUNTS_PER_REQUEST = 20
/** Mirrors content/models.py. */
export const POST_MAX_LENGTH = 280
export const THREAD_LIMITS = { min: 2, max: 10 }
export const POLL_LIMITS = { min: 2, max: 4, optionLength: 25 }

export const STATUS_LABELS: Record<ContentStatus, string> = { DRAFT: 'Draft', APPROVED: 'Approved', REJECTED: 'Rejected' }
export const SOURCE_LABELS: Record<ContentSource, string> = { AI: 'AI generated', MANUAL: 'Manual' }
export const FORMAT_LABELS: Record<ContentFormat, string> = { TEXT: 'Text', THREAD: 'Thread', POLL: 'Poll' }

const BASE = '/api/content/'

export async function getProvider(): Promise<ProviderInfo> {
  return (await request(`${BASE}provider/`)).json()
}

export async function generateContent(input: GenerateInput): Promise<GenerateResult[]> {
  const response = await sendJson('POST', `${BASE}generate/`, await csrfToken(), input)
  return (await response.json()).results
}

export async function listRuns(query: { xAccount?: number; pageSize?: number } = {}): Promise<Page<GenerationRun>> {
  const params = new URLSearchParams({ page_size: String(query.pageSize ?? 10) })
  if (query.xAccount) params.set('x_account', String(query.xAccount))
  return (await request(`${BASE}runs/?${params}`)).json()
}

export async function listContent(query: ContentQuery = {}): Promise<Page<ContentItem>> {
  const params = new URLSearchParams()
  if (query.search) params.set('search', query.search)
  if (query.xAccount) params.set('x_account', String(query.xAccount))
  if (query.status) params.set('status', query.status)
  if (query.source) params.set('source', query.source)
  if (query.format) params.set('post_format', query.format)
  if (query.flagged) params.set('flagged', 'true')
  if (query.createdAfter) params.set('created_after', query.createdAfter)
  if (query.createdBefore) params.set('created_before', query.createdBefore)
  if (query.page && query.page > 1) params.set('page', String(query.page))
  params.set('page_size', String(query.pageSize ?? CONTENT_PAGE_SIZE))
  return (await request(`${BASE}items/?${params}`)).json()
}

export async function getContent(id: number): Promise<ContentItem> {
  return (await request(`${BASE}items/${id}/`)).json()
}

export async function getRevisions(id: number): Promise<Revision[]> {
  return (await request(`${BASE}items/${id}/revisions/`)).json()
}

export async function createContent(xAccountId: number, input: ContentInput): Promise<ContentItem> {
  const response = await sendJson('POST', `${BASE}items/`, await csrfToken(), { x_account_id: xAccountId, ...input })
  return response.json()
}

export async function updateContent(id: number, input: ContentInput, version: number): Promise<ContentItem> {
  const response = await sendJson('PATCH', `${BASE}items/${id}/`, await csrfToken(), { ...input, version })
  return response.json()
}

async function review(id: number, action: 'approve' | 'reject' | 'restore', body: object = {}): Promise<ContentItem> {
  const response = await sendJson('POST', `${BASE}items/${id}/${action}/`, await csrfToken(), body)
  return response.json()
}

export const approveContent = (id: number, acknowledgeWarnings = false) =>
  review(id, 'approve', { acknowledge_warnings: acknowledgeWarnings })
export const rejectContent = (id: number, reason: string) => review(id, 'reject', { reason })
export const restoreContent = (id: number) => review(id, 'restore')

export async function bulkApprove(ids: number[], acknowledgeWarnings = false): Promise<number[]> {
  const response = await sendJson('POST', `${BASE}items/bulk-approve/`, await csrfToken(), {
    ids,
    acknowledge_warnings: acknowledgeWarnings,
  })
  return (await response.json()).approved
}

/** True when the server refused an approval only because warnings weren't acknowledged. */
export function needsAcknowledgement(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400 && !!(err.data as { acknowledge_warnings?: unknown })?.acknowledge_warnings
}

export type ContentFieldErrors = ClientFieldErrors<'x_account_id' | 'format' | 'body' | 'thread_posts' | 'poll_options'>

export function contentFieldErrorsFrom(err: unknown): ContentFieldErrors | null {
  return clientFieldErrorsFrom(err, ['x_account_id', 'format', 'body', 'thread_posts', 'poll_options'] as const)
}

export function describeContentError(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return err.message
  return describeApiError(err, 'You do not have permission to manage content.')
}

/** All text of a post as one string (for previews and copy). */
export function contentText(item: Pick<ContentItem, 'format' | 'body' | 'thread_posts' | 'poll_options'>): string {
  if (item.format === 'THREAD') return item.thread_posts.join('\n\n')
  if (item.format === 'POLL') return [item.body, ...item.poll_options.map((o) => `• ${o}`)].join('\n')
  return item.body
}
