// Client for the Millionaire-only Distribution API (/api/distribution/).
// OM2 prepares WhatsApp links; a Millionaire sends each message by hand.

import { ApiError, csrfToken, describeApiError, request, sendJson } from './client'
import type { ContentFormat } from './contentDna'
import type { Page } from './xAccounts'

export type MessageStatus = 'PENDING' | 'OPENED' | 'SENT' | 'CANCELLED'

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  PENDING: 'Pending',
  OPENED: 'Opened',
  SENT: 'Sent (confirmed)',
  CANCELLED: 'Cancelled',
}

/** Posts per WhatsApp message (the server may split further to keep links short enough). */
export const MAX_POSTS_PER_MESSAGE = 5

export interface CandidatePost {
  id: number
  x_account: { id: number; handle: string }
  format: ContentFormat
  body: string
  thread_posts: string[]
  poll_options: string[]
  reviewed_at: string | null
  /** Batch whose Pending or Opened message already holds this post. */
  active_batch_id: number | null
  /** Last time a Millionaire confirmed sending it. */
  sent_at: string | null
  /** Why it can't be selected (not counting "already sent", which can be included on purpose). */
  unavailable_reason: string | null
}

export interface CandidateGroup {
  omkar: { id: number; display_name: string; phone_number: string }
  unavailable_reason: string | null
  accounts: { id: number; handle: string; status: 'ACTIVE' | 'PAUSED' }[]
  posts: CandidatePost[]
}

export interface Candidates {
  omkars: CandidateGroup[]
  unassigned_count: number
}

export interface DistributionMessage {
  id: number
  batch_id: number
  omkar: { id: number; display_name: string }
  phone_number: string
  position: number
  of: number
  status: MessageStatus
  text: string
  /** wa.me link; null once sent or cancelled. */
  url: string | null
  url_length: number
  warnings: { code: string; message: string }[]
  posts: { id: number; handle: string; format: ContentFormat; short_link: boolean }[]
  open_count: number
  opened_at: string | null
  opened_by: { id: number; display_name: string } | null
  sent_confirmed_at: string | null
  sent_confirmed_by: { id: number; display_name: string } | null
  cancelled_at: string | null
}

export interface Batch {
  id: number
  created_at: string
  created_by: { id: number; display_name: string } | null
  messages: DistributionMessage[]
}

export interface BatchSummary {
  id: number
  created_at: string
  created_by: { id: number; display_name: string } | null
  counts: Record<MessageStatus, number>
}

const BASE = '/api/distribution/'

export async function getCandidates(): Promise<Candidates> {
  return (await request(`${BASE}candidates/`)).json()
}

export async function listBatches(): Promise<Page<BatchSummary>> {
  return (await request(`${BASE}batches/`)).json()
}

export async function getBatch(id: number): Promise<Batch> {
  return (await request(`${BASE}batches/${id}/`)).json()
}

export async function prepareBatch(itemIds: number[], includeSent = false): Promise<Batch> {
  const response = await sendJson('POST', `${BASE}batches/`, await csrfToken(), { item_ids: itemIds, include_sent: includeSent })
  return response.json()
}

export async function messageAction(id: number, action: 'open' | 'confirm-sent' | 'cancel'): Promise<DistributionMessage> {
  const response = await sendJson('POST', `${BASE}messages/${id}/${action}/`, await csrfToken())
  return response.json()
}

export function describeDistributionError(err: unknown): string {
  if (err instanceof ApiError && (err.status === 409 || err.status === 400)) {
    const data = err.data as { item_ids?: string[] } | null
    return data?.item_ids?.[0] ?? err.message
  }
  return describeApiError(err, 'You do not have permission to manage distribution.')
}
