import { useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import {
  FORMAT_LABELS,
  POLL_LIMITS,
  POST_MAX_LENGTH,
  THREAD_LIMITS,
  contentFieldErrorsFrom,
  createContent,
  describeContentError,
  updateContent,
  type AccountSummary,
  type ContentFieldErrors,
  type ContentInput,
  type ContentItem,
} from '../../api/content'
import type { ContentFormat } from '../../api/contentDna'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { Modal } from './Modal'
import { inputClass, primaryButton, secondaryButton } from './styles'

interface ContentEditorDialogProps {
  /** The post to edit; omit to write a new one. */
  item?: ContentItem
  /** Accounts to choose from when writing a new post. */
  accounts?: AccountSummary[]
  defaultAccountId?: number
  onClose: () => void
  onSaved: (item: ContentItem, created: boolean) => void
}

const FORMATS: ContentFormat[] = ['TEXT', 'THREAD', 'POLL']

function Counter({ value, max }: { value: string; max: number }) {
  const length = value.trim().length
  return <span className={`text-xs ${length > max ? 'font-medium text-red-600' : 'text-slate-400'}`}>{length}/{max}</span>
}

function localErrors(input: ContentInput): ContentFieldErrors {
  const errors: ContentFieldErrors = {}
  const body = input.body.trim()
  if (input.format === 'THREAD') {
    const posts = input.thread_posts.map((p) => p.trim())
    const empty = posts.findIndex((p) => !p)
    const long = posts.findIndex((p) => p.length > POST_MAX_LENGTH)
    if (posts.length < THREAD_LIMITS.min) errors.thread_posts = `A thread needs at least ${THREAD_LIMITS.min} posts.`
    else if (empty >= 0) errors.thread_posts = `Post ${empty + 1} is empty.`
    else if (long >= 0) errors.thread_posts = `Post ${long + 1} is over ${POST_MAX_LENGTH} characters.`
    return errors
  }
  const label = input.format === 'POLL' ? 'poll question' : 'post'
  if (!body) errors.body = `Write the ${label}.`
  else if (body.length > POST_MAX_LENGTH) errors.body = `The ${label} is over ${POST_MAX_LENGTH} characters.`
  if (input.format === 'POLL') {
    const options = input.poll_options.map((o) => o.trim())
    const empty = options.findIndex((o) => !o)
    const seen = new Set<string>()
    const repeated = options.findIndex((o) => seen.size === seen.add(o.toLowerCase()).size)
    if (options.length < POLL_LIMITS.min) errors.poll_options = `A poll needs at least ${POLL_LIMITS.min} options.`
    else if (empty >= 0) errors.poll_options = `Option ${empty + 1} is empty.`
    else if (options.some((o) => o.length > POLL_LIMITS.optionLength)) errors.poll_options = `Keep options to ${POLL_LIMITS.optionLength} characters.`
    else if (repeated >= 0) errors.poll_options = `Option ${repeated + 1} repeats another option.`
  }
  return errors
}

export function ContentEditorDialog({ item, accounts = [], defaultAccountId, onClose, onSaved }: ContentEditorDialogProps) {
  const { clearUser } = useAuth()
  const editing = item !== undefined
  const [accountId, setAccountId] = useState<number | ''>(item?.x_account.id ?? defaultAccountId ?? '')
  const [format, setFormat] = useState<ContentFormat>(item?.format ?? 'TEXT')
  const [body, setBody] = useState(item?.body ?? '')
  const [posts, setPosts] = useState<string[]>(item?.thread_posts.length ? item.thread_posts : ['', ''])
  const [options, setOptions] = useState<string[]>(item?.poll_options.length ? item.poll_options : ['', ''])
  const [errors, setErrors] = useState<ContentFieldErrors>({})
  const [saving, setSaving] = useState(false)

  const input: ContentInput = {
    format,
    body: format === 'THREAD' ? '' : body.trim(),
    thread_posts: format === 'THREAD' ? posts.map((p) => p.trim()) : [],
    poll_options: format === 'POLL' ? options.map((o) => o.trim()) : [],
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const local = localErrors(input)
    if (!editing && accountId === '') local.x_account_id = 'Choose an X account.'
    setErrors(local)
    if (Object.keys(local).length) return
    setSaving(true)
    try {
      const saved = editing ? await updateContent(item.id, input, item.version) : await createContent(Number(accountId), input)
      onSaved(saved, !editing)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return clearUser()
      setErrors(contentFieldErrorsFrom(err) ?? { form: describeContentError(err) })
      setSaving(false)
    }
  }

  const field = (id: string, label: string, error: string | undefined, control: ReactNode, aside?: ReactNode) => (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {label}
        </label>
        {aside}
      </div>
      {control}
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  )

  return (
    <Modal
      title={editing ? `Edit post for @${item.x_account.handle}` : 'Write a post'}
      description={
        editing
          ? item.status === 'APPROVED'
            ? 'This post is approved. Saving changes returns it to draft for approval again.'
            : 'Changes are checked again for duplicates and warnings.'
          : 'Manual posts go to the Content Library as drafts.'
      }
      onClose={onClose}
      busy={saving}
      size="lg"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className={secondaryButton}>
            Cancel
          </button>
          <button type="submit" form="content-editor" disabled={saving} className={primaryButton}>
            {saving && <Spinner />}
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save draft'}
          </button>
        </>
      }
    >
      <form id="content-editor" onSubmit={handleSubmit} noValidate className="space-y-5">
        {errors.form && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {errors.form}
          </div>
        )}
        {!editing &&
          field(
            'content-account',
            'X account',
            errors.x_account_id,
            <select
              id="content-account"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : '')}
              disabled={saving}
              aria-invalid={errors.x_account_id ? true : undefined}
              className={inputClass(!!errors.x_account_id)}
            >
              <option value="">Choose an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.handle} · {a.display_name}
                </option>
              ))}
            </select>,
          )}

        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Format</legend>
          <div className="mt-1.5 inline-flex rounded-lg bg-slate-100 p-1">
            {FORMATS.map((f) => (
              <label
                key={f}
                className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition has-focus-visible:outline-2 has-focus-visible:outline-indigo-600 ${
                  format === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <input type="radio" name="content-format" value={f} checked={format === f} onChange={() => setFormat(f)} disabled={saving} className="sr-only" />
                {FORMAT_LABELS[f]}
              </label>
            ))}
          </div>
        </fieldset>

        {format !== 'THREAD' &&
          field(
            'content-body',
            format === 'POLL' ? 'Poll question' : 'Post',
            errors.body,
            <textarea
              id="content-body"
              rows={format === 'POLL' ? 2 : 5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={saving}
              aria-invalid={errors.body ? true : undefined}
              aria-describedby={errors.body ? 'content-body-error' : undefined}
              className={`${inputClass(!!errors.body)} resize-y`}
            />,
            <Counter value={body} max={POST_MAX_LENGTH} />,
          )}

        {format === 'THREAD' && (
          <fieldset className="space-y-3" aria-describedby={errors.thread_posts ? 'thread-error' : undefined}>
            <legend className="text-sm font-medium text-slate-700">Thread posts</legend>
            {posts.map((post, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor={`thread-post-${i}`} className="text-xs font-medium text-slate-600">
                    Post {i + 1}
                  </label>
                  <div className="flex items-center gap-3">
                    <Counter value={post} max={POST_MAX_LENGTH} />
                    {posts.length > THREAD_LIMITS.min && (
                      <button
                        type="button"
                        onClick={() => setPosts(posts.filter((_, j) => j !== i))}
                        aria-label={`Remove post ${i + 1}`}
                        className="text-xs font-medium text-red-600 hover:text-red-500"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  id={`thread-post-${i}`}
                  rows={3}
                  value={post}
                  onChange={(e) => setPosts(posts.map((p, j) => (j === i ? e.target.value : p)))}
                  disabled={saving}
                  className={`${inputClass(post.trim().length > POST_MAX_LENGTH)} resize-y`}
                />
              </div>
            ))}
            <button type="button" onClick={() => setPosts([...posts, ''])} disabled={saving || posts.length >= THREAD_LIMITS.max} className={secondaryButton}>
              + Add post
            </button>
            {errors.thread_posts && (
              <p id="thread-error" className="text-sm text-red-600">
                {errors.thread_posts}
              </p>
            )}
          </fieldset>
        )}

        {format === 'POLL' && (
          <fieldset className="space-y-2" aria-describedby={errors.poll_options ? 'poll-error' : undefined}>
            <legend className="text-sm font-medium text-slate-700">Poll options</legend>
            {options.map((option, i) => (
              <div key={i} className="flex items-center gap-2">
                <label htmlFor={`poll-option-${i}`} className="sr-only">
                  Option {i + 1}
                </label>
                <input
                  id={`poll-option-${i}`}
                  type="text"
                  placeholder={`Option ${i + 1}`}
                  value={option}
                  onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
                  disabled={saving}
                  className={inputClass(option.trim().length > POLL_LIMITS.optionLength)}
                />
                <Counter value={option} max={POLL_LIMITS.optionLength} />
                {options.length > POLL_LIMITS.min && (
                  <button
                    type="button"
                    onClick={() => setOptions(options.filter((_, j) => j !== i))}
                    aria-label={`Remove option ${i + 1}`}
                    className="text-xs font-medium text-red-600 hover:text-red-500"
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setOptions([...options, ''])} disabled={saving || options.length >= POLL_LIMITS.max} className={secondaryButton}>
              + Add option
            </button>
            {errors.poll_options && (
              <p id="poll-error" className="text-sm text-red-600">
                {errors.poll_options}
              </p>
            )}
          </fieldset>
        )}
      </form>
    </Modal>
  )
}
