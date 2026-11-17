import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ApiError } from '../../api/client'
import {
  CONTENT_PAGE_SIZE,
  FORMAT_LABELS,
  SOURCE_LABELS,
  bulkApprove,
  contentText,
  describeContentError,
  listContent,
  needsAcknowledgement,
  type ContentItem,
  type ContentQuery,
  type ContentSource,
  type ContentStatus,
} from '../../api/content'
import type { ContentFormat } from '../../api/contentDna'
import { listXAccounts, type Page, type XAccount } from '../../api/xAccounts'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { ContentActions, SendToWhatsApp } from '../content/ContentActions'
import { SkeletonRows, SourceBadge, StatusPill, WarningList } from '../content/ContentBits'
import { ContentDetailDialog } from '../content/ContentDetailDialog'
import { ContentEditorDialog } from '../content/ContentEditorDialog'
import { Modal } from '../content/Modal'
import { inputClass, primaryButton, secondaryButton, shortDateTime } from '../content/styles'
import { LibraryIcon } from '../icons'

const STATUS_FILTERS: { value: ContentStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'DRAFT', label: 'Drafts' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
]

const SEARCH_DEBOUNCE_MS = 300

type Filters = Required<Pick<ContentQuery, 'search' | 'createdAfter' | 'createdBefore'>> & {
  xAccount: number | ''
  status: ContentStatus | ''
  source: ContentSource | ''
  format: ContentFormat | ''
  flagged: boolean
}

const NO_FILTERS: Filters = { search: '', xAccount: '', status: '', source: '', format: '', flagged: false, createdAfter: '', createdBefore: '' }

const excerpt = (item: ContentItem) => contentText(item).replace(/\s+/g, ' ')

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | '' =>
  allowed.includes((value ?? '').toUpperCase() as T) ? ((value ?? '').toUpperCase() as T) : ''

/** Starting filters from the URL, e.g. /admin/library?source=AI&status=DRAFT. */
function filtersFromUrl(params: URLSearchParams): Filters {
  const account = Number(params.get('x_account'))
  return {
    ...NO_FILTERS,
    status: pick(params.get('status'), ['DRAFT', 'APPROVED', 'REJECTED'] as const),
    source: pick(params.get('source'), ['AI', 'MANUAL'] as const),
    format: pick(params.get('post_format'), ['TEXT', 'THREAD', 'POLL'] as const),
    xAccount: Number.isInteger(account) && account > 0 ? account : '',
    flagged: params.get('flagged') === 'true',
  }
}

const selectClass = `${inputClass()} py-1.5`

export function ContentLibraryPage() {
  const { clearUser } = useAuth()
  const [searchParams] = useSearchParams()
  const [filters, setFilters] = useState<Filters>(() => filtersFromUrl(searchParams))
  const [showFilters, setShowFilters] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(1)
  const [reloadKey, setReloadKey] = useState(0)
  const [data, setData] = useState<Page<ContentItem> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<XAccount[]>([])
  const [selected, setSelected] = useState<number[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [confirmBulk, setConfirmBulk] = useState<number | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [writing, setWriting] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestId = useRef(0)

  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)
  const advancedCount = [filters.xAccount, filters.source, filters.format, filters.createdAfter, filters.createdBefore, filters.flagged].filter(Boolean).length

  const handleError = useCallback(
    (err: unknown, set: (message: string) => void) => {
      if (err instanceof ApiError && err.status === 401) return clearUser()
      set(describeContentError(err))
    },
    [clearUser],
  )

  useEffect(() => {
    listXAccounts({ pageSize: 100 })
      .then((result) => setAccounts(result.results))
      .catch(() => {}) // The account filter is optional; the list itself reports errors.
  }, [])

  useEffect(() => {
    const term = searchInput.trim()
    if (term === filters.search) return
    const timer = setTimeout(() => {
      setFilters((f) => ({ ...f, search: term }))
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput, filters.search])

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(null)
    listContent({
      search: filters.search,
      xAccount: filters.xAccount || undefined,
      status: filters.status || undefined,
      source: filters.source || undefined,
      format: filters.format || undefined,
      flagged: filters.flagged,
      createdAfter: filters.createdAfter,
      createdBefore: filters.createdBefore,
      page,
    })
      .then((result) => {
        if (id !== requestId.current) return
        setData(result)
        setSelected((s) => s.filter((x) => result.results.some((i) => i.id === x && i.status === 'DRAFT')))
      })
      .catch((err) => {
        if (id !== requestId.current) return
        if (err instanceof ApiError && err.status === 404 && page > 1) return setPage(1)
        handleError(err, setError)
      })
      .finally(() => id === requestId.current && setLoading(false))
  }, [filters, page, reloadKey, handleError])

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 5000)
    return () => clearTimeout(timer)
  }, [success])

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  function clearFilters() {
    setSearchInput('')
    setFilters(NO_FILTERS)
    setPage(1)
  }

  function refresh(message: string) {
    setSuccess(message)
    setActionError(null)
    setReloadKey((k) => k + 1)
  }

  async function approveSelected(acknowledge: boolean) {
    setBulkBusy(true)
    setActionError(null)
    try {
      const approved = await bulkApprove(selected, acknowledge)
      setConfirmBulk(null)
      setSelected([])
      refresh(`${approved.length} post${approved.length === 1 ? '' : 's'} approved.`)
    } catch (err) {
      if (needsAcknowledgement(err)) {
        const flagged = ((err as ApiError).data as { flagged?: unknown[] }).flagged?.length ?? 0
        setConfirmBulk(flagged)
      } else {
        setConfirmBulk(null)
        handleError(err, setActionError)
      }
    } finally {
      setBulkBusy(false)
    }
  }

  const items = data?.results ?? []
  const count = data?.count ?? 0
  const totalPages = Math.max(1, Math.ceil(count / CONTENT_PAGE_SIZE))
  const drafts = items.filter((i) => i.status === 'DRAFT')
  const allSelected = drafts.length > 0 && drafts.every((i) => selected.includes(i.id))

  const selectBox = (item: ContentItem) => (
    <input
      type="checkbox"
      aria-label={`Select post ${item.id} for @${item.x_account.handle}`}
      checked={selected.includes(item.id)}
      disabled={item.status !== 'DRAFT'}
      title={item.status !== 'DRAFT' ? 'Only drafts can be approved' : undefined}
      onChange={(e) => setSelected((s) => (e.target.checked ? [...s, item.id] : s.filter((x) => x !== item.id)))}
      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
    />
  )
  const rowActions = (item: ContentItem) =>
    item.status === 'DRAFT' ? (
      <ContentActions item={item} onChanged={(_, message) => refresh(message)} onError={setActionError} size="sm" />
    ) : item.status === 'APPROVED' && item.whatsapp ? (
      <SendToWhatsApp item={item} size="sm" />
    ) : null
  const viewButton = (item: ContentItem) => (
    <button
      type="button"
      onClick={() => setDetailId(item.id)}
      aria-label={`View post ${item.id} for @${item.x_account.handle}`}
      className="rounded-md px-2 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 hover:text-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-600"
    >
      View
    </button>
  )

  return (
    <div className={`space-y-6 ${selected.length ? 'pb-20' : ''}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Content Library</h1>
          <p className="mt-1 text-sm text-slate-500">Every generated and written post, with review status and full history.</p>
        </div>
        <button type="button" onClick={() => setWriting(true)} className={primaryButton}>
          Write a post
        </button>
      </div>

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

      <section aria-label="Content list" className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="space-y-3 border-b border-slate-100 p-3 sm:p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div role="search" className="min-w-0 flex-1">
              <label htmlFor="library-search" className="sr-only">
                Search posts
              </label>
              <input
                id="library-search"
                type="search"
                placeholder="Search text, theme or @handle"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className={selectClass}
              />
            </div>
            <div className="flex items-center gap-2">
              <div role="group" aria-label="Filter by status" className="inline-flex rounded-lg bg-slate-100 p-0.5">
                {STATUS_FILTERS.map(({ value, label }) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={filters.status === value}
                    onClick={() => setFilter('status', value)}
                    className={`rounded-md px-2.5 py-1.5 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-indigo-600 ${
                      filters.status === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-expanded={showFilters}
                aria-controls="library-filters"
                aria-label={advancedCount ? `Filters, ${advancedCount} active` : 'Filters'}
                onClick={() => setShowFilters((v) => !v)}
                className={`${secondaryButton} lg:hidden`}
              >
                Filters
                {advancedCount > 0 && (
                  <span className="rounded-full bg-indigo-600 px-1.5 text-[11px] font-semibold text-white tabular-nums">{advancedCount}</span>
                )}
              </button>
            </div>
          </div>

          {/* Always rendered; collapsed behind the Filters button on small screens. */}
          <div id="library-filters" className={`${showFilters ? 'grid' : 'hidden'} gap-2 sm:grid-cols-2 lg:grid lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto] lg:items-end`}>
            <label className="text-xs font-medium text-slate-600">
              Account
              <select value={filters.xAccount} onChange={(e) => setFilter('xAccount', e.target.value ? Number(e.target.value) : '')} className={`${selectClass} mt-1`}>
                <option value="">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.handle}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Source
              <select value={filters.source} onChange={(e) => setFilter('source', e.target.value as ContentSource | '')} className={`${selectClass} mt-1`}>
                <option value="">All sources</option>
                {(Object.keys(SOURCE_LABELS) as ContentSource[]).map((source) => (
                  <option key={source} value={source}>
                    {SOURCE_LABELS[source]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Format
              <select value={filters.format} onChange={(e) => setFilter('format', e.target.value as ContentFormat | '')} className={`${selectClass} mt-1`}>
                <option value="">All formats</option>
                {(Object.keys(FORMAT_LABELS) as ContentFormat[]).map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Created from
              <input type="date" value={filters.createdAfter} onChange={(e) => setFilter('createdAfter', e.target.value)} className={`${selectClass} mt-1`} />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Created to
              <input type="date" value={filters.createdBefore} onChange={(e) => setFilter('createdBefore', e.target.value)} className={`${selectClass} mt-1`} />
            </label>
            <label className="flex items-center gap-2 py-2 text-sm whitespace-nowrap text-slate-600">
              <input
                type="checkbox"
                checked={filters.flagged}
                onChange={(e) => setFilter('flagged', e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              Only posts with warnings
            </label>
          </div>

          {filtered && (
            <div className="flex flex-wrap items-center gap-1.5">
              {activeChips(filters, accounts).map(({ key, label }) => (
                <span key={key} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 py-0.5 pr-1 pl-2.5 text-xs font-medium text-indigo-800 ring-1 ring-indigo-600/15 ring-inset">
                  {label}
                  <button
                    type="button"
                    aria-label={`Remove filter: ${label}`}
                    onClick={() => {
                      if (key === 'search') setSearchInput('')
                      setFilter(key, NO_FILTERS[key])
                    }}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-indigo-500 hover:bg-indigo-100 hover:text-indigo-700"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </span>
              ))}
              <button type="button" onClick={clearFilters} className="ml-1 text-xs font-medium text-slate-500 hover:text-slate-700">
                Clear filters
              </button>
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={secondaryButton}>
              Retry
            </button>
          </div>
        )}

        {loading && data === null ? (
          !error && <SkeletonRows rows={6} label="Loading content…" />
        ) : data && items.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <LibraryIcon />
            </div>
            <p className="text-sm font-semibold text-slate-900">{filtered ? 'No posts match your filters' : 'No content yet'}</p>
            <p className="mt-1 max-w-sm text-sm text-slate-500">
              {filtered ? 'Try different filters, or clear them to see everything.' : 'Generate drafts in AI Content Studio or write a post here.'}
            </p>
            {filtered && (
              <button type="button" onClick={clearFilters} className={`${secondaryButton} mt-4`}>
                Clear filters
              </button>
            )}
          </div>
        ) : data ? (
          <div aria-busy={loading} className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
            <table className="hidden w-full table-fixed text-left text-sm lg:table">
              <colgroup>
                <col className="w-11" />
                <col />
                <col className="w-40" />
                <col className="w-28" />
                <col className="w-28" />
                <col className="w-36" />
                <col className="w-52" />
              </colgroup>
              <thead className="border-b border-slate-100 bg-slate-50/60 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="Select all drafts on this page"
                      checked={allSelected}
                      disabled={drafts.length === 0}
                      onChange={(e) => setSelected(e.target.checked ? drafts.map((i) => i.id) : [])}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-40"
                    />
                  </th>
                  <th scope="col" className="px-3 py-2.5">Post</th>
                  <th scope="col" className="px-3 py-2.5">Account</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                  <th scope="col" className="px-3 py-2.5">Source</th>
                  <th scope="col" className="px-3 py-2.5">Created</th>
                  <th scope="col" className="px-4 py-2.5 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr key={item.id} className={`align-top transition hover:bg-slate-50/70 ${selected.includes(item.id) ? 'bg-indigo-50/40' : ''}`}>
                    <td className="px-4 py-3">{selectBox(item)}</td>
                    <td className="px-3 py-3">
                      <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                        {FORMAT_LABELS[item.format]}
                        {item.theme && ` · ${item.theme}`}
                      </p>
                      <p className="mt-0.5 line-clamp-2 leading-snug text-slate-800">{excerpt(item)}</p>
                      <WarningList item={item} compact />
                    </td>
                    <td className="truncate px-3 py-3 font-medium text-slate-700">@{item.x_account.handle}</td>
                    <td className="px-3 py-3">
                      <StatusPill status={item.status} />
                    </td>
                    <td className="px-3 py-3">
                      <SourceBadge item={item} />
                    </td>
                    <td className="px-3 py-3 text-xs whitespace-nowrap text-slate-500 tabular-nums">{shortDateTime.format(new Date(item.created_at))}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        {rowActions(item)}
                        {viewButton(item)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul aria-label="Posts" className="divide-y divide-slate-100 lg:hidden">
              {items.map((item) => (
                <li key={item.id} className={`flex gap-3 px-4 py-3 ${selected.includes(item.id) ? 'bg-indigo-50/40' : ''}`}>
                  <div className="pt-0.5">{selectBox(item)}</div>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-0.5 text-sm font-medium text-slate-900">@{item.x_account.handle}</span>
                      <StatusPill status={item.status} />
                      <SourceBadge item={item} />
                    </div>
                    <p className="line-clamp-3 text-sm leading-snug text-slate-700">{excerpt(item)}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                      <span>
                        {FORMAT_LABELS[item.format]} · {shortDateTime.format(new Date(item.created_at))}
                      </span>
                      <WarningList item={item} compact />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {rowActions(item)}
                      {viewButton(item)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <nav aria-label="Pagination" className="flex flex-col gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 tabular-nums">
                {loading && <Spinner />}
                <span>
                  Showing {(page - 1) * CONTENT_PAGE_SIZE + 1}–{Math.min(page * CONTENT_PAGE_SIZE, count)} of {count}
                </span>
              </p>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setPage((p) => p - 1)} disabled={!data.previous || loading} className={secondaryButton}>
                    Previous
                  </button>
                  <span className="px-1 tabular-nums">
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

      {selected.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 lg:left-60">
          <div
            role="region"
            aria-label="Bulk actions"
            className="pointer-events-auto flex items-center gap-3 rounded-full border border-slate-200 bg-white/95 py-1.5 pr-1.5 pl-4 text-sm shadow-lg backdrop-blur"
          >
            <span className="font-medium text-slate-900 tabular-nums">{selected.length} selected</span>
            <button type="button" onClick={() => setSelected([])} className="text-sm font-medium text-slate-500 hover:text-slate-700">
              Clear
            </button>
            <button type="button" onClick={() => approveSelected(false)} disabled={bulkBusy} className={`${primaryButton} rounded-full py-1.5`}>
              {bulkBusy && <Spinner />}
              Approve selected
            </button>
          </div>
        </div>
      )}

      {confirmBulk !== null && (
        <Modal
          role="alertdialog"
          title="Approve posts with warnings?"
          description={`${confirmBulk} of the ${selected.length} selected posts have warnings (for example mock text, duplicates or avoided topics). Open them to review, or approve all anyway.`}
          onClose={() => setConfirmBulk(null)}
          busy={bulkBusy}
          footer={
            <>
              <button type="button" onClick={() => setConfirmBulk(null)} disabled={bulkBusy} className={secondaryButton}>
                Cancel
              </button>
              <button type="button" onClick={() => approveSelected(true)} disabled={bulkBusy} className={primaryButton}>
                {bulkBusy && <Spinner />}
                Approve all anyway
              </button>
            </>
          }
        />
      )}
      {detailId !== null && (
        <ContentDetailDialog itemId={detailId} onClose={() => setDetailId(null)} onChanged={(_, message) => refresh(message)} />
      )}
      {writing && (
        <ContentEditorDialog
          accounts={accounts}
          onClose={() => setWriting(false)}
          onSaved={(saved) => {
            setWriting(false)
            refresh(`Draft for @${saved.x_account.handle} saved.`)
          }}
        />
      )}
    </div>
  )
}

type ChipKey = Exclude<keyof Filters, 'status'>

/** Labels for the active filters other than status (which has its own tabs). */
function activeChips(filters: Filters, accounts: XAccount[]): { key: ChipKey; label: string }[] {
  const chips: { key: ChipKey; label: string }[] = []
  if (filters.search) chips.push({ key: 'search', label: `“${filters.search}”` })
  if (filters.xAccount) {
    const handle = accounts.find((a) => a.id === filters.xAccount)?.handle
    chips.push({ key: 'xAccount', label: handle ? `@${handle}` : `Account ${filters.xAccount}` })
  }
  if (filters.source) chips.push({ key: 'source', label: SOURCE_LABELS[filters.source] })
  if (filters.format) chips.push({ key: 'format', label: FORMAT_LABELS[filters.format] })
  if (filters.createdAfter) chips.push({ key: 'createdAfter', label: `From ${filters.createdAfter}` })
  if (filters.createdBefore) chips.push({ key: 'createdBefore', label: `To ${filters.createdBefore}` })
  if (filters.flagged) chips.push({ key: 'flagged', label: 'With warnings' })
  return chips
}
