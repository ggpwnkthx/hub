/**
 * The lifecycle of Hub.
 *
 * The runtime owns the admission and the shutdown: it handles the signals
 * of the process and it drains the work that is in flight before the
 * process exits.
 */

import type { Logger } from '../observability'

/**
 * The deadline of the drain, in milliseconds.
 *
 * The running logins are given five seconds to finish and the process
 * exits: a deployment that is replaced waits for its replica.
 */
export const DRAIN_TIMEOUT_MS = 5_000

export interface DrainOptions {
  /** The logger of the service. */
  logger: Logger
  /** How long the drain may take, in milliseconds. */
  timeoutMs?: number
  /** Stops the listener; `force` closes the connections that are open. */
  stopListener: (force: boolean) => Promise<void>
  /** Closes the clients and the stores. */
  closeResources: () => Promise<void>
  /** Reports whether the service is draining. */
  setDraining: (draining: boolean) => void
}

/**
 * Drains the service.
 *
 * The admission stops first: a task that is going away does not accept new
 * work. The connections that are open get the deadline, then they are
 * closed.
 */
export async function drain(options: DrainOptions, reason: string): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DRAIN_TIMEOUT_MS
  options.logger.info('the service is draining', { reason })
  options.setDraining(true)

  const drained = await Promise.race([
    options.stopListener(false).then(
      () => true,
      () => false
    ),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref?.()
    }),
  ])
  if (!drained) {
    options.logger.warn('the drain deadline was reached, the remaining connections are closed', {
      timeoutMs,
    })
    await options.stopListener(true).catch(() => undefined)
  }

  await options.closeResources()
  options.logger.info('the service is stopped')
}
