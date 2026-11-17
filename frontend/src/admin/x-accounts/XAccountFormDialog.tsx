import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import {
  createXAccount,
  describeXAccountError,
  fieldErrorsFrom,
  updateXAccount,
  type FieldErrors,
  type XAccount,
  type XAccountStatus,
} from '../../api/xAccounts'
import { Spinner } from '../../components/Spinner'

interface XAccountFormDialogProps {
  /** Account to edit; omit to add a new one. */
  account?: XAccount
  onClose: () => void
  onSaved: (account: XAccount, created: boolean) => void
  onSessionExpired: () => void
}

const inputBase =
  'block w-full rounded-lg border px-3 py-2.5 text-base text-slate-900 shadow-sm outline-none transition focus:ring-2 disabled:bg-slate-50 sm:text-sm'
const inputClass = (invalid: boolean) =>
  `${inputBase} ${invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-500/30' : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/30'}`

export function XAccountFormDialog({ account, onClose, onSaved, onSessionExpired }: XAccountFormDialogProps) {
  const editing = account !== undefined
  const [handle, setHandle] = useState(account?.handle ?? '')
  const [displayName, setDisplayName] = useState(account?.display_name ?? '')
  const [status, setStatus] = useState<XAccountStatus>(account?.status ?? 'ACTIVE')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const handleRef = useRef<HTMLInputElement>(null)
  const titleId = useId()

  useEffect(() => {
    handleRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Quick required-field checks; the backend remains the final authority on format and duplicates.
    const local: FieldErrors = {}
    if (!handle.trim().replace(/^@/, '')) local.handle = 'Enter the X handle.'
    if (!displayName.trim()) local.display_name = 'Enter a display name.'
    setErrors(local)
    if (Object.keys(local).length) return

    setSaving(true)
    const input = { handle: handle.trim(), display_name: displayName.trim(), status }
    try {
      const saved = editing ? await updateXAccount(account.id, input) : await createXAccount(input)
      onSaved(saved, !editing)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSessionExpired()
        return
      }
      setErrors(fieldErrorsFrom(err) ?? { form: describeXAccountError(err) })
      setSaving(false)
    }
  }

  const errorId = (field: string) => `x-account-${field}-error`

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="fixed inset-0 bg-navy-950/50" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative max-h-[90vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-xl sm:max-w-md sm:rounded-2xl"
      >
        <form onSubmit={handleSubmit} noValidate>
          <div className="border-b border-slate-100 px-6 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">
              {editing ? `Edit @${account.handle}` : 'Add X Account'}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {editing ? 'Update this account’s details.' : 'Add an X account to the OM2 network.'}
            </p>
          </div>

          <div className="space-y-5 px-6 py-5">
            {errors.form && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {errors.form}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="x-account-handle" className="block text-sm font-medium text-slate-700">
                X handle
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-400">
                  @
                </span>
                <input
                  ref={handleRef}
                  id="x-account-handle"
                  name="handle"
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  disabled={saving}
                  aria-invalid={errors.handle ? true : undefined}
                  aria-describedby={errors.handle ? errorId('handle') : 'x-account-handle-help'}
                  className={`${inputClass(!!errors.handle)} pl-7`}
                />
              </div>
              {errors.handle ? (
                <p id={errorId('handle')} className="text-sm text-red-600">
                  {errors.handle}
                </p>
              ) : (
                <p id="x-account-handle-help" className="text-xs text-slate-500">
                  1–15 letters, numbers or underscores. Saved in lowercase.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="x-account-display-name" className="block text-sm font-medium text-slate-700">
                Display name
              </label>
              <input
                id="x-account-display-name"
                name="display_name"
                type="text"
                required
                maxLength={100}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={saving}
                aria-invalid={errors.display_name ? true : undefined}
                aria-describedby={errors.display_name ? errorId('display_name') : undefined}
                className={inputClass(!!errors.display_name)}
              />
              {errors.display_name && (
                <p id={errorId('display_name')} className="text-sm text-red-600">
                  {errors.display_name}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label htmlFor="x-account-status" className="block text-sm font-medium text-slate-700">
                Status
              </label>
              <select
                id="x-account-status"
                name="status"
                value={status}
                onChange={(e) => setStatus(e.target.value as XAccountStatus)}
                disabled={saving}
                aria-invalid={errors.status ? true : undefined}
                aria-describedby={errors.status ? errorId('status') : undefined}
                className={inputClass(!!errors.status)}
              >
                <option value="ACTIVE">Active</option>
                <option value="PAUSED">Paused</option>
              </select>
              {errors.status && (
                <p id={errorId('status')} className="text-sm text-red-600">
                  {errors.status}
                </p>
              )}
            </div>
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
