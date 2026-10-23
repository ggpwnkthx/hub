/**
 * The failures of the administration (spec §10.1).
 *
 * The codes are the ones of the specification: the caller of the
 * administration is an operator with a `curl`, and the code is what a
 * script reads.
 */

/** The codes of the failures of the administration. */
const ERROR_CODES = [
  'unauthorized',
  'invalid_request',
  'not_found',
  'conflict',
  'forbidden',
  'too_many_requests',
  'service_unavailable',
] as const

/** The code of a failure. */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** The status of a failure. */
const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  forbidden: 403,
  too_many_requests: 429,
  service_unavailable: 503,
}

/** A failure of the administration. */
export class AdministrationError extends Error {
  constructor(
    /** The code of the failure. */
    readonly code: ErrorCode,
    message: string,
    /** How long the caller has to wait, when the failure is a rate limit. */
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'AdministrationError'
  }

  /** The status of the answer of the failure. */
  get status(): number {
    return STATUS[this.code]
  }
}
