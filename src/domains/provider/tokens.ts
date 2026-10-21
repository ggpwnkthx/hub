/**
 * The tokens of Hub (spec §7).
 *
 * Hub is the provider of the gateway: the tokens it issues are ordinary
 * OpenID Connect tokens. The gateway reads `sub`, `email` and `roles` and
 * nothing else, so the claims below are the whole contract with the
 * gateway.
 */

import type { SigningKeys } from './keys'

/** The life of a token of Hub, in seconds. */
export const TOKEN_LIFE_SECONDS = 300

/** The number of roles of a token. */
export const MAX_ROLES = 64

/** The subject of a token: the principal and the tenant it belongs to. */
export interface TokenSubject {
  /** The id of the principal. */
  subject: string
  /** The slug of the tenant of the principal. */
  tenant: string
  /** The client id of the gateway of the tenant. */
  audience: string
  /** The e-mail of the principal, when it is known. */
  email?: string | null
  /** The name of the principal, when it is known. */
  displayName?: string | null
  /** The nonce of the login, when there was one. */
  nonce?: string | null
  /** The scopes of the request. */
  scopes: string[]
}

/** The pair of tokens of an exchange. */
export interface TokenPair {
  /** The id token of the principal. */
  idToken: string
  /** The access token of the principal. */
  accessToken: string
  /** The life of the tokens, in seconds. */
  expiresIn: number
  /** The type of the access token. */
  tokenType: 'Bearer'
}

export interface IssueOptions {
  /** The keys of the service. */
  keys: SigningKeys
  /** The issuer of the service. */
  issuer: string
  /** The principal of the tokens. */
  subject: TokenSubject
  /** The roles of the principal: the snapshot of its live grants. */
  roles: string[]
  /** The moment the tokens are issued, in seconds. */
  now?: number
}

/**
 * The roles claim of a token (spec §7.3).
 *
 * The list is the keys of the permissions of the live grants of the
 * principal: not revoked, not expired, with an enabled permission. It is
 * sorted and it is capped: a principal with more permissions than that
 * gets the first ones, and the count of the rest is in the log.
 */
export function rolesClaim(roles: string[]): { roles: string[]; dropped: number } {
  const sorted = [...new Set(roles)].sort()
  if (sorted.length <= MAX_ROLES) return { roles: sorted, dropped: 0 }
  return { roles: sorted.slice(0, MAX_ROLES), dropped: sorted.length - MAX_ROLES }
}

/**
 * Issues the id token and the access token of a principal.
 *
 * The id token carries the claims of the specification (§7.1) and the
 * access token is a JWT with the issuer, the audience, the subject and
 * the scope (§7.2). There is no refresh token: the gateway does not use
 * one and a refresh token is a credential that has to be revoked, stored
 * and rotated.
 */
export async function issueTokens(options: IssueOptions): Promise<TokenPair> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const { roles } = rolesClaim(options.roles)
  const subject = options.subject

  const idToken = await options.keys.sign({
    iss: options.issuer,
    sub: subject.subject,
    aud: subject.audience,
    exp: now + TOKEN_LIFE_SECONDS,
    iat: now,
    ...(subject.nonce ? { nonce: subject.nonce } : {}),
    ...(subject.email ? { email: subject.email } : {}),
    ...(subject.displayName ? { name: subject.displayName } : {}),
    roles,
    tid: subject.tenant,
    // Hub does not verify the e-mail of a provider.
    email_verified: false,
  })

  const accessToken = await options.keys.sign({
    iss: options.issuer,
    sub: subject.subject,
    aud: subject.audience,
    exp: now + TOKEN_LIFE_SECONDS,
    iat: now,
    scope: subject.scopes.join(' '),
    roles,
    tid: subject.tenant,
  })

  return { idToken, accessToken, expiresIn: TOKEN_LIFE_SECONDS, tokenType: 'Bearer' }
}
