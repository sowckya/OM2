export const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-full bg-brass px-5 py-2 text-sm font-semibold text-ink shadow-sm transition hover:bg-brass-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60'
/** Smaller variants for dense lists and cards. */
export const smallButton =
  'inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-xs transition hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50'
export const smallApproveButton =
  'inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-xs transition hover:bg-emerald-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-emerald-600 disabled:opacity-60'
export const secondaryButton =
  'inline-flex items-center justify-center gap-2 rounded-full border border-line bg-ivory px-4 py-1.5 text-sm font-medium text-ink transition hover:bg-sand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass disabled:cursor-not-allowed disabled:opacity-50'
export const dangerButton =
  'inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-60'
export const inputClass = (invalid = false) =>
  `block w-full rounded-lg border px-3 py-2 text-base text-slate-900 shadow-sm outline-none transition focus:ring-2 disabled:bg-slate-50 sm:text-sm ${
    invalid ? 'border-red-400 focus:border-red-500 focus:ring-red-500/30' : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-500/30'
  }`

/** Date and time in IST, e.g. "25 Oct 2026, 3:30 pm". */
export const dateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
})

/** Compact date and time in IST, e.g. "25 Oct, 3:30 pm". */
export const shortDateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'Asia/Kolkata',
})
