import { useState } from 'react'
import { MESSAGE_STATUS_LABELS, type Batch, type DistributionMessage } from '../../api/distribution'
import { Spinner } from '../../components/Spinner'
import { WarningIcon } from '../content/ContentBits'
import { shortDateTime } from '../content/styles'
import { isActive, nextActiveIndex } from './guide'

const textAction =
  'font-medium text-ink underline decoration-brass decoration-1 underline-offset-[5px] transition hover:text-brass-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:cursor-not-allowed disabled:text-muted disabled:no-underline'
const bigButton =
  'inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-brass px-9 py-3.5 text-base font-semibold text-ink shadow-sm transition hover:bg-brass-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:min-w-64'
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

interface GuidedProps {
  batch: Batch
  index: number
  busy: boolean
  error: string | null
  onIndex: (index: number) => void
  onOpen: (message: DistributionMessage) => void
  onConfirm: (kind: 'sent' | 'cancel', message: DistributionMessage) => void
  onExit: () => void
}

/**
 * One message at a time: open it in WhatsApp, then confirm sending by hand or skip it.
 * Progress is the messages' saved statuses, so a refresh resumes in the same place.
 */
export function GuidedDistribution({ batch, index, busy, error, onIndex, onOpen, onConfirm, onExit }: GuidedProps) {
  const [preview, setPreview] = useState(false)
  const [copied, setCopied] = useState(false)
  const messages = batch.messages
  const done = messages.filter((m) => !isActive(m)).length
  const remaining = messages.length - done
  const message = index >= 0 ? messages[index] : undefined
  const handles = message ? [...new Set(message.posts.map((p) => `@${p.handle}`))].join(' · ') : ''
  const next = message ? nextActiveIndex(messages, index) : -1

  async function copy() {
    if (!message) return
    try {
      await navigator.clipboard.writeText(message.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setPreview(true)
    }
  }

  function go(i: number) {
    setPreview(false)
    onIndex(i)
  }

  return (
    <section
      aria-label="Guided distribution"
      className="rounded-3xl border border-line bg-ivory px-5 py-6 shadow-[0_1px_2px_rgba(25,38,56,0.04),0_8px_24px_-12px_rgba(25,38,56,0.08)] sm:px-10 sm:py-9"
    >
      <div className="flex items-center justify-between gap-4 text-sm">
        <p className="text-muted tabular-nums">
          {done} of {plural(messages.length, 'message')} done
        </p>
        <button type="button" onClick={onExit} className={textAction}>
          Back to queue
        </button>
      </div>
      <div
        role="progressbar"
        aria-label="Batch progress"
        aria-valuemin={0}
        aria-valuemax={messages.length}
        aria-valuenow={done}
        className="mt-3 h-1 overflow-hidden rounded-full bg-sand"
      >
        <div className="h-full rounded-full bg-brass transition-all" style={{ width: `${messages.length ? (done / messages.length) * 100 : 0}%` }} />
      </div>

      {!remaining || !message ? (
        <div role="status" className="py-14 text-center">
          <p className="font-display text-3xl text-ink">All messages handled</p>
          <p className="mt-2 text-sm text-muted">Every message in this batch is marked sent or cancelled. Nothing was published on X by OM2.</p>
        </div>
      ) : (
        <div className="py-10 text-center sm:py-12">
          <p className="text-xs font-semibold tracking-[0.16em] text-brass-dark uppercase tabular-nums">
            Message {index + 1} of {messages.length}
          </p>
          <h2 className="mt-3 font-display text-[2rem] leading-tight text-ink">{message.omkar.display_name}</h2>
          <p className="mt-1.5 text-sm text-muted">
            {handles} · {plural(message.posts.length, 'post')}
            {message.of > 1 && ` · part ${message.position} of ${message.of}`}
          </p>
          <p className="mt-3 text-sm">
            <span className="rounded-full bg-sand px-2.5 py-0.5 text-xs font-medium text-ink">{MESSAGE_STATUS_LABELS[message.status]}</span>
          </p>

          {message.warnings.map((w) => (
            <p key={w.code} className="mx-auto mt-4 flex max-w-md items-start justify-center gap-2 text-[13px] text-amber-800">
              <WarningIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              {w.message}
            </p>
          ))}
          {error && (
            <div role="alert" className="mx-auto mt-5 max-w-md rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              <p>{error}</p>
              {isActive(message) && (
                <button type="button" onClick={() => onConfirm('cancel', message)} className="mt-1.5 font-medium underline underline-offset-4">
                  Cancel this message
                </button>
              )}
            </div>
          )}

          <div className="mt-8 flex flex-col items-center gap-3">
            {message.status === 'PENDING' && (
              <>
                <button type="button" onClick={() => onOpen(message)} disabled={busy} className={bigButton}>
                  {busy && <Spinner />}
                  Open WhatsApp
                  <span aria-hidden="true">↗</span>
                </button>
                <p className="text-sm text-muted">Check the message in WhatsApp and press Send there.</p>
              </>
            )}
            {message.status === 'OPENED' && (
              <>
                <p className="text-[15px] text-ink">Did you press Send in WhatsApp?</p>
                <button type="button" onClick={() => onConfirm('sent', message)} disabled={busy} className={bigButton}>
                  {busy && <Spinner />}
                  Yes, I sent it
                </button>
                <div className="flex items-center gap-5 text-sm">
                  <button type="button" onClick={() => go(next)} disabled={busy || next < 0} className={textAction}>
                    Skip for now
                  </button>
                  <button type="button" onClick={() => onOpen(message)} disabled={busy} className={textAction}>
                    Open again
                  </button>
                </div>
              </>
            )}
            {!isActive(message) && (
              <>
                <p className="text-sm text-muted">
                  {message.status === 'SENT' && message.sent_confirmed_at
                    ? `Marked sent ${shortDateTime.format(new Date(message.sent_confirmed_at))}.`
                    : 'This message was cancelled.'}
                </p>
                {next >= 0 && (
                  <button type="button" onClick={() => go(next)} className={bigButton}>
                    Next pending message
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {message && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-line pt-5 text-sm">
            <button type="button" onClick={() => go(index - 1)} disabled={index <= 0 || busy} className={textAction}>
              ← Previous
            </button>
            <div className="flex items-center gap-5">
              <button type="button" aria-expanded={preview} onClick={() => setPreview((v) => !v)} className={textAction}>
                {preview ? 'Hide message' : 'Preview'}
              </button>
              <button type="button" onClick={copy} className={textAction}>
                {copied ? 'Copied' : 'Copy message'}
              </button>
            </div>
            <button type="button" onClick={() => go(index + 1)} disabled={index >= messages.length - 1 || busy} className={textAction}>
              Next →
            </button>
          </div>
          {preview && (
            <pre className="mt-4 max-h-96 overflow-y-auto rounded-2xl border border-line bg-cream px-4 py-3 text-left font-sans text-sm leading-relaxed whitespace-pre-wrap text-ink">
              {message.text}
            </pre>
          )}
        </>
      )}
    </section>
  )
}
