import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiError } from '../../api/client'
import { FORMAT_LABELS, contentText } from '../../api/content'
import {
  MAX_POSTS_PER_MESSAGE,
  MESSAGE_STATUS_LABELS,
  describeDistributionError,
  getBatch,
  getCandidates,
  listBatches,
  messageAction,
  prepareBatch,
  type Batch,
  type BatchSummary,
  type CandidateGroup,
  type CandidatePost,
  type Candidates,
  type DistributionMessage,
  type MessageStatus,
} from '../../api/distribution'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { WarningIcon } from '../content/ContentBits'
import { Modal } from '../content/Modal'
import { primaryButton, secondaryButton, shortDateTime } from '../content/styles'
import { GuidedDistribution } from './GuidedDistribution'
import { hasStarted, isActive, nextActiveIndex, resumeIndex } from './guide'

const textAction =
  'font-medium text-ink underline decoration-brass decoration-1 underline-offset-[5px] transition hover:text-brass-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:cursor-not-allowed disabled:text-muted disabled:no-underline'
const eyebrow = 'text-xs font-semibold tracking-[0.16em] text-brass-dark uppercase'
const checkbox =
  'h-[18px] w-[18px] shrink-0 cursor-pointer rounded-full border-[#c9c2b4] accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:cursor-not-allowed disabled:opacity-40'
const panel = 'rounded-3xl border border-line bg-ivory shadow-[0_1px_2px_rgba(25,38,56,0.04),0_8px_24px_-12px_rgba(25,38,56,0.08)]'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const when = (iso: string) => shortDateTime.format(new Date(iso))

type View = 'prepare' | 'queue'
type Confirm = { kind: 'reopen' | 'sent' | 'cancel'; message: DistributionMessage } | null

function selectable(post: CandidatePost, includeSent: boolean) {
  return !post.unavailable_reason && (!post.sent_at || includeSent)
}

function postNote(post: CandidatePost) {
  if (post.unavailable_reason) return post.unavailable_reason
  if (post.sent_at) return `Sent ${when(post.sent_at)}`
  return null
}

const STATUS_STYLES: Record<MessageStatus, string> = {
  PENDING: 'bg-sand text-ink',
  OPENED: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  SENT: 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200',
  CANCELLED: 'bg-transparent text-muted ring-1 ring-line',
}

function StatusBadge({ status }: { status: MessageStatus }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}>{MESSAGE_STATUS_LABELS[status]}</span>
}

interface GroupProps {
  group: CandidateGroup
  selected: Set<number>
  includeSent: boolean
  disabled: boolean
  onChange: (ids: number[], checked: boolean) => void
}

function OmkarGroup({ group, selected, includeSent, disabled, onChange }: GroupProps) {
  const name = group.omkar.display_name
  const eligible = group.posts.filter((p) => selectable(p, includeSent)).map((p) => p.id)
  const chosen = eligible.filter((id) => selected.has(id)).length
  return (
    <li aria-label={name}>
      <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <input
          type="checkbox"
          aria-label={`Select all posts for ${name}`}
          checked={eligible.length > 0 && chosen === eligible.length}
          ref={(el) => {
            if (el) el.indeterminate = chosen > 0 && chosen < eligible.length
          }}
          disabled={!eligible.length || disabled}
          onChange={(e) => onChange(eligible, e.target.checked)}
          className={checkbox}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-ink">{name}</p>
          <p className="truncate text-[13px] text-muted">{group.accounts.map((a) => `@${a.handle}${a.status === 'PAUSED' ? ' (paused)' : ''}`).join(' · ')}</p>
          {group.unavailable_reason && (
            <p className="text-[13px] text-amber-800">
              {group.unavailable_reason}{' '}
              <Link to="/admin/omkars" className={textAction}>
                Update Omkar
              </Link>
            </p>
          )}
        </div>
        <div className="shrink-0 text-right text-[13px]">
          <p className="text-muted tabular-nums">{plural(group.posts.length, 'post')}</p>
          {!group.unavailable_reason && <p className="text-[#2f6b4f]">WhatsApp ready</p>}
        </div>
      </div>
      <ul className="pb-2">
        {group.posts.map((post) => {
          const can = selectable(post, includeSent)
          // The Omkar's own reason is shown once, above.
          const note = group.unavailable_reason ? null : postNote(post)
          return (
            <li key={post.id} className="flex items-start gap-3 px-4 py-2 sm:px-5 sm:pl-12">
              <input
                type="checkbox"
                aria-label={`Select post ${post.id} for @${post.x_account.handle}`}
                checked={selected.has(post.id)}
                disabled={!can || disabled}
                onChange={(e) => onChange([post.id], e.target.checked)}
                className={`${checkbox} mt-0.5`}
              />
              <div className={`min-w-0 flex-1 ${can ? '' : 'opacity-60'}`}>
                <p className="text-xs font-medium text-brass-dark">
                  @{post.x_account.handle}
                  {post.format !== 'TEXT' && <span className="text-muted"> · {FORMAT_LABELS[post.format]}</span>}
                </p>
                <p className="line-clamp-2 text-sm whitespace-pre-line text-ink">{contentText(post)}</p>
              </div>
              {note && <p className="max-w-40 shrink-0 text-right text-xs text-muted">{note}</p>}
            </li>
          )
        })}
      </ul>
    </li>
  )
}

interface MessageRowProps {
  message: DistributionMessage
  busy: boolean
  onOpen: () => void
  onConfirm: (kind: 'sent' | 'cancel') => void
}

function MessageRow({ message, busy, onOpen, onConfirm }: MessageRowProps) {
  const [preview, setPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  const active = message.status === 'PENDING' || message.status === 'OPENED'
  const handles = [...new Set(message.posts.map((p) => `@${p.handle}`))].join(', ')

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setPreview(true)
    }
  }

  return (
    <li aria-label={`Message ${message.position} of ${message.of} for ${message.omkar.display_name}`} className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{message.omkar.display_name}</span>
            <StatusBadge status={message.status} />
          </p>
          <p className="mt-0.5 text-[13px] text-muted tabular-nums">
            {message.of > 1 && `Message ${message.position} of ${message.of} · `}
            {plural(message.posts.length, 'post')} · {handles}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {active && (
            <button type="button" onClick={onOpen} disabled={busy} className={primaryButton}>
              {busy && <Spinner />}
              Open WhatsApp
              <span aria-hidden="true">↗</span>
            </button>
          )}
          {active && (
            <button type="button" onClick={() => onConfirm('sent')} disabled={busy} className={textAction}>
              Mark as sent
            </button>
          )}
          <button type="button" aria-expanded={preview} onClick={() => setPreview((v) => !v)} className={textAction}>
            {preview ? 'Hide message' : 'Preview'}
          </button>
        </div>
      </div>

      {message.warnings.map((w) => (
        <p key={w.code} className="mt-2 flex items-start gap-2 text-[13px] text-amber-800">
          <WarningIcon className="mt-0.5 h-3.5 w-3.5 text-amber-500" />
          {w.message}
        </p>
      ))}
      {(message.opened_at || message.sent_confirmed_at || message.cancelled_at) && (
        <p className="mt-1.5 text-xs text-muted">
          {message.opened_at && `Opened ${message.open_count > 1 ? `${message.open_count}× · last ` : ''}${when(message.opened_at)}`}
          {message.sent_confirmed_at &&
            ` · Marked sent ${when(message.sent_confirmed_at)}${message.sent_confirmed_by ? ` by ${message.sent_confirmed_by.display_name}` : ''}`}
          {message.cancelled_at && ` · Cancelled ${when(message.cancelled_at)}`}
        </p>
      )}

      {preview && (
        <div className="mt-3 space-y-2">
          <pre className="max-h-80 overflow-y-auto rounded-2xl border border-line bg-cream px-4 py-3 font-sans text-sm leading-relaxed whitespace-pre-wrap text-ink">
            {message.text}
          </pre>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>To {message.phone_number}</span>
            <button type="button" onClick={copy} className={textAction}>
              {copied ? 'Copied' : 'Copy text'}
            </button>
            {active && (
              <button type="button" onClick={() => onConfirm('cancel')} disabled={busy} className={`${textAction} text-red-700`}>
                Cancel message
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

export function DistributionPage() {
  const { clearUser } = useAuth()
  // ?batch=<id>&guide=1 keeps the chosen batch and guided mode across refreshes.
  const [params, setParams] = useSearchParams()
  const initialBatch = useRef(Number(params.get('batch')) || undefined)
  const guided = params.get('guide') === '1'
  const [view, setView] = useState<View>(params.get('batch') ? 'queue' : 'prepare')
  // null: resume from the saved statuses.
  const [guideIndex, setGuideIndex] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<Candidates | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [includeSent, setIncludeSent] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [batches, setBatches] = useState<BatchSummary[] | null>(null)
  const [batch, setBatch] = useState<Batch | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const fail = useCallback(
    (err: unknown, set: (message: string) => void) => {
      if (err instanceof ApiError && err.status === 401) return clearUser()
      set(describeDistributionError(err))
    },
    [clearUser],
  )

  const loadBatch = useCallback(
    (id: number) =>
      getBatch(id)
        .then(setBatch)
        .catch((err) => fail(err, setQueueError)),
    [fail],
  )

  const refreshBatches = useCallback(
    (show?: number) =>
      listBatches()
        .then((page) => {
          setBatches(page.results)
          const wanted = show ?? initialBatch.current
          initialBatch.current = undefined
          const id = page.results.some((b) => b.id === wanted) ? wanted : page.results[0]?.id
          if (id !== undefined) return loadBatch(id)
        })
        .catch((err) => fail(err, setQueueError)),
    [fail, loadBatch],
  )

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    getCandidates()
      .then((data) => !cancelled && setCandidates(data))
      .catch((err) => !cancelled && fail(err, setLoadError))
    return () => {
      cancelled = true
    }
  }, [reloadKey, fail])

  useEffect(() => {
    refreshBatches()
  }, [refreshBatches])

  const groups = useMemo(() => candidates?.omkars ?? [], [candidates])
  const ready = useMemo(() => groups.flatMap((g) => g.posts.filter((p) => selectable(p, false)).map((p) => p.id)), [groups])
  const sentCount = groups.reduce((n, g) => n + g.posts.filter((p) => p.sent_at && !p.unavailable_reason).length, 0)
  const chosenGroups = groups.filter((g) => g.posts.some((p) => selected.has(p.id)))
  const estimate = chosenGroups.reduce((n, g) => n + Math.ceil(g.posts.filter((p) => selected.has(p.id)).length / MAX_POSTS_PER_MESSAGE), 0)
  const openCount = batch?.messages.filter(isActive).length ?? 0
  const index = guideIndex ?? (batch ? resumeIndex(batch.messages) : -1)

  function chooseBatch(id: number) {
    setGuideIndex(null)
    setParams(guided ? { batch: String(id), guide: '1' } : { batch: String(id) }, { replace: true })
    loadBatch(id)
  }

  function startGuide() {
    if (!batch) return
    setGuideIndex(null)
    setQueueError(null)
    setParams({ batch: String(batch.id), guide: '1' })
  }

  function exitGuide() {
    setParams(batch ? { batch: String(batch.id) } : {})
  }

  function change(ids: number[], checked: boolean) {
    setSelected((s) => {
      const next = new Set(s)
      ids.forEach((id) => (checked ? next.add(id) : next.delete(id)))
      return next
    })
    setFormError(null)
  }

  function toggleIncludeSent(on: boolean) {
    setIncludeSent(on)
    if (!on) {
      const sent = new Set(groups.flatMap((g) => g.posts.filter((p) => p.sent_at).map((p) => p.id)))
      setSelected((s) => new Set([...s].filter((id) => !sent.has(id))))
    }
  }

  async function prepare() {
    if (!selected.size) return setFormError('Choose at least one post.')
    setPreparing(true)
    setFormError(null)
    try {
      const created = await prepareBatch([...selected], includeSent)
      setSelected(new Set())
      setIncludeSent(false)
      setBatch(created)
      setGuideIndex(null)
      setParams({ batch: String(created.id) }, { replace: true })
      setView('queue')
      setReloadKey((k) => k + 1)
      refreshBatches(created.id)
    } catch (err) {
      fail(err, setFormError)
      setReloadKey((k) => k + 1)
    } finally {
      setPreparing(false)
    }
  }

  function replaceMessage(updated: DistributionMessage) {
    setBatch((b) => (b && b.id === updated.batch_id ? { ...b, messages: b.messages.map((m) => (m.id === updated.id ? updated : m)) } : b))
  }

  async function openNow(message: DistributionMessage) {
    setConfirm(null)
    setQueueError(null)
    setBusyId(message.id)
    // Open the tab during the click so pop-up blockers allow it; point it at WhatsApp once OM2 records the open.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    try {
      const updated = await messageAction(message.id, 'open')
      replaceMessage(updated)
      if (!updated.url) tab?.close()
      else if (tab) tab.location.href = updated.url
      else window.open(updated.url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      tab?.close()
      fail(err, setQueueError)
      // The message may have been sent, cancelled or changed elsewhere: show its saved state.
      loadBatch(message.batch_id)
    } finally {
      setBusyId(null)
    }
  }

  async function act(message: DistributionMessage, action: 'confirm-sent' | 'cancel') {
    setBusyId(message.id)
    setQueueError(null)
    try {
      const updated = await messageAction(message.id, action)
      replaceMessage(updated)
      if (guided && batch) {
        // Move on to the next message still waiting; stay put when none is left.
        const messages = batch.messages.map((m) => (m.id === updated.id ? updated : m))
        const at = messages.findIndex((m) => m.id === updated.id)
        const next = nextActiveIndex(messages, at)
        setGuideIndex(next >= 0 ? next : at)
      }
      setConfirm(null)
      setReloadKey((k) => k + 1)
      refreshBatches(message.batch_id)
    } catch (err) {
      setConfirm(null)
      fail(err, setQueueError)
      loadBatch(message.batch_id)
    } finally {
      setBusyId(null)
    }
  }

  const tabs = (
    <div role="tablist" aria-label="Distribution" className="flex gap-6 border-b border-line text-sm">
      {(
        [
          ['prepare', 'Prepare'],
          ['queue', openCount ? `Queue · ${openCount}` : 'Queue'],
        ] as [View, string][]
      ).map(([key, label]) => (
        <button
          key={key}
          role="tab"
          type="button"
          aria-selected={view === key}
          onClick={() => setView(key)}
          className={`-mb-px border-b-[1.5px] pb-2.5 font-medium tabular-nums transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass ${
            view === key ? 'border-brass text-ink' : 'border-transparent text-muted hover:text-ink'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )

  return (
    <div className="mx-auto w-full max-w-[900px] space-y-5 pb-6">
      <div>
        <p className={eyebrow}>Distribution</p>
        <h1 className="mt-1 font-display text-[1.75rem] leading-tight text-ink sm:text-[2rem]">Send approved posts to Omkars</h1>
        <p className="mt-1 text-sm text-muted sm:text-[15px]">Prepare WhatsApp messages, then open and send each one yourself.</p>
      </div>
      {tabs}

      {view === 'prepare' ? (
        loadError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{loadError}</span>
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={secondaryButton}>
              Retry
            </button>
          </div>
        ) : candidates === null ? (
          <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Spinner />
            Loading approved posts…
          </p>
        ) : (
          <div className="space-y-4">
            <section aria-label="Approved posts" className={panel}>
              {groups.length === 0 ? (
                <p className="px-5 py-12 text-center text-sm text-muted">
                  No approved posts for assigned accounts yet.{' '}
                  <Link to="/admin/library?status=DRAFT" className={textAction}>
                    Review drafts
                  </Link>
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-4 py-3 text-sm sm:px-5">
                    <button
                      type="button"
                      onClick={() => change(ready, true)}
                      disabled={!ready.length || ready.every((id) => selected.has(id)) || preparing}
                      className={textAction}
                    >
                      Select all ready
                    </button>
                    {sentCount > 0 && (
                      <label className="flex cursor-pointer items-center gap-2 text-muted">
                        <input type="checkbox" checked={includeSent} onChange={(e) => toggleIncludeSent(e.target.checked)} className={checkbox} />
                        Include already sent ({sentCount})
                      </label>
                    )}
                  </div>
                  <ul className="divide-y divide-line">
                    {groups.map((group) => (
                      <OmkarGroup
                        key={group.omkar.id}
                        group={group}
                        selected={selected}
                        includeSent={includeSent}
                        disabled={preparing}
                        onChange={change}
                      />
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm sm:px-5">
                    <p className="text-muted tabular-nums">
                      <span className={selected.size ? 'font-medium text-ink' : ''}>{selected.size} selected</span> · up to {MAX_POSTS_PER_MESSAGE} posts per message
                    </p>
                    <button type="button" onClick={() => setSelected(new Set())} disabled={!selected.size || preparing} className={textAction}>
                      Clear selection
                    </button>
                  </div>
                </>
              )}
            </section>

            {candidates.unassigned_count > 0 && (
              <p className="text-center text-[13px] text-muted">
                {plural(candidates.unassigned_count, 'approved post')} {candidates.unassigned_count === 1 ? 'is' : 'are'} on accounts without an Omkar.{' '}
                <Link to="/admin/x-accounts" className={textAction}>
                  Assign accounts
                </Link>
              </p>
            )}

            <div className="flex flex-col items-center gap-2">
              {formError && (
                <p role="alert" className="text-center text-sm text-red-700">
                  {formError}
                </p>
              )}
              <button
                type="button"
                onClick={prepare}
                disabled={preparing || !groups.length}
                className="inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-brass px-9 py-3.5 text-base font-semibold text-ink shadow-sm transition hover:bg-brass-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-64"
              >
                {preparing && <Spinner />}
                {preparing ? 'Preparing…' : 'Prepare messages'}
                {!preparing && <span aria-hidden="true">→</span>}
              </button>
              <p className="text-sm text-muted tabular-nums">
                {selected.size
                  ? `${plural(selected.size, 'post')} for ${plural(chosenGroups.length, 'Omkar')} · about ${plural(estimate, 'message')}`
                  : 'Select posts to prepare'}
              </p>
            </div>
          </div>
        )
      ) : (
        <section aria-label="Queue" className="space-y-4">
          {batches && batches.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-muted">
                <span>Batch</span>
                <select
                  value={batch?.id ?? ''}
                  onChange={(e) => chooseBatch(Number(e.target.value))}
                  className="rounded-full border border-line bg-ivory px-3.5 py-1.5 text-sm text-ink outline-none focus:border-brass focus:ring-2 focus:ring-brass/25"
                >
                  {batches.map((b) => {
                    const open = b.counts.PENDING + b.counts.OPENED
                    return (
                      <option key={b.id} value={b.id}>
                        {`#${b.id} · ${when(b.created_at)}${open ? ` · ${open} to send` : ''}`}
                      </option>
                    )
                  })}
                </select>
              </label>
              {batch && openCount > 0 && !guided && (
                <button type="button" onClick={startGuide} className={primaryButton}>
                  {hasStarted(batch.messages) ? 'Resume distribution' : 'Start distribution'}
                </button>
              )}
            </div>
          )}
          {!guided && (
            <p className="text-xs text-muted">Opened means WhatsApp was opened from OM2, not that the message was sent.</p>
          )}
          {queueError && !(guided && batch) && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
              <span>{queueError}</span>
              <button type="button" onClick={() => setQueueError(null)} className="font-medium hover:underline">
                Dismiss
              </button>
            </div>
          )}
          {batches === null ? (
            <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
              <Spinner />
              Loading queue…
            </p>
          ) : !batch ? (
            <p className={`${panel} px-5 py-12 text-center text-sm text-muted`}>No messages prepared yet.</p>
          ) : guided ? (
            <GuidedDistribution
              batch={batch}
              index={index}
              busy={busyId !== null}
              error={queueError}
              onIndex={(i) => {
                setQueueError(null)
                setGuideIndex(i)
              }}
              onOpen={(message) => (message.status === 'OPENED' ? setConfirm({ kind: 'reopen', message }) : openNow(message))}
              onConfirm={(kind, message) => setConfirm({ kind, message })}
              onExit={exitGuide}
            />
          ) : (
            <ul aria-label={`Messages in batch ${batch.id}`} className={`${panel} divide-y divide-line`}>
              {batch.messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  busy={busyId === message.id}
                  onOpen={() => (message.status === 'OPENED' ? setConfirm({ kind: 'reopen', message }) : openNow(message))}
                  onConfirm={(kind) => setConfirm({ kind, message })}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {confirm && (
        <Modal
          role="alertdialog"
          title={confirm.kind === 'reopen' ? 'Open this message again?' : confirm.kind === 'sent' ? 'Mark as sent?' : 'Cancel this message?'}
          description={
            confirm.kind === 'reopen'
              ? `You already opened it ${plural(confirm.message.open_count, 'time')}. Check WhatsApp first so ${confirm.message.omkar.display_name} doesn’t get it twice.`
              : confirm.kind === 'sent'
                ? `Only confirm if you pressed Send in WhatsApp for ${confirm.message.omkar.display_name}. This doesn’t mean the posts are published on X.`
                : 'Its posts can be prepared again in a new batch.'
          }
          onClose={() => setConfirm(null)}
          busy={busyId === confirm.message.id}
          footer={
            <>
              <button type="button" onClick={() => setConfirm(null)} disabled={busyId === confirm.message.id} className={secondaryButton}>
                Back
              </button>
              <button
                type="button"
                disabled={busyId === confirm.message.id}
                onClick={() =>
                  confirm.kind === 'reopen' ? openNow(confirm.message) : act(confirm.message, confirm.kind === 'sent' ? 'confirm-sent' : 'cancel')
                }
                className={primaryButton}
              >
                {busyId === confirm.message.id && <Spinner />}
                {confirm.kind === 'reopen' ? 'Open again' : confirm.kind === 'sent' ? 'Yes, I sent it' : 'Cancel message'}
              </button>
            </>
          }
        />
      )}
    </div>
  )
}
