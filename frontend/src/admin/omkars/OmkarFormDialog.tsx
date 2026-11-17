import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import {
  createOmkar,
  describeOmkarError,
  omkarFieldErrorsFrom,
  updateOmkar,
  type Omkar,
  type OmkarFieldErrors,
} from '../../api/omkars'
import { Spinner } from '../../components/Spinner'

interface OmkarFormDialogProps {
  /** Omkar to edit; omit to add a new one. */
  omkar?: Omkar
  onClose: () => void
  onSaved: (omkar: Omkar, created: boolean) => void
  onSessionExpired: () => void
}

type Field = keyof Omit<OmkarFieldErrors, 'form'>

const inputClass = (invalid: boolean) =>
  `block w-full rounded-lg border px-3 py-2.5 text-base text-slate-900 shadow-sm outline-none transition focus:ring-2 disabled:bg-slate-50 disabled:text-slate-500 sm:text-sm ${
    invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-500/30' : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/30'
  }`

function FormField({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-red-600">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-slate-500">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

export function OmkarFormDialog({ omkar, onClose, onSaved, onSessionExpired }: OmkarFormDialogProps) {
  const editing = omkar !== undefined
  const [values, setValues] = useState({
    username: omkar?.username ?? '',
    first_name: omkar?.first_name ?? '',
    last_name: omkar?.last_name ?? '',
    email: omkar?.email ?? '',
    phone_number: omkar?.phone_number ?? '',
    password: '',
    is_active: omkar?.is_active ?? true,
  })
  const [errors, setErrors] = useState<OmkarFieldErrors>({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const titleId = useId()

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Quick required-field checks; the backend remains the final authority.
    const local: OmkarFieldErrors = {}
    if (!editing && !values.username.trim()) local.username = 'Enter a username.'
    if (!values.first_name.trim()) local.first_name = 'Enter a first name.'
    if (!values.email.trim()) local.email = 'Enter an email address.'
    if (!editing && !values.password) local.password = 'Enter an initial password.'
    setErrors(local)
    if (Object.keys(local).length) return

    setSaving(true)
    const profile = {
      first_name: values.first_name.trim(),
      last_name: values.last_name.trim(),
      email: values.email.trim(),
      phone_number: values.phone_number.trim(),
    }
    try {
      const saved = editing
        ? await updateOmkar(omkar.id, { ...profile, is_active: values.is_active })
        : await createOmkar({ ...profile, username: values.username.trim(), password: values.password })
      onSaved(saved, !editing)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSessionExpired()
        return
      }
      setErrors(omkarFieldErrorsFrom(err) ?? { form: describeOmkarError(err) })
      setSaving(false)
    }
  }

  const describedBy = (field: Field, hasHint = false) =>
    errors[field] ? `omkar-${field}-error` : hasHint ? `omkar-${field}-hint` : undefined
  const invalid = (field: Field) => (errors[field] ? true : undefined)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="fixed inset-0 bg-navy-950/50" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:max-w-lg sm:rounded-2xl"
      >
        <form onSubmit={handleSubmit} noValidate>
          <div className="border-b border-slate-100 px-6 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">
              {editing ? `Edit ${omkar.username}` : 'Add Omkar'}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {editing ? 'Update this Omkar’s profile and access.' : 'Create an Omkar login. Share the initial password with them securely.'}
            </p>
          </div>

          <div className="space-y-5 px-6 py-5">
            {errors.form && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errors.form}
              </div>
            )}

            <FormField
              id="omkar-username"
              label="Username"
              error={errors.username}
              hint={editing ? 'Usernames can’t be changed.' : 'Used to sign in. Letters, numbers and @ . + - _ only.'}
            >
              <input
                ref={editing ? undefined : firstFieldRef}
                id="omkar-username"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={values.username}
                onChange={(e) => set('username', e.target.value)}
                disabled={saving || editing}
                readOnly={editing}
                aria-invalid={invalid('username')}
                aria-describedby={describedBy('username', true)}
                className={inputClass(!!errors.username)}
              />
            </FormField>

            <div className="grid gap-5 sm:grid-cols-2">
              <FormField id="omkar-first_name" label="First name" error={errors.first_name}>
                <input
                  ref={editing ? firstFieldRef : undefined}
                  id="omkar-first_name"
                  type="text"
                  autoComplete="off"
                  value={values.first_name}
                  onChange={(e) => set('first_name', e.target.value)}
                  disabled={saving}
                  aria-invalid={invalid('first_name')}
                  aria-describedby={describedBy('first_name')}
                  className={inputClass(!!errors.first_name)}
                />
              </FormField>
              <FormField id="omkar-last_name" label="Last name (optional)" error={errors.last_name}>
                <input
                  id="omkar-last_name"
                  type="text"
                  autoComplete="off"
                  value={values.last_name}
                  onChange={(e) => set('last_name', e.target.value)}
                  disabled={saving}
                  aria-invalid={invalid('last_name')}
                  aria-describedby={describedBy('last_name')}
                  className={inputClass(!!errors.last_name)}
                />
              </FormField>
            </div>

            <FormField id="omkar-email" label="Email" error={errors.email}>
              <input
                id="omkar-email"
                type="email"
                autoComplete="off"
                value={values.email}
                onChange={(e) => set('email', e.target.value)}
                disabled={saving}
                aria-invalid={invalid('email')}
                aria-describedby={describedBy('email')}
                className={inputClass(!!errors.email)}
              />
            </FormField>

            <FormField
              id="omkar-phone_number"
              label="WhatsApp number (optional)"
              error={errors.phone_number}
              hint="Include the country code, e.g. +91 98765 43210. Used to send approved posts on WhatsApp."
            >
              <input
                id="omkar-phone_number"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={values.phone_number}
                onChange={(e) => set('phone_number', e.target.value)}
                disabled={saving}
                aria-invalid={invalid('phone_number')}
                aria-describedby={describedBy('phone_number', true)}
                className={inputClass(!!errors.phone_number)}
              />
            </FormField>

            {editing ? (
              <FormField id="omkar-is_active" label="Status" error={errors.is_active} hint="Inactive Omkars can’t sign in or receive new X accounts.">
                <select
                  id="omkar-is_active"
                  value={values.is_active ? 'active' : 'inactive'}
                  onChange={(e) => set('is_active', e.target.value === 'active')}
                  disabled={saving}
                  aria-invalid={invalid('is_active')}
                  aria-describedby={describedBy('is_active', true)}
                  className={inputClass(!!errors.is_active)}
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </FormField>
            ) : (
              <FormField
                id="omkar-password"
                label="Initial password"
                error={errors.password}
                hint="At least 8 characters, not too common or similar to their details."
              >
                <input
                  id="omkar-password"
                  type="password"
                  autoComplete="new-password"
                  value={values.password}
                  onChange={(e) => set('password', e.target.value)}
                  disabled={saving}
                  aria-invalid={invalid('password')}
                  aria-describedby={describedBy('password', true)}
                  className={inputClass(!!errors.password)}
                />
              </FormField>
            )}
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-slate-100 bg-slate-50 px-6 py-4 sm:flex-row sm:justify-end sm:rounded-b-2xl">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60"
            >
              {saving && <Spinner />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
