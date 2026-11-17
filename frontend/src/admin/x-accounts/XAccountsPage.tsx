import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../../api/client'
import {
  X_ACCOUNTS_PAGE_SIZE,
  X_ACCOUNT_TARGET,
  describeXAccountError,
  listXAccounts,
  type Page,
  type XAccount,
  type XAccountStatus,
} from '../../api/xAccounts'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { ConfiguredBadge } from '../content-dna/ContentDnaFields'
import { AccountsIcon } from '../icons'
import { XAccountFormDialog } from './XAccountFormDialog'

type StatusFilter = '' | XAccountStatus
type DialogState = { mode: 'create' } | { mode: 'edit'; account: XAccount } | null

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PAUSED', label: 'Paused' },
]

const SEARCH_DEBOUNCE_MS = 300

const dateFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Asia/Kolkata',
})

function StatusBadge({ status }: { status: XAccountStatus }) {
  const active = status === 'ACTIVE'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        active ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-amber-50 text-amber-700 ring-amber-600/20'
      }`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {active ? 'Active' : 'Paused'}
    </span>
  )
}

function AssignedOmkarLabel({ account }: { account: XAccount }) {
  const owner = account.assigned_omkar
  if (!owner) return <span className="text-slate-400">Unassigned</span>
  return (
    <span className="text-slate-700">
      {owner.display_name}
      <span className="text-slate-400"> ({owner.username})</span>
      {!owner.is_active && (
        <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">Inactive</span>
      )}
    </span>
  )
}

const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600'
const secondaryButton =
  'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50'

export function XAccountsPage() {
  const { clearUser } = useAuth()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [page, setPage] = useState(1)
  const [reloadKey, setReloadKey] = useState(0)

  const [data, setData] = useState<Page<XAccount> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)

  const [dialog, setDialog] = useState<DialogState>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const requestId = useRef(0)

  const filtered = search !== '' || status !== ''

  // Debounce typing into the search box.
  useEffect(() => {
    const term = searchInput.trim()
    if (term === search) return
    const timer = setTimeout(() => {
      setSearch(term)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, search])

  // Load the current page; stale responses from earlier filters are ignored.
  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    listXAccounts({ search, status: status || undefined, page })
      .then((result) => {
        if (id !== requestId.current) return
        setData(result)
        if (!search && !status) setTotal(result.count)
      })
      .catch((err) => {
        if (id !== requestId.current) return
        if (err instanceof ApiError && err.status === 401) return clearUser()
        // The page vanished (e.g. fewer results after a change): go back to page 1.
        if (err instanceof ApiError && err.status === 404 && page > 1) return setPage(1)
        setError(describeXAccountError(err))
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [search, status, page, reloadKey, clearUser])

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 5000)
    return () => clearTimeout(timer)
  }, [success])

  function applySearchNow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSearch(searchInput.trim())
    setPage(1)
  }

  function chooseStatus(value: StatusFilter) {
    setStatus(value)
    setPage(1)
  }

  function clearFilters() {
    setSearchInput('')
    setSearch('')
    setStatus('')
    setPage(1)
  }

  function openDialog(next: DialogState) {
    setSuccess(null)
    setDialog(next)
  }

  function closeDialog() {
    setDialog(null)
    addButtonRef.current?.focus()
  }

  function handleSaved(account: XAccount, created: boolean) {
    setDialog(null)
    setSuccess(created ? `@${account.handle} was added.` : `@${account.handle} was updated.`)
    setReloadKey((key) => key + 1)
    // The headline total ignores filters; while filtering, the list can't supply it.
    if (filtered) {
      listXAccounts({ pageSize: 1 })
        .then((result) => setTotal(result.count))
        .catch(() => {})
    }
    addButtonRef.current?.focus()
  }

  const accounts = data?.results ?? []
  const count = data?.count ?? 0
  const totalPages = Math.max(1, Math.ceil(count / X_ACCOUNTS_PAGE_SIZE))
  const firstShown = count === 0 ? 0 : (page - 1) * X_ACCOUNTS_PAGE_SIZE + 1
  const lastShown = Math.min(page * X_ACCOUNTS_PAGE_SIZE, count)
  const initialLoad = loading && data === null

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">X Accounts</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage the X accounts in the OM2 network and their Content DNA. Assign accounts to Omkars from the Omkars page.
          </p>
        </div>
        <button ref={addButtonRef} type="button" onClick={() => openDialog({ mode: 'create' })} className={primaryButton}>
          <span aria-hidden="true" className="text-base leading-none">+</span>
          Add X Account
        </button>
      </div>

      <section aria-label="Account total" className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-slate-500">Total X Accounts</p>
          <p className="flex items-baseline gap-1.5">
            <span data-testid="account-total" className="text-2xl font-semibold tracking-tight text-slate-900">
              {total ?? '—'}
            </span>
            <span className="text-sm font-medium text-slate-400">of {X_ACCOUNT_TARGET} target</span>
          </p>
        </div>
        <div
          role="progressbar"
          aria-label="X accounts towards target"
          aria-valuemin={0}
          aria-valuemax={X_ACCOUNT_TARGET}
          aria-valuenow={total ?? 0}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"
        >
          <div
            className="h-full rounded-full bg-indigo-500 transition-all"
            style={{ width: `${Math.min(100, ((total ?? 0) / X_ACCOUNT_TARGET) * 100)}%` }}
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

      <section aria-label="X account list" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
          <form role="search" onSubmit={applySearchNow} className="w-full sm:max-w-xs">
            <label htmlFor="x-account-search" className="sr-only">
              Search accounts
            </label>
            <input
              id="x-account-search"
              type="search"
              placeholder="Search by handle or name"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 sm:text-sm"
            />
          </form>
          <div role="group" aria-label="Filter by status" className="inline-flex self-start rounded-lg bg-slate-100 p-1 sm:self-auto">
            {STATUS_FILTERS.map(({ value, label }) => (
              <button
                key={label}
                type="button"
                aria-pressed={status === value}
                onClick={() => chooseStatus(value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-600 ${
                  status === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
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

        {initialLoad ? (
          <p role="status" className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-slate-500">
            <Spinner />
            Loading X accounts…
          </p>
        ) : data && accounts.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <AccountsIcon />
            </div>
            {filtered ? (
              <>
                <p className="text-sm font-semibold text-slate-900">No accounts match your filters</p>
                <p className="mt-1 text-sm text-slate-500">Try a different search or status.</p>
                <button type="button" onClick={clearFilters} className={`${secondaryButton} mt-4`}>
                  Clear filters
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-900">No X accounts yet</p>
                <p className="mt-1 max-w-sm text-sm text-slate-500">
                  Add the first X account to start building the OM2 network.
                </p>
                <button type="button" onClick={() => openDialog({ mode: 'create' })} className={`${primaryButton} mt-4`}>
                  Add X Account
                </button>
              </>
            )}
          </div>
        ) : data ? (
          <div aria-busy={loading}>
            {/* Desktop table */}
            <table className="hidden w-full text-left text-sm md:table">
              <thead className="border-b border-slate-100 text-xs font-medium tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-6 py-3">Handle</th>
                  <th scope="col" className="px-6 py-3">Display name</th>
                  <th scope="col" className="px-6 py-3">Assigned Omkar</th>
                  <th scope="col" className="px-6 py-3">Status</th>
                  <th scope="col" className="px-6 py-3">Content DNA</th>
                  <th scope="col" className="px-6 py-3">Created</th>
                  <th scope="col" className="px-6 py-3 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {accounts.map((account) => (
                  <tr key={account.id} className="hover:bg-slate-50/60">
                    <td className="px-6 py-3.5 font-medium text-slate-900">@{account.handle}</td>
                    <td className="px-6 py-3.5 text-slate-700">{account.display_name}</td>
                    <td className="px-6 py-3.5">
                      <AssignedOmkarLabel account={account} />
                    </td>
                    <td className="px-6 py-3.5">
                      <StatusBadge status={account.status} />
                    </td>
                    <td className="px-6 py-3.5">
                      <ConfiguredBadge configured={account.content_dna_configured} />
                    </td>
                    <td className="px-6 py-3.5 whitespace-nowrap text-slate-500">
                      {dateFormat.format(new Date(account.created_at))}
                    </td>
                    <td className="px-6 py-3.5 text-right whitespace-nowrap">
                      <Link
                        to={`/admin/x-accounts/${account.id}/content-dna`}
                        aria-label={`Content DNA for @${account.handle}`}
                        className="rounded-md px-2 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50 hover:text-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-600"
                      >
                        Content DNA
                      </Link>
                      <button
                        type="button"
                        onClick={() => openDialog({ mode: 'edit', account })}
                        aria-label={`Edit @${account.handle}`}
                        className="rounded-md px-2 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50 hover:text-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-600"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile list */}
            <ul aria-label="X accounts" className="divide-y divide-slate-100 md:hidden">
              {accounts.map((account) => (
                <li key={account.id} className="flex items-start justify-between gap-3 px-4 py-3.5">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900">@{account.handle}</p>
                    <p className="truncate text-sm text-slate-600">{account.display_name}</p>
                    <p className="mt-0.5 truncate text-xs">
                      <AssignedOmkarLabel account={account} />
                    </p>
                    <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
                      <StatusBadge status={account.status} />
                      <ConfiguredBadge configured={account.content_dna_configured} />
                      <span>Added {dateFormat.format(new Date(account.created_at))}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-stretch gap-2">
                    <button
                      type="button"
                      onClick={() => openDialog({ mode: 'edit', account })}
                      aria-label={`Edit @${account.handle}`}
                      className={secondaryButton}
                    >
                      Edit
                    </button>
                    <Link
                      to={`/admin/x-accounts/${account.id}/content-dna`}
                      aria-label={`Content DNA for @${account.handle}`}
                      className={secondaryButton}
                    >
                      Content DNA
                    </Link>
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
                  <button
                    type="button"
                    onClick={() => setPage((p) => p - 1)}
                    disabled={!data.previous || loading}
                    className={secondaryButton}
                  >
                    Previous
                  </button>
                  <span className="px-1">
                    Page {page} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!data.next || loading}
                    className={secondaryButton}
                  >
                    Next
                  </button>
                </div>
              )}
            </nav>
          </div>
        ) : null}
      </section>

      {dialog && (
        <XAccountFormDialog
          account={dialog.mode === 'edit' ? dialog.account : undefined}
          onClose={closeDialog}
          onSaved={handleSaved}
          onSessionExpired={clearUser}
        />
      )}
    </div>
  )
}
