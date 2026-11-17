import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext'
import { ClockIcon, InboxIcon } from './icons'

// No business APIs exist yet, so every figure is an honest zero. Replace these
// with real API data once accounts, content and distribution are implemented.
const STATS: { label: string; value: number; caption: string; target?: number }[] = [
  { label: 'Total X Accounts', value: 0, target: 100, caption: 'Accounts added to OM2' },
  { label: 'Total Omkars', value: 0, target: 50, caption: 'Omkars with an OM2 login' },
  { label: 'Ready Posts', value: 0, caption: 'Approved and awaiting release' },
  { label: 'Published Today', value: 0, caption: 'Verified published on X' },
]

const TODAY_STATUSES = ['Scheduled', 'Available to Omkar', 'Submitted', 'Verified Published']

function formatTodayIST(): string {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date())
}

function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon}
      </div>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">{children}</p>
    </div>
  )
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-6 py-4">
        <h2 id={id} className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  )
}

export function MillionaireDashboard() {
  const { auth } = useAuth()
  const name = auth.status === 'authenticated' ? auth.user.display_name : ''
  const today = formatTodayIST()

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
          Welcome back, {name}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {today} · Here’s the state of the OM2 network.
        </p>
      </div>

      <section aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STATS.map(({ label, value, target, caption }) => (
          <article
            key={label}
            aria-label={label}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <p className="text-sm font-medium text-slate-500">{label}</p>
            <p className="mt-2 flex items-baseline gap-1.5">
              <span data-testid="stat-value" className="text-3xl font-semibold tracking-tight text-slate-900">
                {value}
              </span>
              {target !== undefined && (
                <span className="text-sm font-medium text-slate-400">of {target} target</span>
              )}
            </p>
            {target !== undefined && (
              <div
                role="progressbar"
                aria-label={`${label} progress`}
                aria-valuemin={0}
                aria-valuemax={target}
                aria-valuenow={value}
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100"
              >
                <div className="h-full rounded-full bg-indigo-500" style={{ width: `${(value / target) * 100}%` }} />
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">{caption}</p>
          </article>
        ))}
      </section>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Panel title="Today's Publishing Overview" subtitle={`${today} (IST)`}>
            <dl className="grid grid-cols-2 gap-px border-b border-slate-100 bg-slate-100 sm:grid-cols-4">
              {TODAY_STATUSES.map((status) => (
                <div key={status} className="bg-white px-6 py-4">
                  <dt className="text-xs font-medium text-slate-500">{status}</dt>
                  <dd className="mt-1 text-xl font-semibold text-slate-900">0</dd>
                </div>
              ))}
            </dl>
            <EmptyState icon={<ClockIcon />} title="No posts scheduled for today">
              Approved posts released to Omkars will appear here with their target posting times.
            </EmptyState>
          </Panel>
        </div>

        <Panel title="Recent Activity">
          <EmptyState icon={<InboxIcon />} title="No activity yet">
            Approvals, releases and Omkar submissions will be listed here as they happen.
          </EmptyState>
        </Panel>
      </div>
    </div>
  )
}
