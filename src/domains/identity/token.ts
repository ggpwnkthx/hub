/**
 * The validation of the token of a provider (spec §6.1).
 *
 * Before a single row is read, the token of the provider is validated: the
 * issuer, the audience, the nonce, the algorithm, the clock and the
 * subject. A token that does not pass every check is refused: Hub never
 * authenticates a caller against a provider that is not the one of the
 * tenant.
 */

/** The failure of the validation of an identity. */
export class IdentityError extends Error {
  constructor(
    /** The code of the failure. */
    readonly code: 'identity_rejected' | 'identity_unknown' | 'principal_disabled',
    message: string
  ) {
    super(message)
    this.name = 'IdentityError'
  }
}

/** The claims of the token of a provider. */
export interface ProviderToken {
  /** The issuer of the token. */
  issuer?: string
  /** The audience of the token. */
  audience?: string | string[]
  /** The authorized party of the token. */
  authorizedParty?: string
  /** The subject of the token. */
  subject?: string
  /** The nonce of the login. */
  nonce?: string
  /** The algorithm that signed the token. */
  algorithm?: string
  /** The moment the token expires, in seconds. */
  expiresAt?: number
  /** The moment the token was issued, in seconds. */
  issuedAt?: number
  /** The e-mail of the caller. */
  email?: string
  /** The name of the caller. */
  name?: string
}

export interface ValidationOptions {
  /** The claims of the token. */
  token: ProviderToken
  /** The issuer of the provider of the tenant: the comparison is exact. */
  expectedIssuer: string
  /** The client id of Hub at the provider of the tenant. */
  expectedAudience: string
  /** The nonce of the login in flight. */
  expectedNonce?: string
  /** The algorithms a token of the tenant may be signed with. */
  allowedAlgorithms: string[]
  /** The tolerance of the clock, in seconds. */
  skewSeconds: number
  /** The moment of the validation, in seconds. */
  now?: number
}

/** The identity that a token of a provider carries. */
export interface ValidatedIdentity {
  /** The subject of the provider: the key of the mapping. */
  subject: string
  /** The e-mail of the caller, when the provider publishes one. */
  email?: string
  /** The name of the caller, when the provider publishes one. */
  name?: string
}

/**
 * Validates the token of a provider.
 *
 * The failure is a refusal: the reason is in the log of the service and
 * never in the answer of the browser.
 */
export function validateProviderToken(options: ValidationOptions): ValidatedIdentity {
  const token = options.token
  const now = options.now ?? Math.floor(Date.now() / 1000)

  // The issuer is exactly the one of the tenant: a comparison that
  // ignores the case or the trailing slash is not allowed.
  if (token.issuer !== options.expectedIssuer) {
    throw new IdentityError(
      'identity_rejected',
      'the issuer of the token is not the one of the tenant'
    )
  }

  // The algorithm is one of the ones of the tenant, and `none` is never
  // one of them.
  const algorithm = token.algorithm ?? ''
  if (!options.allowedAlgorithms.includes(algorithm) || algorithm.toLowerCase() === 'none') {
    throw new IdentityError(
      'identity_rejected',
      'the token is not signed with an allowed algorithm'
    )
  }

  // The audience carries the client id of Hub at the provider, or the
  // authorized party is that client id.
  const audiences = Array.isArray(token.audience)
    ? token.audience
    : token.audience
      ? [token.audience]
      : []
  const audienceOk =
    audiences.includes(options.expectedAudience) ||
    token.authorizedParty === options.expectedAudience
  if (!audienceOk) {
    throw new IdentityError('identity_rejected', 'the token is not for the client of the tenant')
  }

  // The nonce is the nonce of the login in flight.
  if (options.expectedNonce !== undefined && token.nonce !== options.expectedNonce) {
    throw new IdentityError(
      'identity_rejected',
      'the nonce of the token is not the one of the login'
    )
  }

  // The clock of the token, with the tolerance of the deployment.
  const skew = options.skewSeconds
  if (typeof token.expiresAt === 'number' && token.expiresAt + skew < now) {
    throw new IdentityError('identity_rejected', 'the token has expired')
  }
  if (typeof token.issuedAt === 'number' && token.issuedAt - skew > now) {
    throw new IdentityError('identity_rejected', 'the token is not issued yet')
  }

  // The subject is the key of the mapping: it is present and it is not
  // empty.
  if (!token.subject || token.subject.length === 0) {
    throw new IdentityError('identity_rejected', 'the token has no subject')
  }

  return {
    subject: token.subject,
    ...(token.email ? { email: token.email } : {}),
    ...(token.name ? { name: token.name } : {}),
  }
}
