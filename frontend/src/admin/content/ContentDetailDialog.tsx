import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError } from '../../api/client'
import {
  FORMAT_LABELS,
  STATUS_LABELS,
  describeContentError,
  getContent,
  getRevisions,
  type ContentItem,
  type Revision,
} from '../../api/content'
import { LANGUAGE_OPTIONS } from '../../api/contentDna'
import { useAuth } from '../../auth/AuthContext'
import { Spinner } from '../../components/Spinner'
import { ContentActions } from './ContentActions'
import { ContentPreview, SourceBadge, StatusPill, WarningList } from './ContentBits'
import { ContentEditorDialog } from './ContentEditorDialog'
import { Modal } from './Modal'
import { dateTime, secondaryButton } from './styles'

const ACTION_LABELS: Record<Revision['action'], string> = {
  CREATED: 'Created',
  EDITED: 'Edited',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RESTORED: 'Restored to draft',
}

interface ContentDetailDialogProps {
  itemId: number
  onClose: () => void
  /** Called after any change so lists can refresh. */
  onChanged: (item: ContentItem, message: string) => void
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-slate-800">{children}</dd>
    </div>
  )
}

export function ContentDetailDialog({ itemId, onClose, onChanged }: ContentDetailDialogProps) {
  const { clearUser } = useAuth()
  const [item, setItem] = useState<ContentItem | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) return clearUser()
      setError(describeContentError(err))
    },
    [clearUser],
  )

  useEffect(() => {
    let cancelled = false
    setError(null)
    Promise.all([getContent(itemId), getRevisions(itemId)])
      .then(([loaded, history]) => {
        if (cancelled) return
        setItem(loaded)
        setRevisions(history)
      })
      .catch((err) => !cancelled && fail(err))
    return () => {
      cancelled = true
    }
  }, [itemId, reloadKey, fail])

  function changed(updated: ContentItem, message: string) {
    setNotice(message)
    setReloadKey((k) => k + 1)
    onChanged(updated, message)
  }

  const languageLabel = LANGUAGE_OPTIONS.find((l) => l.value === item?.language)?.label
  const dna = item?.dna_snapshot

  return (
    <>
      <Modal
        title={item ? `Post for @${item.x_account.handle}` : 'Post'}
        description={item && <span className="inline-flex flex-wrap items-center gap-2"><StatusPill status={item.status} /><SourceBadge item={item} /><span className="text-xs text-slate-500">{FORMAT_LABELS[item.format]} · version {item.version}</span></span>}
        onClose={onClose}
        busy={editing}
        size="lg"
        footer={
          <>
            <button type="button" onClick={onClose} className={secondaryButton}>
              Close
            </button>
            {item && <ContentActions item={item} onChanged={changed} onEdit={() => setEditing(true)} onError={setError} />}
          </>
        }
      >
        {error && (
          <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((k) => k + 1)} className={secondaryButton}>
              Retry
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {notice}
          </p>
        )}
        {!item && !error ? (
          <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Spinner />
            Loading post…
          </p>
        ) : item ? (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_15rem]">
            <div className="min-w-0 space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                <ContentPreview item={item} />
              </div>
              <WarningList item={item} defaultOpen />
              {item.status === 'REJECTED' && item.rejection_reason && (
                <p className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">Rejected: {item.rejection_reason}</p>
              )}

              <section aria-label="History">
                <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">History</h3>
                <ol className="mt-2 space-y-3 border-l-2 border-slate-100 pl-4">
                  {revisions.map((r) => (
                    <li key={r.id} className="relative text-sm">
                      <span aria-hidden="true" className="absolute top-1.5 -left-[1.3rem] h-2 w-2 rounded-full bg-slate-300 ring-2 ring-white" />
                      <p className="font-medium text-slate-800">
                        {ACTION_LABELS[r.action]} · v{r.version}
                        <span className="font-normal text-slate-500">
                          {' '}
                          — {dateTime.format(new Date(r.created_at))}
                          {r.changed_by && ` by ${r.changed_by.display_name}`}
                        </span>
                      </p>
                      {r.note && <p className="text-slate-500">{r.note}</p>}
                      {(r.action === 'CREATED' || r.action === 'EDITED') && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-xs font-medium text-indigo-600">Show text ({STATUS_LABELS[r.status]})</summary>
                          <div className="mt-1 rounded-lg bg-slate-50 p-2">
                            <ContentPreview item={r} compact />
                          </div>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              </section>
            </div>

            <aside className="space-y-4 lg:border-l lg:border-slate-100 lg:pl-5">
              <dl className="grid grid-cols-2 gap-3 lg:grid-cols-1">
                <Meta label="Account">@{item.x_account.handle}</Meta>
                <Meta label="Theme">{item.theme || '—'}</Meta>
                <Meta label="Language">{languageLabel ?? '—'}</Meta>
                <Meta label="Generated by">{item.generation ? `${item.generation.provider} · ${item.generation.model_name}` : 'Written manually'}</Meta>
                <Meta label="Created">
                  {dateTime.format(new Date(item.created_at))}
                  {item.created_by && <span className="block text-slate-500">by {item.created_by.display_name}</span>}
                </Meta>
                <Meta label="Reviewed">
                  {item.reviewed_at ? (
                    <>
                      {dateTime.format(new Date(item.reviewed_at))}
                      {item.reviewed_by && <span className="block text-slate-500">by {item.reviewed_by.display_name}</span>}
                    </>
                  ) : (
                    '—'
                  )}
                </Meta>
              </dl>
              <details className="rounded-lg border border-slate-200 px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">Content DNA used</summary>
                {dna ? (
                  <dl className="mt-3 grid gap-2.5">
                    <Meta label="Primary themes">{dna.primary_themes.join(', ')}</Meta>
                    <Meta label="Secondary themes">{dna.secondary_themes.join(', ') || '—'}</Meta>
                    <Meta label="Tone">{dna.tone.join(', ')}</Meta>
                    <Meta label="Languages">{dna.languages.join(', ')}</Meta>
                    <Meta label="Formats">{dna.allowed_formats.join(', ')}</Meta>
                    <Meta label="Topics to avoid">{dna.topics_to_avoid.join(', ') || '—'}</Meta>
                    <Meta label="Target audience">{dna.target_audience}</Meta>
                    <Meta label="Writing style">{dna.writing_style}</Meta>
                  </dl>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">This account had no Content DNA when the post was created.</p>
                )}
              </details>
            </aside>
          </div>
        ) : null}
      </Modal>
      {editing && item && (
        <ContentEditorDialog
          item={item}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false)
            changed(saved, `Post for @${saved.x_account.handle} saved.`)
          }}
        />
      )}
    </>
  )
}
