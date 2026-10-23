/**
 * The provider of Hub (spec §7).
 *
 * The domain owns the protocol that the gateway speaks: the JWKS, the
 * discovery document, the tokens and the claims of the userinfo. The
 * signing key comes from the environment and the roles of a principal
 * come from the table of the grants.
 */

import { createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { discoveryDocument, type DiscoveryDocument } from './discovery'
import { jwksOf, loadSigningKeys, type SigningKeys } from './keys'
import { issueTokens, rolesClaim, type TokenPair, type TokenSubject } from './tokens'

/** The storage of the roles of a principal. */
interface RoleStore {
  /** The keys of the permissions of the live grants of the principal. */
  roleKeys(userId: string): Promise<string[]>
}

/** The storage of the principals. */
interface PrincipalStore {
  /** The principal of an id. */
  findById(id: string): Promise<{
    id: string
    email: string | null
    displayName: string | null
    status: 'active' | 'disabled'
  } | null>
}

/** The storage of the clients of the platform. */
interface AudienceStore {
  /** True when the client id names a gateway of the platform. */
  isKnown(clientId: string): Promise<boolean>
}

/** The claims of the userinfo endpoint. */
export interface UserinfoClaims {
  sub: string
  email?: string
  name?: string
  roles: string[]
}

/** The storage of the principals. */
interface PrincipalStore {
  /** The principal of an id. */
  findById(id: string): Promise<{
    id: string
    email: string | null
    displayName: string | null
    status: 'active' | 'disabled'
  } | null>
}

export interface ProviderOptions {
  /** The private key of the service, in PEM. */
  signingKey?: string
  /** The identifier of the key in the JWKS. */
  signingKid?: string
  /** The private key of the previous rotation, in PEM. */
  previousSigningKey?: string
  /** The identifier of the previous key in the JWKS. */
  previousSigningKid?: string
  /** The issuer of the service. */
  issuer: string
  /** The public url of the service. */
  publicUrl: string
  /** The storage of the roles of a principal. */
  roles: RoleStore
  /** The storage of the principals. */
  principals: PrincipalStore
  /** The storage of the clients of the platform. */
  audiences: AudienceStore
  /** The number of roles that were left out of a token, in the log. */
  onRolesDropped?: (count: number, subject: string) => void
}

/** The provider of the gateway. */
export class ProviderService {
  /** The keys of the service; null when the deployment has no key. */
  private keys: SigningKeys | null = null

  constructor(private readonly options: ProviderOptions) {}

  /**
   * Loads the keys of the service.
   *
   * The loading is asynchronous because the key is read from the
   * environment and it has to be validated before the service issues a
   * token.
   */
  async load(): Promise<void> {
    const keys = await loadSigningKeys({
      key: this.options.signingKey,
      kid: this.options.signingKid,
      previousKey: this.options.previousSigningKey,
      previousKid: this.options.previousSigningKid,
    })
    this.keys = keys
  }

  /** True when the service can issue a token. */
  get ready(): boolean {
    return this.keys !== null
  }

  /** The JWKS of the service. */
  async jwks(): Promise<{ keys: unknown[] }> {
    if (!this.keys) return { keys: [] }
    return jwksOf(this.keys)
  }

  /** The discovery document of the service. */
  async discovery(): Promise<DiscoveryDocument> {
    return discoveryDocument({ issuer: this.options.issuer, publicUrl: this.options.publicUrl })
  }

  /**
   * Issues the tokens of a principal.
   *
   * The roles of the token are the live grants of the principal: a
   * snapshot that the upstreams read and that the decision never reads.
   */
  async issueTokens(subject: TokenSubject): Promise<TokenPair> {
    if (!this.keys) {
      throw new Error('the service cannot issue a token: it has no signing key')
    }
    const keys = await this.options.roles.roleKeys(subject.subject)
    const { dropped } = rolesClaim(keys)
    if (dropped > 0) {
      this.options.onRolesDropped?.(dropped, subject.subject)
    }
    return await issueTokens({
      keys: this.keys,
      issuer: this.options.issuer,
      subject,
      roles: keys,
    })
  }

  /**
   * The claims of the userinfo endpoint.
   *
   * A token that is expired, that is signed with another key or that
   * belongs to another audience is refused: the answer is null and the
   * endpoint answers 401.
   */
  async userinfo(token: string): Promise<UserinfoClaims | null> {
    if (!this.keys) return null
    let payload: JWTPayload
    try {
      // The JWKS is the set of the published keys: a token that is signed
      // with another key is not a token of the service.
      const verified = await jwtVerify(token, createLocalJWKSet(jwksOf(this.keys)), {
        issuer: this.options.issuer,
      })
      payload = verified.payload
    } catch {
      return null
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null

    const audience = payload.aud
    const clientId = Array.isArray(audience) ? audience[0] : audience
    if (typeof clientId !== 'string' || !(await this.options.audiences.isKnown(clientId))) {
      return null
    }

    // The claims of the principal are read live: the e-mail and the name
    // are the ones of the row and the roles are the ones of its live
    // grants.
    const principal = await this.options.principals.findById(payload.sub)
    if (!principal) return null
    const roles = await this.options.roles.roleKeys(payload.sub)
    return {
      sub: principal.id,
      ...(principal.email ? { email: principal.email } : {}),
      ...(principal.displayName ? { name: principal.displayName } : {}),
      roles: rolesClaim(roles).roles,
    }
  }
}
