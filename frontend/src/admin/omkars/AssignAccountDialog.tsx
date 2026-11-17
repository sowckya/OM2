import { useEffect, useId, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { omkarName, type Omkar } from '../../api/omkars'
import {
  assignXAccount,
  describeXAccountError,
  fieldErrorsFrom,
  listXAccounts,
  type XAccount,
} from '../../api/xAccounts'
import { Spinner } from '../../components/Spinner'

interface AssignAccountDialogProps {
  omkar: Omkar
  onClose: () => void
  onAssigned: (account: XAccount) => void
  onSessionExpired: () => void
}

export function AssignAccountDialog({ omkar, onClose, onAssigned, onSessionExpired }: AssignAccountDialogProps) {
  const [search, setSearch] = useState('')
  const [includeAssigned, setIncludeAssigned] = useState(false)
  const [accounts, setAccounts] = useState<XAccount[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      setLoadError(null)
      // The network targets 100 accounts, so one page of up to 100 covers it.
      listXAccounts({ search: search.trim(), assigned: includeAssigned ? undefined : false, pageSize: 100 })
        .then((page) => {
          if (cancelled) return
          setAccounts(page.results.filter((a) => a.assigned_omkar?.id !== omkar.id))
        })
        .catch((err) => {
          if (cancelled) return
          if (err instanceof ApiError && err.status === 401) return onSessionExpired()
          setLoadError(describeXAccountError(err))
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, includeAssigned, omkar.id, onSessionExpired])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (selectedId === null) {
      setError('Choose an X account to assign.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      onAssigned(await assignXAccount(selectedId, omkar.id))
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSessionExpired()
      const fields = fieldErrorsFrom(err)
      setError(fields?.assigned_omkar_id ?? fields?.form ?? describeXAccountError(err))
      setSaving(false)
    }
  }

  const selected = accounts?.find((a) => a.id === selectedId)
  const name = omkarName(omkar)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="fixed inset-0 bg-navy-950/50" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[90vh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:max-w-lg sm:rounded-2xl"
      >
        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-slate-100 px-6 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-slate-900">
              Assign X account to {name}
            </h2>
            <p className="mt-0.5 text-sm text-slate-500">
              {omkar.x_accounts.length} of 2 accounts assigned. Each X account has one Omkar.
            </p>
          </div>

          <div className="space-y-3 border-b border-slate-100 px-6 py-4">
            {error && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
            <label htmlFor="assign-search" className="sr-only">
              Search X accounts
            </label>
            <input
              id="assign-search"
              type="search"
              placeholder="Search by handle or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 sm:text-sm"
            />
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={includeAssigned}
                onChange={(e) => {
                  setIncludeAssigned(e.target.checked)
                  setSelectedId(null)
                }}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              Include accounts assigned to other Omkars (reassign)
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {loadError ? (
              <p role="alert" className="px-4 py-6 text-center text-sm text-red-700">
                {loadError}
              </p>
            ) : accounts === null ? (
              <p role="status" className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-slate-500">
                <Spinner />
                Loading X accounts…
              </p>
            ) : accounts.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-500">
                {includeAssigned ? 'No other X accounts match.' : 'No unassigned X accounts available.'}
              </p>
            ) : (
              <fieldset>
                <legend className="sr-only">X accounts</legend>
                {accounts.map((account) => (
                  <label
                    key={account.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg px-4 py-2.5 hover:bg-slate-50 ${
                      selectedId === account.id ? 'bg-indigo-50/60' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="x-account"
                      value={account.id}
                      checked={selectedId === account.id}
                      onChange={() => setSelectedId(account.id)}
                      className="mt-1 h-4 w-4 border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-900">@{account.handle}</span>
                      <span className="block truncate text-xs text-slate-500">
                        {account.display_name}
                        {account.status === 'PAUSED' && ' · Paused'}
                        {account.assigned_omkar && ` · Assigned to ${account.assigned_omkar.display_name}`}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>

          {selected?.assigned_omkar && (
            <p className="border-t border-slate-100 bg-amber-50 px-6 py-2 text-sm text-amber-800">
              This will move @{selected.handle} from {selected.assigned_omkar.display_name} to {name}.
            </p>
          )}

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
              {saving ? 'Assigning…' : selected?.assigned_omkar ? 'Reassign' : 'Assign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
