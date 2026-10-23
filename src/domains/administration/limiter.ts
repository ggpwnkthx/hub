/**
 * The limiter of the administration (spec §10.1).
 *
 * The administrative endpoints are guarded by a bearer token, and a token
 * that is guessed by hammering the endpoint is a token that is found. The
 * limiter counts the failed authentications of an address: a burst of them
 * is refused with `429`, and a success clears the count of the address.
 *
 * The budget of an address is spent by the calls that **fail**. A call
 * that presents the right token is answered, whatever the address
 * presented before: an address that used up its budget cannot lock out
 * the operator that holds the token.
 *
 * The count is held by the **shared store** of the deployment, so the
 * window of the limiter is the window of the deployment and not the
 * window of a replica: a deployment of several replicas does not accept
 * five times the budget. A deployment that keeps its state in the
 * process — a single node — counts in the memory of the process, and
 * that count is the count of the deployment.
 *
 * The domain owns the rule — how many failures, in which window — and
 * the platform holds the count: the storage is a port.
 */

/** How many failures an address may make in the window. */
const MAX_FAILURES = 5

/** The size of the window, in milliseconds. */
const WINDOW_MS = 60_000

/**
 * The count of the failures of an address, and the window that is left.
 */
export interface FailureCount {
  /** The number of failures in the window. */
  count: number
  /** The time that is left of the window, in milliseconds. */
  retryAfterMs: number
}

/**
 * The storage of the failures of the authentication.
 *
 * The port of the limiter: the domain asks it to count, and it answers
 * the count of the window and the time that is left of it.
 */
export interface AuthenticationFailures {
  /**
   * Counts a failure of the address.
   *
   * The window of the address starts at its first failure and lasts
   * `windowMs`.
   */
  fail(address: string, windowMs: number): Promise<FailureCount>
  /**
   * The count of the failures of the address in the window, and the time
   * that is left of it.
   */
  count(address: string, windowMs: number): Promise<FailureCount>
  /** Clears the count of the address: it authenticated itself. */
  succeed(address: string): Promise<void>
}

export interface LimiterOptions {
  /** How many failures an address may make in the window. */
  max?: number
  /** The size of the window, in milliseconds. */
  windowMs?: number
}

/**
 * The limiter of the failed authentications.
 *
 * The rule is the same whatever holds the count: five failures of an
 * address in a minute, and the address is refused whatever it presents
 * until the window is over.
 */
export class FailedAuthenticationLimiter {
  private readonly failures: AuthenticationFailures
  private readonly max: number
  private readonly windowMs: number

  constructor(failures: AuthenticationFailures, options: LimiterOptions = {}) {
    this.failures = failures
    this.max = options.max ?? MAX_FAILURES
    this.windowMs = options.windowMs ?? WINDOW_MS
  }

  /**
   * Records a failed authentication.
   *
   * It answers whether the address may try again, and how long it has to
   * wait when it may not.
   */
  async fail(address: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const count = await this.failures.fail(address, this.windowMs)
    if (count.count <= this.max) return { allowed: true, retryAfterMs: 0 }
    return { allowed: false, retryAfterMs: count.retryAfterMs }
  }

  /**
   * Reports whether an address used up its budget.
   *
   * The budget of an address is spent by the calls that fail to
   * authenticate. A call that authenticates itself is never refused by
   * the limiter: the limiter protects the token, and it does not lock out
   * the operator that holds it.
   */
  async blocked(address: string): Promise<{ blocked: boolean; retryAfterMs: number }> {
    const count = await this.failures.count(address, this.windowMs)
    return { blocked: count.count >= this.max, retryAfterMs: count.retryAfterMs }
  }

  /** Clears the failures of an address: it authenticated itself. */
  async succeed(address: string): Promise<void> {
    await this.failures.succeed(address)
  }

  /** The number of failures of an address in the window. */
  async count(address: string): Promise<number> {
    return (await this.failures.count(address, this.windowMs)).count
  }
}
