import type { DistributionMessage } from '../../api/distribution'

// Guided distribution keeps no progress of its own: it reads the messages' saved statuses.

export const isActive = (m: DistributionMessage) => m.status === 'PENDING' || m.status === 'OPENED'

/** Where to resume: an Opened message waiting for confirmation, else the first Pending one; -1 when none. */
export function resumeIndex(messages: DistributionMessage[]): number {
  const opened = messages.findIndex((m) => m.status === 'OPENED')
  return opened >= 0 ? opened : messages.findIndex(isActive)
}

/** The next Pending or Opened message after `from`, wrapping around; -1 when no other one is left. */
export function nextActiveIndex(messages: DistributionMessage[], from: number): number {
  for (let step = 1; step < messages.length; step++) {
    const i = (from + step) % messages.length
    if (isActive(messages[i])) return i
  }
  return -1
}

/** True once any message in the batch was opened, sent or cancelled. */
export const hasStarted = (messages: DistributionMessage[]) => messages.some((m) => m.status !== 'PENDING')
