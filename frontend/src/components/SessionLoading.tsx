import { Spinner } from './Spinner'

export function SessionLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">
      <p role="status" className="flex items-center gap-2 text-sm">
        <Spinner />
        Checking your session…
      </p>
    </main>
  )
}
