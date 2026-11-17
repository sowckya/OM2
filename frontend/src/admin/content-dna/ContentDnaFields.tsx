import { useState, type KeyboardEvent, type ReactNode } from 'react'

// Form controls for the Content DNA editor. Each renders a labelled group with an
// optional hint and the server's (or local) error message beside it.

const inputBase =
  'block w-full rounded-lg border px-3 py-2 text-base text-slate-900 shadow-sm outline-none transition focus:ring-2 disabled:bg-slate-50 sm:text-sm'
const inputClass = (invalid: boolean) =>
  `${inputBase} ${invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-500/30' : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/30'}`

const smallButton =
  'inline-flex shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50'

interface GroupProps {
  id: string
  label: string
  hint?: ReactNode
  error?: string
  children: ReactNode
}

/** A fieldset whose legend is the field label, with hint and error text. */
export function FieldGroup({ id, label, hint, error, children }: GroupProps) {
  return (
    <fieldset aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} className="min-w-0 space-y-2">
      <legend className="text-sm font-medium text-slate-800">{label}</legend>
      {hint && (
        <p id={`${id}-hint`} className="-mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-600">
          {error}
        </p>
      )}
    </fieldset>
  )
}

interface TagListProps {
  id: string
  label: string
  /** Singular name for one entry, used in button labels, e.g. "primary theme". */
  itemLabel: string
  hint?: ReactNode
  values: string[]
  onChange: (values: string[]) => void
  max: number
  maxLength: number
  placeholder?: string
  suggestions?: readonly string[]
  error?: string
  disabled?: boolean
}

const sameEntry = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()

/** A list of short entries shown as chips; each can be edited in place or removed. */
export function TagListField({
  id,
  label,
  itemLabel,
  hint,
  values,
  onChange,
  max,
  maxLength,
  placeholder,
  suggestions = [],
  error,
  disabled,
}: TagListProps) {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ index: number; text: string } | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const full = values.length >= max

  function problem(text: string, ignoreIndex?: number): string | null {
    const value = text.trim()
    if (!value) return `Type a ${itemLabel} first.`
    if (value.length > maxLength) return `Keep each ${itemLabel} to ${maxLength} characters.`
    if (values.some((v, i) => i !== ignoreIndex && sameEntry(v, value))) return `“${value}” is already listed.`
    return null
  }

  function add(text = draft) {
    if (full) return setLocalError(`You can add up to ${max}.`)
    const message = problem(text)
    setLocalError(message)
    if (message) return
    onChange([...values, text.trim()])
    if (text === draft) setDraft('')
  }

  function commitEdit() {
    if (!editing) return
    const message = problem(editing.text, editing.index)
    setLocalError(message)
    if (message) return
    onChange(values.map((v, i) => (i === editing.index ? editing.text.trim() : v)))
    setEditing(null)
  }

  function onDraftKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      add()
    }
  }

  function onEditKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setEditing(null)
      setLocalError(null)
    }
  }

  const unused = suggestions.filter((s) => !values.some((v) => sameEntry(v, s)))
  const shownError = localError ?? error

  return (
    <FieldGroup id={id} label={label} hint={hint} error={shownError ?? undefined}>
      {values.length > 0 && (
        <ul aria-label={`${label} entries`} className="flex flex-wrap gap-2">
          {values.map((value, index) =>
            editing?.index === index ? (
              <li key={index} className="flex w-full items-center gap-2 sm:w-auto">
                <input
                  type="text"
                  autoFocus
                  aria-label={`Edit ${itemLabel} ${value}`}
                  value={editing.text}
                  onChange={(e) => setEditing({ index, text: e.target.value })}
                  onKeyDown={onEditKey}
                  className={`${inputClass(!!localError)} py-1 sm:w-56`}
                />
                <button type="button" onClick={commitEdit} className={`${smallButton} py-1`}>
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null)
                    setLocalError(null)
                  }}
                  className="text-sm font-medium text-slate-500 hover:text-slate-700"
                >
                  Cancel
                </button>
              </li>
            ) : (
              <li
                key={index}
                className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-indigo-50 py-1 pr-1 pl-3 text-sm font-medium text-indigo-800 ring-1 ring-indigo-600/15 ring-inset"
              >
                <button
                  type="button"
                  onClick={() => setEditing({ index, text: value })}
                  disabled={disabled}
                  aria-label={`Edit ${itemLabel} ${value}`}
                  title="Edit"
                  className="min-w-0 truncate text-left hover:underline focus-visible:outline-2 focus-visible:outline-indigo-600"
                >
                  {value}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onChange(values.filter((_, i) => i !== index))
                    setLocalError(null)
                  }}
                  disabled={disabled}
                  aria-label={`Remove ${itemLabel} ${value}`}
                  className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-indigo-500 hover:bg-indigo-100 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-600"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          aria-label={`Add ${itemLabel}`}
          placeholder={full ? `Maximum of ${max} reached` : placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onDraftKey}
          disabled={disabled || full}
          maxLength={maxLength + 20}
          aria-invalid={shownError ? true : undefined}
          className={inputClass(!!shownError)}
        />
        <button type="button" onClick={() => add()} disabled={disabled || full} className={smallButton}>
          Add
        </button>
      </div>
      {unused.length > 0 && !full && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-500">Suggestions:</span>
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              disabled={disabled}
              aria-label={`Add ${itemLabel} ${s}`}
              className="rounded-full px-2.5 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-slate-300 ring-inset hover:bg-slate-50 hover:text-slate-900"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-slate-400">
        {values.length} of {max}
      </p>
    </FieldGroup>
  )
}

interface ChoiceGroupProps<T extends string> {
  id: string
  label: string
  hint?: string
  options: { value: T; label: string; hint?: string }[]
  values: T[]
  onChange: (values: T[]) => void
  error?: string
  disabled?: boolean
}

/** Checkboxes for picking any number of fixed options; keeps the options' order. */
export function ChoiceGroup<T extends string>({ id, label, hint, options, values, onChange, error, disabled }: ChoiceGroupProps<T>) {
  function toggle(value: T, checked: boolean) {
    const next = checked ? [...values, value] : values.filter((v) => v !== value)
    onChange(options.map((o) => o.value).filter((v) => next.includes(v)))
  }
  return (
    <FieldGroup id={id} label={label} hint={hint} error={error}>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const checked = values.includes(option.value)
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition ${
                checked ? 'border-indigo-300 bg-indigo-50/60' : 'border-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => toggle(option.value, e.target.checked)}
                disabled={disabled}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              <span>
                <span className="block font-medium text-slate-900">{option.label}</span>
                {option.hint && <span className="block text-xs text-slate-500">{option.hint}</span>}
              </span>
            </label>
          )
        })}
      </div>
    </FieldGroup>
  )
}

interface TextAreaProps {
  id: string
  label: string
  hint?: string
  value: string
  onChange: (value: string) => void
  maxLength: number
  rows?: number
  error?: string
  disabled?: boolean
  placeholder?: string
}

/** A labelled textarea with a character counter. */
export function TextAreaField({ id, label, hint, value, onChange, maxLength, rows = 3, error, disabled, placeholder }: TextAreaProps) {
  const over = value.trim().length > maxLength
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="-mt-0.5 text-xs text-slate-500">
          {hint}
        </p>
      )}
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={`${inputClass(!!error || over)} resize-y`}
      />
      <div className="flex justify-between gap-3 text-xs">
        <span id={`${id}-error`} className="text-sm text-red-600">
          {error}
        </span>
        <span className={over ? 'font-medium text-red-600' : 'text-slate-400'}>
          {value.trim().length} / {maxLength}
        </span>
      </div>
    </div>
  )
}

interface ExamplePostsProps {
  id: string
  values: string[]
  onChange: (values: string[]) => void
  max: number
  maxLength: number
  error?: string
  disabled?: boolean
}

/** Example posts: each is its own editable textarea that can be removed. */
export function ExamplePostsField({ id, values, onChange, max, maxLength, error, disabled }: ExamplePostsProps) {
  return (
    <FieldGroup
      id={id}
      label="Example posts"
      hint="Real or sample posts that show this account’s voice. Used as a style reference, never copied."
      error={error}
    >
      {values.length === 0 && <p className="text-sm text-slate-500">No example posts yet.</p>}
      <ol className="space-y-3">
        {values.map((value, index) => (
          <li key={index} className="space-y-1">
            <div className="flex items-center justify-between">
              <label htmlFor={`${id}-${index}`} className="text-xs font-medium text-slate-600">
                Example {index + 1}
              </label>
              <button
                type="button"
                onClick={() => onChange(values.filter((_, i) => i !== index))}
                disabled={disabled}
                aria-label={`Remove example ${index + 1}`}
                className="text-xs font-medium text-red-600 hover:text-red-500"
              >
                Remove
              </button>
            </div>
            <textarea
              id={`${id}-${index}`}
              rows={3}
              value={value}
              onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
              disabled={disabled}
              className={`${inputClass(value.trim().length > maxLength)} resize-y`}
            />
            <p className={`text-right text-xs ${value.trim().length > maxLength ? 'font-medium text-red-600' : 'text-slate-400'}`}>
              {value.trim().length} / {maxLength}
            </p>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        disabled={disabled || values.length >= max}
        className={smallButton}
      >
        + Add example post
      </button>
      <p className="text-xs text-slate-400">
        {values.length} of {max}
      </p>
    </FieldGroup>
  )
}

interface NumberFieldProps {
  id: string
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  min: number
  max: number
  error?: string
  disabled?: boolean
}

/** A whole-number input; the value stays as typed so the form can report bad input. */
export function NumberField({ id, label, hint, value, onChange, min, max, error, disabled }: NumberFieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <p id={`${id}-hint`} className="-mt-0.5 text-xs text-slate-500">
        {hint}
      </p>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : `${id}-hint`}
        className={`${inputClass(!!error)} max-w-32`}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

export function ConfiguredBadge({ configured }: { configured: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${
        configured ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-amber-50 text-amber-800 ring-amber-600/20'
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${configured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {configured ? 'Configured' : 'Not configured'}
    </span>
  )
}
