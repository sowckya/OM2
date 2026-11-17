import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import {
  MAX_X_ACCOUNTS_PER_OMKAR,
  OMKARS_PAGE_SIZE,
  OMKAR_TARGET,
  describeOmkarError,
  listOmkars,
  omkarName,
  type Omkar,
  type OmkarXAccount,
} from '../../api/omkars'
import type { Page } from '../../api/xAccounts'
import { assignXAccount, describeXAccountError, fieldErrorsFrom } from '../../api/xAccounts'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { PersonIcon } from '../icons'
import { AssignAccountDialog } from './AssignAccountDialog'
import { OmkarFormDialog } from './OmkarFormDialog'

type ActiveFilter = '' | 'active' | 'inactive'
type DialogState = { kind: 'create' } | { kind: 'edit'; omkar: Omkar } | { kind: 'assign'; omkar: Omkar } | null

const ACTIVE_FILTERS: { value: ActiveFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
]

const SEARCH_DEBOUNCE_MS = 300

const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600'
const secondaryButton =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50'

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        active ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-slate-100 text-slate-600 ring-slate-500/20'
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
      {active ? 'Active' : 'Inactive'}
    </span>
  )
}

interface AccountCellProps {
  omkar: Omkar
  pendingAccountId: number | null
  onAssign: () => void
  onUnassign: (account: OmkarXAccount) => void
}

/** Assigned X accounts with unassign buttons, plus the assign action. */
function AccountAssignments({ omkar, pendingAccountId, onAssign, onUnassign }: AccountCellProps) {
  const full = omkar.x_accounts.length >= MAX_X_ACCOUNTS_PER_OMKAR
  const reason = !omkar.is_active ? 'Inactive Omkars can’t receive accounts' : full ? 'Already has 2 X accounts' : undefined
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {omkar.x_accounts.map((account) => (
        <span
          key={account.id}
          className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-0.5 pr-1 pl-2.5 text-xs font-medium text-indigo-700 ring-1 ring-indigo-600/15 ring-inset"
        >
          @{account.handle}
          <button
            type="button"
            onClick={() => onUnassign(account)}
            disabled={pendingAccountId !== null}
            aria-label={`Unassign @${account.handle} from ${omkar.username}`}
            className="flex h-4 w-4 items-center justify-center rounded-full text-indigo-500 hover:bg-indigo-100 hover:text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:opacity-50"
          >
            {pendingAccountId === account.id ? <Spinner className="h-3 w-3" /> : <span aria-hidden="true">×</span>}
          </button>
        </span>
      ))}
      {omkar.x_accounts.length === 0 && <span className="text-xs text-slate-400">No accounts</span>}
      <button
        type="button"
        onClick={onAssign}
        disabled={!!reason || pendingAccountId !== null}
        title={reason}
        aria-label={`Assign X account to ${omkar.username}`}
        className="rounded-full px-2 py-0.5 text-xs font-medium text-indigo-600 ring-1 ring-indigo-200 ring-inset hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:text-slate-400 disabled:ring-slate-200 disabled:hover:bg-transparent"
      >
        + Assign
      </button>
    </div>
  )
}

export function OmkarsPage() {
  const { clearUser } = useAuth()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('')
  const [page, setPage] = useState(1)
  const [reloadKey, setReloadKey] = useState(0)

  const [data, setData] = useState<Page<Omkar> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)

  const [dialog, setDialog] = useState<DialogState>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingAccountId, setPendingAccountId] = useState<number | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const requestId = useRef(0)

  const filtered = search !== '' || activeFilter !== ''

  useEffect(() => {
    const term = searchInput.trim()
    if (term === search) return
    const timer = setTimeout(() => {
      setSearch(term)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, search])

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    listOmkars({ search, isActive: activeFilter === '' ? undefined : activeFilter === 'active', page })
      .then((result) => {
        if (id !== requestId.current) return
        setData(result)
        if (!search && !activeFilter) setTotal(result.count)
      })
      .catch((err) => {
        if (id !== requestId.current) return
        if (err instanceof ApiError && err.status === 401) return clearUser()
        if (err instanceof ApiError && err.status === 404 && page > 1) return setPage(1)
        setError(describeOmkarError(err))
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [search, activeFilter, page, reloadKey, clearUser])

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 5000)
    return () => clearTimeout(timer)
  }, [success])

  function reload(message: string) {
    setSuccess(message)
    setActionError(null)
    setReloadKey((key) => key + 1)
    if (filtered) {
      listOmkars({ pageSize: 1 })
        .then((result) => setTotal(result.count))
        .catch(() => {})
    }
  }

  function applySearchNow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSearch(searchInput.trim())
    setPage(1)
  }

  function chooseFilter(value: ActiveFilter) {
    setActiveFilter(value)
    setPage(1)
  }

  function clearFilters() {
    setSearchInput('')
    setSearch('')
    setActiveFilter('')
    setPage(1)
  }

  function openDialog(next: DialogState) {
    setSuccess(null)
    setActionError(null)
    setDialog(next)
  }

  function closeDialog() {
    setDialog(null)
    addButtonRef.current?.focus()
  }

  async function unassign(omkar: Omkar, account: OmkarXAccount) {
    setPendingAccountId(account.id)
    setSuccess(null)
    setActionError(null)
    try {
      await assignXAccount(account.id, null)
      reload(`@${account.handle} was unassigned from ${omkar.username}.`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return clearUser()
      const fields = fieldErrorsFrom(err)
      setActionError(fields?.assigned_omkar_id ?? fields?.form ?? describeXAccountError(err))
    } finally {
      setPendingAccountId(null)
    }
  }

  const omkars = data?.results ?? []
  const count = data?.count ?? 0
  const totalPages = Math.max(1, Math.ceil(count / OMKARS_PAGE_SIZE))
  const firstShown = count === 0 ? 0 : (page - 1) * OMKARS_PAGE_SIZE + 1
  const lastShown = Math.min(page * OMKARS_PAGE_SIZE, count)

  const assignments = (omkar: Omkar) => (
    <AccountAssignments
      omkar={omkar}
      pendingAccountId={pendingAccountId}
      onAssign={() => openDialog({ kind: 'assign', omkar })}
      onUnassign={(account) => unassign(omkar, account)}
    />
  )
  const editButton = (omkar: Omkar, className: string) => (
    <button type="button" onClick={() => openDialog({ kind: 'edit', omkar })} aria-label={`Edit ${omkar.username}`} className={className}>
      Edit
    </button>
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Omkars</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage Omkar logins and assign each Omkar up to two X accounts.
          </p>
        </div>
        <button ref={addButtonRef} type="button" onClick={() => openDialog({ kind: 'create' })} className={primaryButton}>
          <span aria-hidden="true" className="text-base leading-none">+</span>
          Add Omkar
        </button>
      </div>

      <section aria-label="Omkar total" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-slate-500">Total Omkars</p>
          <p className="flex items-baseline gap-1.5">
            <span data-testid="omkar-total" className="text-2xl font-semibold tracking-tight text-slate-900">
              {total ?? '—'}
            </span>
            <span className="text-sm font-medium text-slate-400">of {OMKAR_TARGET} target</span>
          </p>
        </div>
        <div
          role="progressbar"
          aria-label="Omkars towards target"
          aria-valuemin={0}
          aria-valuemax={OMKAR_TARGET}
          aria-valuenow={total ?? 0}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"
        >
          <div
            className="h-full rounded-full bg-indigo-500 transition-all"
            style={{ width: `${Math.min(100, ((total ?? 0) / OMKAR_TARGET) * 100)}%` }}
          />
        </div>
      </section>

      {success && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
          <span>{success}</span>
          <button type="button" onClick={() => setSuccess(null)} className="font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} className="font-medium hover:underline">
            Dismiss
          </button>
        </div>
      )}

      <section aria-label="Omkar list" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
          <form role="search" onSubmit={applySearchNow} className="w-full sm:max-w-xs">
            <label htmlFor="omkar-search" className="sr-only">
              Search Omkars
            </label>
            <input
              id="omkar-search"
              type="search"
              placeholder="Search by name, username or email"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 sm:text-sm"
            />
          </form>
          <div role="group" aria-label="Filter by status" className="inline-flex self-start rounded-lg bg-slate-100 p-1 sm:self-auto">
            {ACTIVE_FILTERS.map(({ value, label }) => (
              <button
                key={label}
                type="button"
                aria-pressed={activeFilter === value}
                onClick={() => chooseFilter(value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-600 ${
                  activeFilter === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div role="alert" className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)} className={secondaryButton}>
              Retry
            </button>
          </div>
        )}

        {loading && data === null ? (
          <p role="status" className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-slate-500">
            <Spinner />
            Loading Omkars…
          </p>
        ) : data && omkars.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <PersonIcon />
            </div>
            {filtered ? (
              <>
                <p className="text-sm font-semibold text-slate-900">No Omkars match your filters</p>
                <p className="mt-1 text-sm text-slate-500">Try a different search or status.</p>
                <button type="button" onClick={clearFilters} className={`${secondaryButton} mt-4`}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-900">No Omkars yet</p>
                <p className="mt-1 max-w-sm text-sm text-slate-500">Add the first Omkar login to start assigning X accounts.</p>
                <button type="button" onClick={() => openDialog({ kind: 'create' })} className={`${primaryButton} mt-4`}>
                  Add Omkar
                </button>
              </>
            )}
          </div>
        ) : data ? (
          <div aria-busy={loading}>
            <table className="hidden w-full text-left text-sm lg:table">
              <thead className="border-b border-slate-100 text-xs font-medium tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-6 py-3">Name</th>
                  <th scope="col" className="px-6 py-3">Username</th>
                  <th scope="col" className="px-6 py-3">Email</th>
                  <th scope="col" className="px-6 py-3">Status</th>
                  <th scope="col" className="px-6 py-3">X accounts</th>
                  <th scope="col" className="px-6 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {omkars.map((omkar) => (
                  <tr key={omkar.id} className="align-top hover:bg-slate-50/60">
                    <td className="px-6 py-3.5 font-medium text-slate-900">{omkarName(omkar)}</td>
                    <td className="px-6 py-3.5 text-slate-700">{omkar.username}</td>
                    <td className="max-w-56 truncate px-6 py-3.5 text-slate-600">{omkar.email || '—'}</td>
                    <td className="px-6 py-3.5">
                      <ActiveBadge active={omkar.is_active} />
                    </td>
                    <td className="px-6 py-3.5">{assignments(omkar)}</td>
                    <td className="px-6 py-3.5 text-right">
                      {editButton(
                        omkar,
                        'rounded-md px-2 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50 hover:text-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-600',
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul aria-label="Omkars" className="divide-y divide-slate-100 lg:hidden">
              {omkars.map((omkar) => (
                <li key={omkar.id} className="space-y-2 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-slate-900">{omkarName(omkar)}</p>
                      <p className="truncate text-sm text-slate-600">
                        {omkar.username}
                        {omkar.email && ` · ${omkar.email}`}
                      </p>
                    </div>
                    {editButton(omkar, secondaryButton)}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ActiveBadge active={omkar.is_active} />
                    {assignments(omkar)}
                  </div>
                </li>
              ))}
            </ul>

            <nav
              aria-label="Pagination"
              className="flex flex-col gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6"
            >
              <p className="flex items-center gap-2">
                {loading && <Spinner />}
                <span>
                  Showing {firstShown}–{lastShown} of {count}
                </span>
              </p>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setPage((p) => p - 1)} disabled={!data.previous || loading} className={secondaryButton}>
                    Previous
                  </button>
                  <span className="px-1">
                    Page {page} of {totalPages}
                  </span>
                  <button type="button" onClick={() => setPage((p) => p + 1)} disabled={!data.next || loading} className={secondaryButton}>
                    Next
                  </button>
                </div>
              )}
            </nav>
          </div>
        ) : null}
      </section>

      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <OmkarFormDialog
          omkar={dialog.kind === 'edit' ? dialog.omkar : undefined}
          onClose={closeDialog}
          onSaved={(omkar, created) => {
            setDialog(null)
            reload(created ? `Omkar ${omkar.username} was added.` : `Omkar ${omkar.username} was updated.`)
            addButtonRef.current?.focus()
          }}
          onSessionExpired={clearUser}
        />
      )}
      {dialog?.kind === 'assign' && (
        <AssignAccountDialog
          omkar={dialog.omkar}
          onClose={closeDialog}
          onAssigned={(account) => {
            setDialog(null)
            reload(`@${account.handle} was assigned to ${dialog.omkar.username}.`)
          }}
          onSessionExpired={clearUser}
        />
      )}
    </div>
  )
}
