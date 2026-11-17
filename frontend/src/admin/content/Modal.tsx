import { useEffect, useId, type ReactNode } from 'react'

interface ModalProps {
  title: string
  description?: ReactNode
  onClose: () => void
  /** Escape and the backdrop don't close while busy. */
  busy?: boolean
  footer?: ReactNode
  size?: 'md' | 'lg'
  role?: 'dialog' | 'alertdialog'
  children?: ReactNode
}

/** Bottom sheet on phones, centred dialog on larger screens. */
export function Modal({ title, description, onClose, busy, footer, size = 'md', role = 'dialog', children }: ModalProps) {
  const titleId = useId()
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, busy])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="fixed inset-0 bg-navy-950/50" aria-hidden="true" onClick={busy ? undefined : onClose} />
      <div
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-ivory shadow-xl sm:rounded-2xl ${size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
      >
        <div className="border-b border-line px-5 py-4 sm:px-6">
          <h2 id={titleId} className="font-display text-xl text-ink">
            {title}
          </h2>
          {description && <div className="mt-0.5 text-sm text-slate-500">{description}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-line bg-cream px-5 py-4 sm:flex-row sm:justify-end sm:rounded-b-2xl sm:px-6">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
