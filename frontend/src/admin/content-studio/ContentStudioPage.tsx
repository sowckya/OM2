import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../../api/client'
import {
  FORMAT_LABELS,
  MAX_ACCOUNTS_PER_REQUEST,
  MAX_OPTIONS,
  describeContentError,
  generateContent,
  getProvider,
  listRuns,
  type ContentItem,
  type GenerateResult,
  type GenerationRun,
  type ProviderInfo,
} from '../../api/content'
import type { ContentFormat } from '../../api/contentDna'
import { listAllXAccounts, type XAccount } from '../../api/xAccounts'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { ContentActions } from '../content/ContentActions'
import { ContentPreview, SourceBadge, StatusPill, WarningIcon, WarningList } from '../content/ContentBits'
import { ContentDetailDialog } from '../content/ContentDetailDialog'
import { ContentEditorDialog } from '../content/ContentEditorDialog'
import { secondaryButton, shortDateTime } from '../content/styles'

const FORMAT_CHOICES: { value: ContentFormat | ''; label: string }[] = [
  { value: '', label: 'Any allowed format' },
  { value: 'TEXT', label: 'Text' },
  { value: 'THREAD', label: 'Thread' },
  { value: 'POLL', label: 'Poll' },
]

/** Underlined brass text action, the default for anything that isn't the page's main action. */
const textAction =
  'font-medium text-ink underline decoration-brass decoration-1 underline-offset-[5px] transition hover:text-brass-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:cursor-not-allowed disabled:text-muted disabled:no-underline'
const field =
  'block w-full rounded-xl border border-line bg-ivory px-3.5 py-2.5 text-base text-ink outline-none transition placeholder:text-muted/80 focus:border-brass focus:ring-2 focus:ring-brass/25 sm:text-sm'
const eyebrow = 'text-xs font-semibold tracking-[0.16em] text-brass-dark uppercase'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function MockNotice() {
  return (
    <div role="note" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
      <WarningIcon className="mt-0.5 h-4 w-4 text-amber-500" />
      <p>
        <span className="font-semibold">Mock provider active — no real AI.</span>{' '}
        <span className="text-amber-800">Drafts are sample text built from each account’s Content DNA and are flagged for rewriting before approval.</span>
      </p>
    </div>
  )
}

function RunSummary({ run }: { run: GenerationRun }) {
  return (
    <p className="text-xs text-muted tabular-nums">
      {run.provider} · {run.model_name} · {run.input_tokens + run.output_tokens} tokens (estimated) · ${Number(run.estimated_cost_usd).toFixed(4)} ·{' '}
      {run.duration_ms} ms
    </p>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={`h-4 w-4 shrink-0 text-muted transition ${open ? '' : '-rotate-90'}`}>
      <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
    </svg>
  )
}

interface AccountRowProps {
  account: XAccount
  checked: boolean
  disabled: boolean
  onToggle: (checked: boolean) => void
}

function AccountRow({ account, checked, disabled, onToggle }: AccountRowProps) {
  const ready = account.content_dna_configured
  return (
    <li className={`flex h-14 items-center gap-3 px-4 transition sm:px-5 ${checked ? 'bg-sand/70' : ready ? 'hover:bg-sand/40' : ''}`}>
      <label className={`flex h-full min-w-0 flex-1 items-center gap-3.5 ${ready ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
        <span className="relative flex h-[22px] w-[22px] shrink-0">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={!ready || disabled}
            className="peer h-[22px] w-[22px] cursor-[inherit] appearance-none rounded-full border border-[#c9c2b4] bg-ivory transition checked:border-ink checked:bg-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:opacity-40"
          />
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2.4} aria-hidden="true" className="pointer-events-none absolute inset-[3px] hidden text-ivory peer-checked:block">
            <path d="M5 10.5l3.2 3L15 6.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className={`min-w-0 flex-1 ${ready ? '' : 'opacity-55'}`}>
          <span className="block truncate text-[15px] leading-5 font-medium text-ink">@{account.handle}</span>
          <span className="block truncate text-[13px] leading-[18px] text-muted">
            {account.display_name}
            {account.status === 'PAUSED' && ' · Paused'}
          </span>
        </span>
        {ready && <span className="shrink-0 text-sm text-[#2f6b4f]">Ready</span>}
      </label>
      {!ready && (
        <Link to={`/admin/x-accounts/${account.id}/content-dna`} aria-label="Set up Content DNA" className={`shrink-0 text-sm ${textAction}`}>
          Set up DNA
        </Link>
      )}
    </li>
  )
}

type AccountView = 'all' | 'ready' | 'missing'

export function ContentStudioPage() {
  const { clearUser } = useAuth()
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [accounts, setAccounts] = useState<XAccount[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [accountSearch, setAccountSearch] = useState('')
  const [accountView, setAccountView] = useState<AccountView>('all')
  const [showOptions, setShowOptions] = useState(false)
  const [collapsed, setCollapsed] = useState<number[]>([])
  const [count, setCount] = useState(3)
  const [format, setFormat] = useState<ContentFormat | ''>('')
  const [instructions, setInstructions] = useState('')
  const [generating, setGenerating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [results, setResults] = useState<GenerateResult[]>([])
  const [runs, setRuns] = useState<GenerationRun[] | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ item?: ContentItem } | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reviewRef = useRef<HTMLElement>(null)

  const fail = useCallback(
    (err: unknown, set: (message: string) => void) => {
      if (err instanceof ApiError && err.status === 401) return clearUser()
      set(describeContentError(err))
    },
    [clearUser],
  )

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    Promise.all([getProvider(), listAllXAccounts()])
      .then(([info, all]) => {
        if (cancelled) return
        setProvider(info)
        setAccounts(all)
      })
      .catch((err) => !cancelled && fail(err, setLoadError))
    return () => {
      cancelled = true
    }
  }, [reloadKey, fail])

  const refreshRuns = useCallback(() => {
    listRuns({ pageSize: 10 })
      .then((page) => setRuns(page.results))
      .catch((err) => fail(err, setActionError))
  }, [fail])

  useEffect(refreshRuns, [refreshRuns])

  useEffect(() => {
    if (!success) return
    const timer = setTimeout(() => setSuccess(null), 5000)
    return () => clearTimeout(timer)
  }, [success])

  useEffect(() => {
    if (results.length) reviewRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [results.length])

  const configured = useMemo(() => (accounts ?? []).filter((a) => a.content_dna_configured), [accounts])
  const shown = useMemo(() => {
    const term = accountSearch.trim().toLowerCase().replace(/^@/, '')
    return (accounts ?? [])
      .filter((a) => accountView === 'all' || a.content_dna_configured === (accountView === 'ready'))
      .filter((a) => !term || a.handle.includes(term) || a.display_name.toLowerCase().includes(term))
  }, [accounts, accountSearch, accountView])
  const totalDrafts = results.reduce((n, r) => n + r.items.length, 0)
  const overLimit = selected.length - MAX_ACCOUNTS_PER_REQUEST
  const allReadySelected = configured.length > 0 && configured.every((a) => selected.includes(a.id))

  function toggle(id: number, checked: boolean) {
    setSelected((s) => (checked ? [...s, id] : s.filter((x) => x !== id)))
    setFormError(null)
  }

  function selectAllReady() {
    // Every account with Content DNA, including rows hidden by the search or filter.
    setSelected(configured.map((a) => a.id))
    setFormError(null)
  }

  async function handleGenerate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected.length) return setFormError('Choose at least one account with Content DNA.')
    if (overLimit > 0) return setFormError(`Choose at most ${MAX_ACCOUNTS_PER_REQUEST} accounts at a time.`)
    setGenerating(true)
    setFormError(null)
    setSuccess(null)
    try {
      const generated = await generateContent({ x_account_ids: selected, count, format, instructions: instructions.trim() })
      setResults(generated)
      setCollapsed([])
      const total = generated.reduce((n, r) => n + r.items.length, 0)
      const failed = generated.filter((r) => r.error).length
      setSuccess(
        `Generated ${plural(total, 'draft')} for ${plural(generated.length - failed, 'account')}.` +
          (failed ? ` ${plural(failed, 'account')} could not be generated; see below.` : ''),
      )
      refreshRuns()
    } catch (err) {
      fail(err, setFormError)
    } finally {
      setGenerating(false)
    }
  }

  function replaceItem(updated: ContentItem, message: string) {
    setResults((rs) => rs.map((r) => ({ ...r, items: r.items.map((i) => (i.id === updated.id ? updated : i)) })))
    setSuccess(message)
    setActionError(null)
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-[860px] space-y-4">
        <h1 className="font-display text-[2rem] leading-tight text-ink">AI Content Studio</h1>
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{loadError}</span>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={secondaryButton}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-10 pb-6">
      <div className="mx-auto w-full max-w-[860px] space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div>
            <p className={eyebrow}>AI Content Studio</p>
            <h1 className="mt-1 font-display text-[1.75rem] leading-tight text-ink sm:text-[2rem]">Create content for your accounts</h1>
            <p className="mt-1 text-sm text-muted sm:text-[15px]">Select accounts and create posts using their Content DNA.</p>
          </div>
          <button type="button" onClick={() => setEditor({})} disabled={!accounts} className={`pb-1 text-sm ${textAction}`}>
            Write manually
          </button>
        </div>

        {provider?.is_mock && <MockNotice />}

        {success && (
          <div role="status" className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">
            <span>{success}</span>
            <Link to="/admin/library" className="font-medium whitespace-nowrap underline-offset-4 hover:underline">
              Open Content Library
            </Link>
          </div>
        )}
        {actionError && (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
            <span>{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} className="font-medium hover:underline">
              Dismiss
            </button>
          </div>
        )}

        <form onSubmit={handleGenerate} noValidate aria-label="Generate content" className="space-y-4">
          <section aria-label="Accounts" className="rounded-3xl border border-line bg-ivory p-3.5 shadow-[0_1px_2px_rgba(25,38,56,0.04),0_8px_24px_-12px_rgba(25,38,56,0.08)] sm:p-5">
            {accounts === null ? (
              <p role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
                <Spinner />
                Loading accounts…
              </p>
            ) : accounts.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted">
                No X accounts yet.{' '}
                <Link to="/admin/x-accounts" className={textAction}>
                  Add one
                </Link>{' '}
                first.
              </p>
            ) : (
              <div className="space-y-3">
                <label htmlFor="studio-account-search" className="sr-only">
                  Filter accounts
                </label>
                <input
                  id="studio-account-search"
                  type="search"
                  placeholder="Search accounts…"
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  className={`${field} rounded-full px-5 py-2.5 sm:text-[15px]`}
                />

                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                  <div role="group" aria-label="Show accounts" className="flex gap-4 text-sm sm:gap-5">
                    {(
                      [
                        ['all', `All ${accounts.length}`],
                        ['ready', `Ready ${configured.length}`],
                        ['missing', `Needs DNA ${accounts.length - configured.length}`],
                      ] as [AccountView, string][]
                    ).map(([view, label]) => (
                      <button
                        key={view}
                        type="button"
                        aria-pressed={accountView === view}
                        onClick={() => setAccountView(view)}
                        className={`border-b-[1.5px] pb-1 font-medium whitespace-nowrap tabular-nums transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass ${
                          accountView === view ? 'border-brass text-ink' : 'border-transparent text-muted hover:text-ink'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button type="button" onClick={selectAllReady} disabled={!configured.length || allReadySelected || generating} className={`text-sm ${textAction}`}>
                    Select all ready
                  </button>
                </div>

                <ul aria-label="Accounts to generate for" className="scrollbar-soft max-h-[min(calc(21rem+2px),max(10.5rem,calc(100dvh-28rem)))] divide-y divide-line overflow-y-auto overscroll-contain rounded-2xl border border-line">
                  {shown.length === 0 && <li className="px-5 py-8 text-center text-sm text-muted">No accounts match.</li>}
                  {shown.map((account) => (
                    <AccountRow
                      key={account.id}
                      account={account}
                      checked={selected.includes(account.id)}
                      disabled={generating}
                      onToggle={(checked) => toggle(account.id, checked)}
                    />
                  ))}
                </ul>

                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 text-sm">
                  <p className="text-muted tabular-nums">
                    <span className={selected.length ? 'font-medium text-ink' : ''}>{selected.length} selected</span>
                    <span> · up to {MAX_ACCOUNTS_PER_REQUEST} per generation</span>
                  </p>
                  <button type="button" onClick={() => setSelected([])} disabled={!selected.length || generating} className={textAction}>
                    Clear selection
                  </button>
                </div>
                {overLimit > 0 && (
                  <p aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
                    <span>
                      Each generation can include up to {MAX_ACCOUNTS_PER_REQUEST} accounts. Remove {overLimit} or keep the first {MAX_ACCOUNTS_PER_REQUEST}.
                    </span>
                    <button type="button" onClick={() => setSelected((s) => s.slice(0, MAX_ACCOUNTS_PER_REQUEST))} className={textAction}>
                      Keep first {MAX_ACCOUNTS_PER_REQUEST}
                    </button>
                  </p>
                )}
              </div>
            )}
          </section>

          <div className="flex flex-col items-center gap-2">
            {formError && (
              <p role="alert" className="text-sm text-red-700">
                {formError}
              </p>
            )}
            <button
              type="submit"
              disabled={generating || accounts === null}
              className="inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-brass px-9 py-3.5 text-base font-semibold text-ink shadow-sm transition hover:bg-brass-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-64"
            >
              {generating && <Spinner />}
              {generating ? 'Generating…' : 'Generate content'}
              {!generating && <span aria-hidden="true">→</span>}
            </button>
            <p className="text-sm text-muted tabular-nums">
              {generating
                ? `Writing drafts for ${plural(selected.length, 'account')}. This can take a little while.`
                : selected.length
                  ? `Up to ${plural(count * selected.length, 'draft')} across ${plural(selected.length, 'account')}`
                  : 'Select accounts to generate'}
            </p>
            <button
              type="button"
              aria-expanded={showOptions}
              aria-controls="studio-options"
              onClick={() => setShowOptions((v) => !v)}
              className={`inline-flex items-center gap-1.5 text-sm ${textAction}`}
            >
              More options
              <Chevron open={showOptions} />
            </button>
          </div>

          {showOptions && (
            <div id="studio-options" className="grid gap-5 rounded-3xl border border-line bg-ivory p-4 sm:grid-cols-2 sm:p-5">
              <fieldset className="min-w-0">
                <legend className="text-sm font-medium text-ink">Options per account</legend>
                <div className="mt-2.5 grid grid-cols-5 rounded-full border border-line bg-cream p-1">
                  {Array.from({ length: MAX_OPTIONS }, (_, i) => i + 1).map((n) => (
                    <label
                      key={n}
                      className={`cursor-pointer rounded-full py-1.5 text-center text-sm font-medium tabular-nums has-focus-visible:outline-2 has-focus-visible:outline-brass ${
                        count === n ? 'bg-ink text-ivory' : 'text-muted hover:text-ink'
                      }`}
                    >
                      <input type="radio" name="option-count" value={n} checked={count === n} onChange={() => setCount(n)} className="sr-only" />
                      {n}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">{count === 1 ? 'One draft per account.' : `${count} different options per account to choose from.`}</p>
              </fieldset>
              <div>
                <label htmlFor="studio-format" className="block text-sm font-medium text-ink">
                  Format
                </label>
                <select id="studio-format" value={format} onChange={(e) => setFormat(e.target.value as ContentFormat | '')} className={`${field} mt-2.5`}>
                  {FORMAT_CHOICES.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="studio-instructions" className="block text-sm font-medium text-ink">
                  Instructions for this batch (optional)
                </label>
                <textarea
                  id="studio-instructions"
                  rows={3}
                  maxLength={1000}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g. Focus on this weekend’s match"
                  className={`${field} mt-2.5 resize-y`}
                />
              </div>
              {provider && !provider.is_mock && (
                <p className="text-xs text-muted sm:col-span-2">
                  Model: {provider.label} ({provider.model_name})
                </p>
              )}
            </div>
          )}
        </form>
      </div>

      {results.length > 0 && (
        <section ref={reviewRef} aria-label="Generated drafts" className="mx-auto w-full max-w-6xl scroll-mt-24 space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
            <div>
              <p className={eyebrow}>Review</p>
              <h2 className="mt-1.5 font-display text-3xl text-ink">
                {plural(totalDrafts, 'draft')} for {plural(results.length, 'account')}
              </h2>
            </div>
            <div className="flex items-center gap-5 text-sm">
              {results.length > 1 && (
                <button type="button" onClick={() => setCollapsed(collapsed.length ? [] : results.map((r) => r.x_account.id))} className={textAction}>
                  {collapsed.length ? 'Expand all' : 'Collapse all'}
                </button>
              )}
              <Link to="/admin/library?status=DRAFT" className={textAction}>
                Open in Library
              </Link>
            </div>
          </div>

          {results.map((result) => {
            const open = !collapsed.includes(result.x_account.id)
            return (
              <article key={result.x_account.id} aria-label={`Drafts for @${result.x_account.handle}`} className="space-y-3">
                <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setCollapsed(open ? [...collapsed, result.x_account.id] : collapsed.filter((id) => id !== result.x_account.id))}
                    className="flex min-w-0 items-center gap-2 rounded-lg py-1 text-left focus-visible:outline-2 focus-visible:outline-brass"
                  >
                    <Chevron open={open} />
                    <h3 className="truncate text-base font-semibold text-ink">@{result.x_account.handle}</h3>
                    <span className="text-sm text-muted tabular-nums">{result.error ? 'Not generated' : plural(result.items.length, 'draft')}</span>
                  </button>
                  {result.run && <RunSummary run={result.run} />}
                </header>
                {open &&
                  (result.error ? (
                    <p role="alert" className="flex flex-wrap items-center gap-x-3 rounded-2xl border border-red-200 bg-red-50/70 px-4 py-3 text-sm text-red-700">
                      {result.error}
                      {!result.run && (
                        <Link to={`/admin/x-accounts/${result.x_account.id}/content-dna`} className={textAction}>
                          Set up Content DNA
                        </Link>
                      )}
                    </p>
                  ) : (
                    <ol className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
                      {result.items.map((item, i) => (
                        <li
                          key={item.id}
                          aria-label={`Option ${i + 1}`}
                          className={`flex flex-col rounded-2xl border bg-ivory transition ${
                            item.status === 'APPROVED' ? 'border-emerald-300' : item.status === 'REJECTED' ? 'border-line opacity-70' : 'border-line hover:border-[#cdbf9f]'
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-4">
                            <span className="mr-1 text-xs font-semibold text-muted tabular-nums">Option {i + 1}</span>
                            <StatusPill status={item.status} />
                            <SourceBadge item={item} />
                            <span className="ml-auto text-[11px] font-medium tracking-wide text-muted uppercase">
                              {FORMAT_LABELS[item.format]}
                              {item.theme && ` · ${item.theme}`}
                            </span>
                          </div>
                          <div className="flex-1 px-4 py-3.5">
                            <ContentPreview item={item} />
                          </div>
                          {item.warnings.length > 0 && (
                            <div className="px-4 pb-3.5">
                              <WarningList item={item} />
                            </div>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
                            <ContentActions item={item} onChanged={replaceItem} onEdit={() => setEditor({ item })} onError={setActionError} size="sm" />
                            <button type="button" onClick={() => setDetailId(item.id)} className={`text-xs ${textAction}`}>
                              History
                            </button>
                          </div>
                        </li>
                      ))}
                    </ol>
                  ))}
              </article>
            )
          })}
        </section>
      )}

      <section aria-label="Generation history" className="mx-auto w-full max-w-[860px]">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h2 className="text-sm font-semibold text-ink">Recent generations</h2>
          <Link to="/admin/library?source=AI" className={`text-sm ${textAction}`}>
            View in Library
          </Link>
        </div>
        {runs === null ? (
          <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted">
            <Spinner />
            Loading history…
          </p>
        ) : runs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No generations yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {runs.map((run) => (
              <li key={run.id} className="grid gap-x-4 gap-y-0.5 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-ink">@{run.x_account.handle}</span>
                    <span className="text-xs text-muted tabular-nums">
                      {run.item_count} of {plural(run.requested_count, 'option')}
                      {run.requested_format && ` · ${FORMAT_LABELS[run.requested_format]}`}
                    </span>
                    {run.is_mock && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Mock</span>}
                    {run.status === 'FAILED' && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">Failed</span>}
                  </p>
                  {run.error && <p className="text-xs text-red-700">{run.error}</p>}
                  <RunSummary run={run} />
                </div>
                <p className="text-xs text-muted sm:text-right">
                  {shortDateTime.format(new Date(run.created_at))}
                  {run.requested_by && <span className="block">{run.requested_by.display_name}</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editor && (
        <ContentEditorDialog
          item={editor.item}
          accounts={accounts ?? []}
          defaultAccountId={selected.length === 1 ? selected[0] : undefined}
          onClose={() => setEditor(null)}
          onSaved={(saved, created) => {
            setEditor(null)
            if (created) setSuccess(`Draft for @${saved.x_account.handle} saved to the Content Library.`)
            else replaceItem(saved, `Post for @${saved.x_account.handle} saved.`)
          }}
        />
      )}
      {detailId !== null && <ContentDetailDialog itemId={detailId} onClose={() => setDetailId(null)} onChanged={replaceItem} />}
    </div>
  )
}
