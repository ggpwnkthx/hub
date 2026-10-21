/**
 * The exchange of a code for the tokens (spec §5.5, §6).
 *
 * The code is single use and it is bound to the client, to the redirect
 * uri and to the challenge of the PKCE. An exchange that presents another
 * redirect uri, another client or a verifier that does not match the
 * challenge is an `invalid_grant`.
 */

import { createHash } from 'node:crypto'
import type { CodeRecord, CodeStore } from './code'
import { aCode, CODE_TTL_SECONDS, hashOf } from './code'
import type { TokenPair } from './tokens'

/** The failure of an exchange. */
export class ExchangeError extends Error {
  constructor(
    /** The code of the failure, as the protocol of the tokens names it. */
    readonly code: 'invalid_request' | 'invalid_client' | 'invalid_grant',
    message: string
  ) {
    super(message)
    this.name = 'ExchangeError'
  }
}

/** The principal of a login, as the exchange knows it. */
export interface PrincipalOfLogin {
  id: string
  email: string | null
  displayName: string | null
  /** The slug of the tenant of the principal. */
  tenantSlug: string
  /** The status of the principal. */
  status: 'active' | 'disabled'
}

/** The storage of the principals. */
export interface PrincipalLookup {
  /** The principal of an id. */
  findById: (id: string) => Promise<PrincipalOfLogin | null>
}

/** The issuer of the tokens. */
export interface TokenIssuer {
  /** Issues the tokens of a principal. */
  issueTokens: (subject: {
    subject: string
    tenant: string
    audience: string
    email?: string | null
    displayName?: string | null
    nonce?: string | null
    scopes: string[]
  }) => Promise<TokenPair>
}

/** The service of the codes. */
export class CodeService {
  constructor(
    private readonly options: {
      /** The store of the codes. */
      store: CodeStore
      /** The storage of the principals. */
      principals: PrincipalLookup
      /** The issuer of the tokens. */
      tokens: TokenIssuer
    }
  ) {}

  /**
   * Issues a code for a completed login.
   *
   * The code is an opaque random string: it carries nothing about the
   * principal and it is stored under a hash of itself.
   */
  async issue(options: {
    clientId: string
    redirectUri: string
    codeChallenge?: string
    subject: string
    tenant: string
    audience: string
    scopes: string[]
  }): Promise<string> {
    const code = aCode()
    const record: CodeRecord = {
      clientId: options.clientId,
      redirectUri: options.redirectUri,
      codeChallenge: options.codeChallenge,
      subject: options.subject,
      tenant: options.tenant,
      audience: options.audience,
      scopes: options.scopes,
      createdAt: Date.now(),
    }
    await this.options.store.put(hashOf(code), record, CODE_TTL_SECONDS)
    return code
  }

  /**
   * Exchanges a code for the tokens.
   *
   * The code is taken from the store: taking it deletes it, so the second
   * exchange of the same code finds nothing.
   */
  async exchange(options: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier?: string
  }): Promise<TokenPair> {
    const record = await this.options.store.take(hashOf(options.code))
    if (!record) {
      throw new ExchangeError('invalid_grant', 'the code is unknown, it is used or it has expired')
    }
    if (record.clientId !== options.clientId) {
      throw new ExchangeError('invalid_grant', 'the code was not issued to this client')
    }
    if (record.redirectUri !== options.redirectUri) {
      throw new ExchangeError('invalid_grant', 'the code was not issued for this redirect uri')
    }
    if (record.codeChallenge) {
      const verifier = options.codeVerifier
      if (!verifier) {
        throw new ExchangeError('invalid_grant', 'the verifier of the challenge is required')
      }
      const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
      if (challenge !== record.codeChallenge) {
        throw new ExchangeError('invalid_grant', 'the verifier does not match the challenge')
      }
    }

    const principal = await this.options.principals.findById(record.subject)
    if (!principal) {
      throw new ExchangeError('invalid_grant', 'the principal of the code does not exist')
    }
    if (principal.status === 'disabled') {
      throw new ExchangeError('invalid_grant', 'the principal is disabled')
    }

    return await this.options.tokens.issueTokens({
      subject: principal.id,
      tenant: principal.tenantSlug,
      audience: record.audience,
      email: principal.email,
      displayName: principal.displayName,
      scopes: record.scopes,
    })
  }
}
