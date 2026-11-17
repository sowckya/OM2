import { useId, useState, type MouseEvent } from 'react'
import { ApiError } from '../../api/client'
import {
  approveContent,
  describeContentError,
  getContent,
  needsAcknowledgement,
  rejectContent,
  restoreContent,
  type ContentItem,
  type Warning,
  type WhatsAppShare,
} from '../../api/content'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { Modal } from './Modal'
import { dangerButton, inputClass, primaryButton, secondaryButton, smallApproveButton, smallButton } from './styles'

interface ContentActionsProps {
  item: ContentItem
  onChanged: (item: ContentItem, message: string) => void
  onEdit?: () => void
  onError: (message: string) => void
  /** `sm` for dense cards and table rows. */
  size?: 'sm' | 'md'
}

type Pending = { kind: 'confirm-approve'; warnings: Warning[] } | { kind: 'reject' } | null

/** Edit / Approve / Reject / Restore buttons for one post, with their confirmations. */
const APPROVE_MD =
  'inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-60'

export function ContentActions({ item, onChanged, onEdit, onError, size = 'md' }: ContentActionsProps) {
  const plain = size === 'sm' ? smallButton : secondaryButton
  const approveClass = size === 'sm' ? smallApproveButton : APPROVE_MD
  const { clearUser } = useAuth()
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<Pending>(null)
  const [reason, setReason] = useState('')
  const handle = `@${item.x_account.handle}`

  async function run(action: () => Promise<ContentItem>, message: string) {
    setBusy(true)
    try {
      const updated = await action()
      setPending(null)
      onChanged(updated, message)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return clearUser()
      if (needsAcknowledgement(err)) {
        const data = (err as ApiError).data as { warnings?: Warning[] }
        setPending({ kind: 'confirm-approve', warnings: data.warnings ?? item.warnings })
      } else {
        setPending(null)
        onError(describeContentError(err))
      }
    } finally {
      setBusy(false)
    }
  }

  const approve = (acknowledge: boolean) =>
    run(() => approveContent(item.id, acknowledge), `Post for ${handle} approved.`)

  return (
    <div className={`flex flex-wrap items-center ${size === 'sm' ? 'gap-1.5' : 'gap-2'}`}>
      {item.status !== 'REJECTED' && onEdit && (
        <button type="button" onClick={onEdit} disabled={busy} className={plain}>
          Edit
        </button>
      )}
      {item.status === 'DRAFT' && (
        <button
          type="button"
          onClick={() => (item.warnings.length ? setPending({ kind: 'confirm-approve', warnings: item.warnings }) : approve(false))}
          disabled={busy}
          className={approveClass}
        >
          {busy && !pending && <Spinner className="h-3.5 w-3.5" />}
          Approve
        </button>
      )}
      {item.status !== 'REJECTED' && (
        <button
          type="button"
          onClick={() => {
            setReason('')
            setPending({ kind: 'reject' })
          }}
          disabled={busy}
          className={`${plain} text-red-700 hover:text-red-800`}
        >
          Reject
        </button>
      )}
      {item.status === 'APPROVED' && item.whatsapp && <SendToWhatsApp item={item} size={size} />}
      {item.status === 'REJECTED' && (
        <button type="button" onClick={() => run(() => restoreContent(item.id), `Post for ${handle} restored to draft.`)} disabled={busy} className={plain}>
          {busy && <Spinner className="h-3.5 w-3.5" />}
          Restore to draft
        </button>
      )}

      {pending?.kind === 'confirm-approve' && (
        <Modal
          role="alertdialog"
          title="Approve with warnings?"
          description={`This post for ${handle} has warnings. Approve it only if you’ve checked them.`}
          onClose={() => setPending(null)}
          busy={busy}
          footer={
            <>
              <button type="button" onClick={() => setPending(null)} disabled={busy} className={secondaryButton}>
                Cancel
              </button>
              <button type="button" onClick={() => approve(true)} disabled={busy} className={primaryButton}>
                {busy && <Spinner />}
                Approve anyway
              </button>
            </>
          }
        >
          <ul className="space-y-1.5 text-sm text-amber-800">
            {pending.warnings.map((w, i) => (
              <li key={i}>⚠ {w.message}</li>
            ))}
          </ul>
        </Modal>
      )}
      {pending?.kind === 'reject' && (
        <Modal
          title="Reject this post?"
          description={`It stays in ${handle}’s history so similar ideas are flagged later. You can restore it.`}
          onClose={() => setPending(null)}
          busy={busy}
          footer={
            <>
              <button type="button" onClick={() => setPending(null)} disabled={busy} className={secondaryButton}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => run(() => rejectContent(item.id, reason.trim()), `Post for ${handle} rejected.`)}
                disabled={busy}
                className={dangerButton}
              >
                {busy && <Spinner />}
                Reject post
              </button>
            </>
          }
        >
          <label htmlFor={`reject-reason-${item.id}`} className="block text-sm font-medium text-slate-700">
            Reason (optional)
          </label>
          <textarea
            id={`reject-reason-${item.id}`}
            rows={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`${inputClass()} mt-1.5`}
          />
        </Modal>
      )}
    </div>
  )
}

const WHATSAPP_MD =
  'inline-flex items-center gap-1.5 rounded-full bg-brass px-3.5 py-1.5 text-sm font-semibold text-ink shadow-sm transition hover:bg-brass-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink'
const WHATSAPP_SM =
  'inline-flex items-center gap-1.5 rounded-full bg-brass px-2.5 py-1 text-xs font-semibold text-ink shadow-xs transition hover:bg-brass-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink'

/**
 * Opens WhatsApp with the assigned Omkar's number and the post prefilled; the Millionaire
 * presses Send there. Opening it never marks the post as sent or published.
 *
 * Lists only carry short X links that already exist. When this post has none yet, the click
 * asks the server for the post again (which creates and caches the TinyURL link) and opens
 * that message; if that fails, the full X link already in the list is used.
 */
export function SendToWhatsApp({ item, size = 'md' }: { item: ContentItem; size?: 'sm' | 'md' }) {
  const reasonId = useId()
  const [fresh, setFresh] = useState<WhatsAppShare | null>(null)
  const share = fresh ?? item.whatsapp!
  const className = size === 'sm' ? WHATSAPP_SM : WHATSAPP_MD
  if (!share.url) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" disabled aria-describedby={reasonId} className={`${className} cursor-not-allowed opacity-50 hover:bg-brass`}>
          Send to WhatsApp
        </button>
        <span id={reasonId} className="max-w-56 text-xs text-muted">
          {share.unavailable_reason}
        </span>
      </span>
    )
  }

  async function open(event: MouseEvent<HTMLAnchorElement>) {
    if (share.x_link_shortened) return
    event.preventDefault()
    // Open the tab during the click so pop-up blockers allow it, then point it at WhatsApp.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    let next = share
    try {
      const latest = await getContent(item.id)
      next = latest.whatsapp ?? { ...share, url: null, unavailable_reason: 'Only approved posts can be sent.' }
    } catch {
      // Keep the full X link from the list.
    }
    setFresh(next)
    if (!next.url) tab?.close()
    else if (tab) tab.location.href = next.url
    else window.open(next.url, '_blank', 'noopener,noreferrer')
  }

  return (
    <a
      href={share.url}
      onClick={open}
      target="_blank"
      rel="noopener noreferrer"
      title={share.recipient ? `Opens WhatsApp with a message to ${share.recipient.display_name}. Press Send there.` : undefined}
      className={className}
    >
      Send to WhatsApp
      <span aria-hidden="true">↗</span>
      {share.recipient && <span className="sr-only">{`: ${share.recipient.display_name}`}</span>}
    </a>
  )
}
