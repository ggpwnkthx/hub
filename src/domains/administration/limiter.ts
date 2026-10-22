/**
 * The limiter of the administration (spec §10.1).
 *
 * The administrative endpoints are guarded by a bearer token, and a token
 * that is guessed by hammering the endpoint is a token that is found. The
 * limiter counts the failed authentications of an address: a burst of them
 * is refused with `429`, and a success clears the count of the address.
 *
 * The window is the one of the process: the replicas of a deployment have
 * one window each, so the limit of the deployment is the limit of a
 * replica times the number of the replicas.
 */

/** How many failures an address may make in the window. */
export const MAX_FAILURES = 5

/** The size of the window, in milliseconds. */
export const WINDOW_MS = 60_000

/** How many addresses are kept before the expired ones are swept. */
const SWEEP_AT = 1_000

export interface LimiterOptions {
  /** How many failures an address may make in the window. */
  max?: number
  /** The size of the window, in milliseconds. */
  windowMs?: number
  /** The clock of the limiter; the tests give their own. */
  now?: () => number
}

/** The state of an address. */
interface Failure {
  count: number
  /** The moment of the first failure of the window. */
  since: number
}

/** The limiter of the failed authentications. */
export class FailedAuthenticationLimiter {
  private readonly failures = new Map<string, Failure>()
  private readonly max: number
  private readonly windowMs: number
  private readonly now: () => number

  constructor(options: LimiterOptions = {}) {
    this.max = options.max ?? MAX_FAILURES
    this.windowMs = options.windowMs ?? WINDOW_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Records a failed authentication.
   *
   * It answers whether the address may try again, and how long it has to
   * wait when it may not.
   */
  fail(address: string): { allowed: boolean; retryAfterMs: number } {
    const now = this.now()
    this.sweep(now)
    const failure = this.failures.get(address)
    if (!failure || now - failure.since >= this.windowMs) {
      this.failures.set(address, { count: 1, since: now })
      return { allowed: true, retryAfterMs: 0 }
    }
    failure.count += 1
    if (failure.count <= this.max) return { allowed: true, retryAfterMs: 0 }
    return { allowed: false, retryAfterMs: this.windowMs - (now - failure.since) }
  }

  /**
   * Reports whether an address used up its budget.
   *
   * An address that is blocked is refused whatever it presents: the
   * limiter protects the token, and a caller that hammers the endpoint is
   * not a caller that knows the token.
   */
  blocked(address: string): boolean {
    return this.count(address) >= this.max
  }

  /** Clears the failures of an address: it authenticated itself. */
  succeed(address: string): void {
    this.failures.delete(address)
  }

  /** How long an address has to wait before it may try again. */
  retryAfterMs(address: string): number {
    const failure = this.failures.get(address)
    if (!failure) return 0
    return Math.max(0, this.windowMs - (this.now() - failure.since))
  }

  /** The number of failures of an address in the window. */
  count(address: string): number {
    const failure = this.failures.get(address)
    if (!failure) return 0
    if (this.now() - failure.since >= this.windowMs) return 0
    return failure.count
  }

  /** Drops the addresses whose window is over. */
  private sweep(now: number): void {
    if (this.failures.size < SWEEP_AT) return
    for (const [address, failure] of this.failures) {
      if (now - failure.since >= this.windowMs) this.failures.delete(address)
    }
  }
}
