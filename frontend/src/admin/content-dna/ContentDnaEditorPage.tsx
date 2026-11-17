import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useBlocker, useParams } from 'react-router'
import { ApiError } from '../../api/client'
import {
  FORMAT_OPTIONS,
  LANGUAGE_OPTIONS,
  LIMITS,
  TONE_SUGGESTIONS,
  contentDnaFieldErrorsFrom,
  createContentDNA,
  describeContentDnaError,
  getContentDNA,
  updateContentDNA,
  type ContentDNA,
  type ContentDNAFieldErrors,
  type ContentDNAInput,
} from '../../api/contentDna'
import { getXAccount, type XAccount } from '../../api/xAccounts'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { ChoiceGroup, ConfiguredBadge, ExamplePostsField, NumberField, TagListField, TextAreaField } from './ContentDnaFields'

/** Editor state: like the API input, but the target is kept as typed. */
type FormValues = Omit<ContentDNAInput, 'daily_post_target'> & { daily_post_target: string }

const EMPTY: FormValues = {
  primary_themes: [],
  secondary_themes: [],
  languages: [],
  tone: [],
  target_audience: '',
  writing_style: '',
  allowed_formats: [],
  topics_to_avoid: [],
  example_posts: [],
  daily_post_target: '',
  additional_instructions: '',
}

const toForm = (dna: ContentDNA | null): FormValues =>
  dna ? { ...EMPTY, ...pickInput(dna), daily_post_target: String(dna.daily_post_target) } : EMPTY

const INPUT_FIELDS = Object.keys(EMPTY) as (keyof ContentDNAInput)[]

function pickInput(dna: ContentDNA): ContentDNAInput {
  return Object.fromEntries(INPUT_FIELDS.map((k) => [k, dna[k]])) as unknown as ContentDNAInput
}

/** What would be sent: trimmed text, and the target parsed (NaN when not a number). */
function toInput(values: FormValues): ContentDNAInput {
  const target = values.daily_post_target.trim()
  return {
    ...values,
    example_posts: values.example_posts.map((p) => p.trim()),
    target_audience: values.target_audience.trim(),
    writing_style: values.writing_style.trim(),
    additional_instructions: values.additional_instructions.trim(),
    daily_post_target: /^\d+$/.test(target) ? Number(target) : Number.NaN,
  }
}

function localErrors(input: ContentDNAInput): ContentDNAFieldErrors {
  const errors: ContentDNAFieldErrors = {}
  if (!input.primary_themes.length) errors.primary_themes = 'Add at least one primary theme.'
  if (!input.languages.length) errors.languages = 'Choose at least one language.'
  if (!input.tone.length) errors.tone = 'Add at least one tone.'
  if (!input.target_audience) errors.target_audience = 'Describe the target audience.'
  else if (input.target_audience.length > LIMITS.target_audience) errors.target_audience = `Keep this to ${LIMITS.target_audience} characters.`
  if (!input.writing_style) errors.writing_style = 'Describe the writing style.'
  else if (input.writing_style.length > LIMITS.writing_style) errors.writing_style = `Keep this to ${LIMITS.writing_style} characters.`
  if (!input.allowed_formats.length) errors.allowed_formats = 'Choose at least one format.'
  const blankExample = input.example_posts.findIndex((p) => !p)
  if (blankExample >= 0) errors.example_posts = `Example ${blankExample + 1} is empty. Write it or remove it.`
  else if (input.example_posts.some((p) => p.length > LIMITS.example_posts.length)) {
    errors.example_posts = `Keep each example to ${LIMITS.example_posts.length} characters.`
  }
  const { min, max } = LIMITS.daily_post_target
  if (Number.isNaN(input.daily_post_target)) errors.daily_post_target = 'Enter a whole number of posts.'
  else if (input.daily_post_target < min || input.daily_post_target > max) {
    errors.daily_post_target = `Choose between ${min} and ${max} posts per day.`
  }
  if (input.additional_instructions.length > LIMITS.additional_instructions) {
    errors.additional_instructions = `Keep this to ${LIMITS.additional_instructions} characters.`
  }
  return errors
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const updatedFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
})

const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60'
const secondaryButton =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60'

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4 sm:px-6">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        <p className="mt-0.5 text-sm text-slate-500">{description}</p>
      </div>
      <div className="space-y-6 px-5 py-5 sm:px-6">{children}</div>
    </section>
  )
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; account: XAccount }

export function ContentDnaEditorPage() {
  const { id } = useParams()
  const accountId = Number(id)
  const { clearUser } = useAuth()
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [saved, setSaved] = useState<ContentDNA | null>(null)
  const [values, setValues] = useState<FormValues>(EMPTY)
  const [errors, setErrors] = useState<ContentDNAFieldErrors>({})
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const handleFailure = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        clearUser()
        return true
      }
      return false
    },
    [clearUser],
  )

  useEffect(() => {
    let cancelled = false
    if (!Number.isInteger(accountId) || accountId < 1) {
      setLoad({ status: 'error', message: 'That X account could not be found.', notFound: true })
      return
    }
    setLoad({ status: 'loading' })
    Promise.all([getXAccount(accountId), getContentDNA(accountId)])
      .then(([account, dna]) => {
        if (cancelled) return
        setSaved(dna)
        setValues(toForm(dna))
        setErrors({})
        setConflict(false)
        setLoad({ status: 'ready', account })
      })
      .catch((err) => {
        if (cancelled || handleFailure(err)) return
        const notFound = err instanceof ApiError && err.status === 404
        setLoad({
          status: 'error',
          message: notFound ? 'That X account could not be found.' : describeContentDnaError(err),
          notFound,
        })
      })
    return () => {
      cancelled = true
    }
  }, [accountId, reloadKey, handleFailure])

  const baseline = useMemo(() => toInput(toForm(saved)), [saved])
  const current = useMemo(() => toInput(values), [values])
  const changed = useMemo(
    () => (Object.keys(current) as (keyof ContentDNAInput)[]).filter((k) => !sameValue(current[k], baseline[k])),
    [current, baseline],
  )
  const dirty = load.status === 'ready' && changed.length > 0

  // Warn before leaving the page in-app (router) or closing/reloading the tab.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && !saving && currentLocation.pathname !== nextLocation.pathname,
  )
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 5000)
    return () => clearTimeout(timer)
  }, [success])

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }))
    setSuccess(null)
    setErrors((e) => {
      if (!e[key] && !e.form) return e
      const rest = { ...e }
      delete rest[key]
      delete rest.form
      return rest
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const local = localErrors(current)
    if (Object.keys(local).length) {
      setErrors({ ...local, form: 'Please fix the highlighted fields.' })
      return
    }
    setSaving(true)
    setErrors({})
    setSuccess(null)
    try {
      const result = saved
        ? await updateContentDNA(accountId, Object.fromEntries(changed.map((k) => [k, current[k]])))
        : await createContentDNA(accountId, current)
      setSaved(result)
      setValues(toForm(result))
      setSuccess(saved ? 'Content DNA saved.' : 'Content DNA created for this account.')
      window.scrollTo?.({ top: 0, behavior: 'smooth' })
    } catch (err) {
      if (handleFailure(err)) return
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true)
        setErrors({ form: 'Content DNA was created for this account in another session. Reload to see it before editing.' })
      } else if (err instanceof ApiError && err.status === 404 && saved) {
        setErrors({ form: 'This Content DNA could not be found. Reload the page and try again.' })
      } else {
        const fields = contentDnaFieldErrorsFrom(err)
        setErrors(
          fields
            ? { ...fields, form: fields.form ?? 'Please fix the highlighted fields.' }
            : { form: describeContentDnaError(err) },
        )
      }
    } finally {
      setSaving(false)
    }
  }

  const back = (
    <Link to="/admin/x-accounts" className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-500">
      <span aria-hidden="true">←</span> X Accounts
    </Link>
  )

  if (load.status === 'loading') {
    return (
      <div className="space-y-6">
        {back}
        <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Spinner />
          Loading Content DNA…
        </p>
      </div>
    )
  }

  if (load.status === 'error') {
    return (
      <div className="space-y-6">
        {back}
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{load.message}</span>
          {!load.notFound && (
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={secondaryButton}>
              Retry
            </button>
          )}
        </div>
      </div>
    )
  }

  const { account } = load
  const disabled = saving || conflict

  return (
    <div className="space-y-6 pb-24">
      {back}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Content DNA</h1>
          <p className="mt-1 truncate text-sm text-slate-500">
            <span className="font-medium text-slate-700">@{account.handle}</span> · {account.display_name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <ConfiguredBadge configured={saved !== null} />
          {saved && <span>Last saved {updatedFormat.format(new Date(saved.updated_at))} IST</span>}
        </div>
      </div>

      {!saved && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This account doesn’t have Content DNA yet. Describe its editorial identity below; it will guide AI drafts in a later
          phase.
        </p>
      )}
      {success && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <span>{success}</span>
          <button type="button" onClick={() => setSuccess(null)} className="font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}
      {errors.form && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          <span>{errors.form}</span>
          {conflict && (
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={secondaryButton}>
              Reload
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate aria-label="Content DNA" className="space-y-6">
        <Section title="Themes" description="What this account talks about, and what it stays away from.">
          <TagListField
            id="dna-primary_themes"
            label="Primary themes"
            itemLabel="primary theme"
            hint="The account’s main subjects. At least one."
            values={values.primary_themes}
            onChange={(v) => set('primary_themes', v)}
            max={LIMITS.primary_themes.max}
            maxLength={LIMITS.primary_themes.length}
            placeholder="e.g. Cricket"
            error={errors.primary_themes}
            disabled={disabled}
          />
          <TagListField
            id="dna-secondary_themes"
            label="Secondary themes"
            itemLabel="secondary theme"
            hint="Related topics for occasional variety. Optional."
            values={values.secondary_themes}
            onChange={(v) => set('secondary_themes', v)}
            max={LIMITS.secondary_themes.max}
            maxLength={LIMITS.secondary_themes.length}
            placeholder="e.g. Hyderabad food"
            error={errors.secondary_themes}
            disabled={disabled}
          />
          <TagListField
            id="dna-topics_to_avoid"
            label="Topics to avoid"
            itemLabel="topic to avoid"
            hint="Subjects this account should never post about. Optional."
            values={values.topics_to_avoid}
            onChange={(v) => set('topics_to_avoid', v)}
            max={LIMITS.topics_to_avoid.max}
            maxLength={LIMITS.topics_to_avoid.length}
            placeholder="e.g. Politics"
            error={errors.topics_to_avoid}
            disabled={disabled}
          />
        </Section>

        <Section title="Voice" description="How the account sounds and who it speaks to.">
          <ChoiceGroup
            id="dna-languages"
            label="Languages"
            hint="Choose every language this account may post in."
            options={LANGUAGE_OPTIONS}
            values={values.languages}
            onChange={(v) => set('languages', v)}
            error={errors.languages}
            disabled={disabled}
          />
          <TagListField
            id="dna-tone"
            label="Tone"
            itemLabel="tone"
            hint="Pick suggestions or type your own descriptors."
            values={values.tone}
            onChange={(v) => set('tone', v)}
            max={LIMITS.tone.max}
            maxLength={LIMITS.tone.length}
            placeholder="e.g. Witty"
            suggestions={TONE_SUGGESTIONS}
            error={errors.tone}
            disabled={disabled}
          />
          <TextAreaField
            id="dna-target_audience"
            label="Target audience"
            hint="Who the posts are for."
            value={values.target_audience}
            onChange={(v) => set('target_audience', v)}
            maxLength={LIMITS.target_audience}
            rows={2}
            error={errors.target_audience}
            disabled={disabled}
            placeholder="e.g. Young Telugu speakers who follow cricket closely"
          />
          <TextAreaField
            id="dna-writing_style"
            label="Writing style"
            hint="Sentence length, structure, humour, emoji use and so on."
            value={values.writing_style}
            onChange={(v) => set('writing_style', v)}
            maxLength={LIMITS.writing_style}
            error={errors.writing_style}
            disabled={disabled}
            placeholder="e.g. Short, conversational lines with a light punchline"
          />
        </Section>

        <Section title="Output" description="Which formats to use and how much to post.">
          <ChoiceGroup
            id="dna-allowed_formats"
            label="Allowed formats"
            options={FORMAT_OPTIONS}
            values={values.allowed_formats}
            onChange={(v) => set('allowed_formats', v)}
            error={errors.allowed_formats}
            disabled={disabled}
          />
          <NumberField
            id="dna-daily_post_target"
            label="Daily posting target"
            hint={`Posts per day for this account, between ${LIMITS.daily_post_target.min} and ${LIMITS.daily_post_target.max}.`}
            value={values.daily_post_target}
            onChange={(v) => set('daily_post_target', v)}
            min={LIMITS.daily_post_target.min}
            max={LIMITS.daily_post_target.max}
            error={errors.daily_post_target}
            disabled={disabled}
          />
        </Section>

        <Section title="Examples and instructions" description="Reference material for future AI drafts.">
          <ExamplePostsField
            id="dna-example_posts"
            values={values.example_posts}
            onChange={(v) => set('example_posts', v)}
            max={LIMITS.example_posts.max}
            maxLength={LIMITS.example_posts.length}
            error={errors.example_posts}
            disabled={disabled}
          />
          <TextAreaField
            id="dna-additional_instructions"
            label="Additional instructions (optional)"
            hint="Anything else future AI drafts should follow for this account."
            value={values.additional_instructions}
            onChange={(v) => set('additional_instructions', v)}
            maxLength={LIMITS.additional_instructions}
            rows={4}
            error={errors.additional_instructions}
            disabled={disabled}
          />
        </Section>

        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:left-60 lg:px-8">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <p className="text-sm text-slate-500" aria-live="polite">
              {dirty ? (
                <span className="font-medium text-amber-700">Unsaved changes</span>
              ) : saved ? (
                'All changes saved'
              ) : (
                'Not saved yet'
              )}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setValues(toForm(saved))
                  setErrors({})
                }}
                disabled={!dirty || disabled}
                className={secondaryButton}
              >
                Discard
              </button>
              <button type="submit" disabled={disabled || (saved !== null && !dirty)} className={primaryButton}>
                {saving && <Spinner />}
                {saving ? 'Saving…' : saved ? 'Save changes' : 'Create Content DNA'}
              </button>
            </div>
          </div>
        </div>
      </form>

      {blocker.state === 'blocked' && (
        <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
          <div className="fixed inset-0 bg-navy-950/50" aria-hidden="true" />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="leave-title"
            aria-describedby="leave-description"
            className="relative w-full rounded-t-2xl bg-white p-6 shadow-xl sm:max-w-md sm:rounded-2xl"
          >
            <h2 id="leave-title" className="text-lg font-semibold text-slate-900">
              Leave without saving?
            </h2>
            <p id="leave-description" className="mt-1 text-sm text-slate-500">
              Your changes to @{account.handle}’s Content DNA will be lost.
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" autoFocus onClick={() => blocker.reset()} className={secondaryButton}>
                Stay on page
              </button>
              <button
                type="button"
                onClick={() => blocker.proceed()}
                className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-500"
              >
                Leave page
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
