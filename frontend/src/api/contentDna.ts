// Client for an X account's Content DNA (/api/x-accounts/<id>/content-dna/).

import {
  ApiError,
  csrfToken,
  describeApiError,
  fieldErrorsFrom as clientFieldErrorsFrom,
  request,
  sendJson,
  type FieldErrors as ClientFieldErrors,
} from './client'

export type Language = 'ENGLISH' | 'TELUGU' | 'TINGLISH'
export type ContentFormat = 'TEXT' | 'THREAD' | 'POLL'

export interface ContentDNAInput {
  primary_themes: string[]
  secondary_themes: string[]
  languages: Language[]
  tone: string[]
  target_audience: string
  writing_style: string
  allowed_formats: ContentFormat[]
  topics_to_avoid: string[]
  example_posts: string[]
  daily_post_target: number
  additional_instructions: string
}

export interface ContentDNA extends ContentDNAInput {
  x_account: number
  created_at: string
  updated_at: string
}

export const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'ENGLISH', label: 'English' },
  { value: 'TELUGU', label: 'Telugu' },
  { value: 'TINGLISH', label: 'Tinglish' },
]

export const FORMAT_OPTIONS: { value: ContentFormat; label: string; hint: string }[] = [
  { value: 'TEXT', label: 'Text', hint: 'A single post' },
  { value: 'THREAD', label: 'Thread', hint: 'A series of connected posts' },
  { value: 'POLL', label: 'Poll', hint: 'A question with options' },
]

/** Quick picks only; any tone can be typed in. */
export const TONE_SUGGESTIONS = ['Witty', 'Warm', 'Informative', 'Inspirational', 'Conversational', 'Thoughtful', 'Playful', 'Bold']

/** Mirrors the limits in x_accounts.models.ContentDNA; the server remains authoritative. */
export const LIMITS = {
  primary_themes: { max: 5, length: 60 },
  secondary_themes: { max: 10, length: 60 },
  tone: { max: 6, length: 40 },
  topics_to_avoid: { max: 20, length: 80 },
  example_posts: { max: 10, length: 1000 },
  target_audience: 500,
  writing_style: 1000,
  additional_instructions: 2000,
  daily_post_target: { min: 1, max: 20 },
} as const

const path = (accountId: number) => `/api/x-accounts/${accountId}/content-dna/`

/** The account's Content DNA, or null when it hasn't been configured yet. */
export async function getContentDNA(accountId: number): Promise<ContentDNA | null> {
  try {
    const response = await request(path(accountId))
    return response.json()
  } catch (err) {
    // A 404 for an unknown account has no `configured` flag and is rethrown.
    if (err instanceof ApiError && err.status === 404 && (err.data as { configured?: unknown })?.configured === false) {
      return null
    }
    throw err
  }
}

export async function createContentDNA(accountId: number, input: ContentDNAInput): Promise<ContentDNA> {
  const response = await sendJson('POST', path(accountId), await csrfToken(), input)
  return response.json()
}

export async function updateContentDNA(accountId: number, changes: Partial<ContentDNAInput>): Promise<ContentDNA> {
  const response = await sendJson('PATCH', path(accountId), await csrfToken(), changes)
  return response.json()
}

export type ContentDNAField = keyof ContentDNAInput
export type ContentDNAFieldErrors = ClientFieldErrors<ContentDNAField>

const FIELDS: readonly ContentDNAField[] = [
  'primary_themes',
  'secondary_themes',
  'languages',
  'tone',
  'target_audience',
  'writing_style',
  'allowed_formats',
  'topics_to_avoid',
  'example_posts',
  'daily_post_target',
  'additional_instructions',
]

/** One message per field from a DRF 400 response. */
export function contentDnaFieldErrorsFrom(err: unknown): ContentDNAFieldErrors | null {
  return clientFieldErrorsFrom(err, FIELDS)
}

export function describeContentDnaError(err: unknown): string {
  return describeApiError(err, 'You do not have permission to manage Content DNA.')
}
