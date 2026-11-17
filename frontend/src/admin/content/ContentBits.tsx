import { FORMAT_LABELS, POST_MAX_LENGTH, SOURCE_LABELS, STATUS_LABELS, type ContentItem, type ContentStatus, type DuplicateFlag } from '../../api/content'

const STATUS_STYLES: Record<ContentStatus, { pill: string; dot: string }> = {
  DRAFT: { pill: 'bg-slate-100 text-slate-700 ring-slate-500/15', dot: 'bg-slate-400' },
  APPROVED: { pill: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', dot: 'bg-emerald-500' },
  REJECTED: { pill: 'bg-red-50 text-red-700 ring-red-600/15', dot: 'bg-red-500' },
}

const badge = 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset'

export function StatusPill({ status }: { status: ContentStatus }) {
  const style = STATUS_STYLES[status]
  return (
    <span className={`${badge} ${style.pill}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {STATUS_LABELS[status]}
    </span>
  )
}

/** Where a post came from; mock output is always labelled as such. */
export function SourceBadge({ item }: { item: Pick<ContentItem, 'source' | 'generation'> }) {
  if (item.generation?.is_mock) {
    return (
      <span title="Written by the mock provider: sample text, not real AI" className={`${badge} bg-amber-50 text-amber-800 ring-amber-600/20`}>
        Mock AI
      </span>
    )
  }
  return <span className={`${badge} bg-sand text-brass-dark ring-brass/25`}>{SOURCE_LABELS[item.source]}</span>
}

export function FormatTag({ format }: { format: ContentItem['format'] }) {
  return <span className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{FORMAT_LABELS[format]}</span>
}

export function WarningIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={`shrink-0 ${className}`}>
      <path
        fillRule="evenodd"
        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
  )
}

function Count({ text, max = POST_MAX_LENGTH }: { text: string; max?: number }) {
  return <span className={`text-[11px] tabular-nums ${text.length > max ? 'font-medium text-red-600' : 'text-slate-400'}`}>{text.length}/{max}</span>
}

type PreviewItem = Pick<ContentItem, 'format' | 'body' | 'thread_posts' | 'poll_options'>

/** Renders a post the way it will read on X. `compact` trims threads to two posts. */
export function ContentPreview({ item, compact = false }: { item: PreviewItem; compact?: boolean }) {
  if (item.format === 'THREAD') {
    const posts = compact ? item.thread_posts.slice(0, 2) : item.thread_posts
    return (
      <ol className="space-y-1.5">
        {posts.map((post, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-[11px] font-semibold text-slate-400 tabular-nums">
              {i + 1}/{item.thread_posts.length}
            </span>
            <p className="min-w-0 flex-1 text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{post}</p>
          </li>
        ))}
        {compact && item.thread_posts.length > 2 && <li className="pl-6 text-xs text-slate-500">+ {item.thread_posts.length - 2} more</li>}
      </ol>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-slate-800">{item.body}</p>
      {item.format === 'POLL' && (
        <ul aria-label="Poll options" className="grid gap-1">
          {item.poll_options.map((option, i) => (
            <li key={i} className="rounded-md border border-line bg-cream px-2.5 py-1 text-[13px] text-ink">
              {option}
            </li>
          ))}
        </ul>
      )}
      {!compact && item.format === 'TEXT' && <Count text={item.body} />}
    </div>
  )
}

function DuplicateLine({ flag }: { flag: DuplicateFlag }) {
  return (
    <span className="min-w-0">
      <span className="font-medium">
        {flag.kind === 'EXACT' ? 'Same text' : `Similar idea (${Math.round(flag.similarity * 100)}%)`} on{' '}
        {flag.scope === 'ACCOUNT' ? 'this account' : 'another account'}
      </span>
      <span className="text-amber-800/80"> · {flag.label}</span>
      <span className="block truncate text-amber-800/70 italic">“{flag.excerpt}”</span>
    </span>
  )
}

type Flags = Pick<ContentItem, 'validation_flags' | 'duplicate_flags'>

const plural = (n: number) => `${n} warning${n === 1 ? '' : 's'}`

/** Warnings for review: a one-line summary that expands to the details. */
export function WarningList({ item, compact = false, defaultOpen = false }: { item: Flags; compact?: boolean; defaultOpen?: boolean }) {
  const count = item.validation_flags.length + item.duplicate_flags.length
  if (count === 0) return null
  const messages = [
    ...item.validation_flags.map((f) => f.message),
    ...item.duplicate_flags.map((f) => `${f.kind === 'EXACT' ? 'Same text' : 'Similar idea'}: ${f.label}`),
  ]
  if (compact) {
    return (
      <span title={messages.join('\n')} className="inline-flex items-center gap-1 text-xs font-medium text-amber-700">
        ⚠ {plural(count)}
      </span>
    )
  }
  return (
    <details open={defaultOpen} className="group rounded-lg border border-amber-200/80 bg-amber-50/70 text-sm text-amber-900">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 select-none [&::-webkit-details-marker]:hidden">
        <WarningIcon className="h-4 w-4 text-amber-500" />
        <span className="shrink-0 font-medium">{plural(count)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-amber-800/80 group-open:invisible">{messages[0]}</span>
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-600 transition group-open:rotate-180">
          <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
        </svg>
      </summary>
      <ul aria-label="Warnings" className="space-y-1.5 border-t border-amber-200/70 px-3 py-2 text-[13px]">
        {item.validation_flags.map((flag) => (
          <li key={flag.code + flag.message} className="flex gap-2">
            <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
            <span>{flag.message}</span>
          </li>
        ))}
        {item.duplicate_flags.map((flag, i) => (
          <li key={`dup-${i}`} className="flex gap-2">
            <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
            <DuplicateLine flag={flag} />
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Placeholder rows shown while a list loads. */
export function SkeletonRows({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div role="status" className="divide-y divide-slate-100">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex animate-pulse items-center gap-4 px-4 py-4">
          <div className="h-4 w-4 rounded bg-slate-200" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/3 rounded bg-slate-200" />
            <div className="h-3 w-3/4 rounded bg-slate-100" />
          </div>
          <div className="h-5 w-16 rounded-full bg-slate-100" />
        </div>
      ))}
    </div>
  )
}
