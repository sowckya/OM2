import type { AdminNavItem } from './navigation'

/** Placeholder page for admin modules that are not built yet. */
export function ModulePlaceholder({ item }: { item: AdminNavItem }) {
  const Icon = item.icon
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <Icon />
      </div>
      <span className="inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Coming Soon
      </span>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">{item.label}</h1>
      {item.description && <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">{item.description}</p>}
    </div>
  )
}
