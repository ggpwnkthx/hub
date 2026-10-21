/**
 * The login of a caller (spec §5.4).
 *
 * The browser logs in at the provider of a tenant and comes back with a
 * principal. The service owns the two halves of the flow: it starts the
 * login and it finishes it.
 */

import { createHash, createHmac } from 'node:crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { IdentityError, validateProviderToken } from './token'
import { ProviderError, type ProviderClient } from './provider-client'
import {
  mapIdentity,
  MappingError,
  type Mapping,
  type Principal,
  type PrincipalLookup,
} from './mapping'
import {
  aNonce,
  aVerifier,
  createStateCipher,
  isAlive,
  LoginStateError,
  type LoginState,
  type StateCipher,
} from './state'
import {
  resolveTenant,
  TenantResolutionError,
  type TenantLookup,
  type TenantOfLogin,
} from './tenant'

/** The failure of a login. */
export class LoginError extends Error {
  constructor(
    /** The code of the failure. */
    readonly code:
      | 'invalid_request'
      | 'login_state_invalid'
      | 'identity_rejected'
      | 'identity_unknown'
      | 'principal_disabled'
      | 'tenant_disabled'
      | 'upstream_unavailable',
    message: string
  ) {
    super(message)
    this.name = 'LoginError'
  }
}

/** The request of an authorization. */
export interface AuthorizationRequest {
  clientId: string
  redirectUri: string
  /** The state of the gateway. */
  state: string
  /** The nonce of the gateway. */
  nonce?: string
  /** The scopes of the request. */
  scopes: string[]
  /** The tenant that the request names, when it names one. */
  tenant?: string
  /** The hint of the caller, when there is one. */
  loginHint?: string
  /** The challenge of the PKCE of the gateway, when there is one. */
  codeChallenge?: string
}

/** The beginning of a login. */
export interface BegunLogin {
  /** The url of the provider of the tenant. */
  url: string
  /** The value of the cookie of the state. */
  cookie: string
  /** The slug of the tenant of the login. */
  tenant: string
}

/** The end of a login. */
export interface CompletedLogin {
  principal: Principal
  tenant: TenantOfLogin
  /** The redirect uri of the login. */
  redirectUri: string
  /** The challenge of the PKCE of the gateway, when there is one. */
  codeChallenge?: string
  /** The state of the gateway, to be sent back with the code. */
  state: string
  /** The nonce of the login, when there was one. */
  nonce?: string
  /** The scopes of the request. */
  scopes: string[]
  /** True when the principal was created by this login. */
  created: boolean
}

export interface LoginOptions {
  /** The storage of the tenants. */
  tenants: TenantLookup
  /** The storage of the principals. */
  principals: PrincipalLookup
  /** The cipher of the state of a login. */
  state: StateCipher
  /** The client of the provider of a tenant. */
  clientOf: (tenant: TenantOfLogin) => Promise<ProviderClient>
  /** The secret of the deployment, for the binding of the state. */
  secret: string
  /** How long the clock of the token is tolerated, in seconds. */
  clockSkewSeconds: number
  /** The algorithms that a token of a tenant may be signed with. */
  algorithmsOf: (tenant: TenantOfLogin) => string[]
}

/** The login of the callers. */
export class LoginService {
  constructor(private readonly options: LoginOptions) {}

  /**
   * Starts a login.
   *
   * The tenant of the login is resolved, the state of the login is
   * created and the browser is sent to the provider of the tenant.
   */
  async begin(request: AuthorizationRequest): Promise<BegunLogin> {
    const tenant = await this.resolve(request)
    const verifier = aVerifier()
    const nonce = request.nonce ?? aNonce()
    const state: LoginState = {
      tenant: tenant.slug,
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      state: request.state ?? '',
      nonce,
      verifier,
      scopes: request.scopes,
      ...(request.codeChallenge ? { codeChallenge: request.codeChallenge } : {}),
      startedAt: Date.now(),
    }
    const cookie = this.options.state.encrypt(state)
    const client = await this.options.clientOf(tenant)
    let url: string
    try {
      url = await client.authorizationUrl({
        state: this.providerStateOf(state),
        nonce,
        challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'),
        scopes: request.scopes,
      })
    } catch (error) {
      throw this.refusalOf(error)
    }
    return { url, cookie, tenant: tenant.slug }
  }

  /**
   * Finishes a login.
   *
   * The state cookie is read and deleted, the code is exchanged at the
   * provider, the id token is validated and the external identity is
   * mapped to a principal.
   */
  async complete(options: {
    cookie: string | undefined
    providerState: string
    code: string
  }): Promise<CompletedLogin> {
    if (!options.cookie) {
      throw new LoginError('login_state_invalid', 'the state of the login is missing')
    }
    let state: LoginState
    try {
      state = this.options.state.decrypt(options.cookie)
    } catch (error) {
      if (error instanceof LoginStateError) {
        throw new LoginError('login_state_invalid', 'the state of the login is not readable')
      }
      throw error
    }
    if (!isAlive(state)) {
      throw new LoginError('login_state_invalid', 'the state of the login is too old')
    }
    if (!this.sameProviderState(state, options.providerState)) {
      throw new LoginError('login_state_invalid', 'the state of the provider does not match')
    }

    const tenant = await this.options.tenants.findBySlug(state.tenant)
    if (!tenant) {
      throw new LoginError('login_state_invalid', 'the tenant of the login does not exist')
    }
    if (!tenant.enabled) {
      throw new LoginError('tenant_disabled', 'the tenant of the login is disabled')
    }

    const client = await this.options.clientOf(tenant)
    let idToken: string
    try {
      idToken = await client.exchange({ code: options.code, verifier: state.verifier })
    } catch (error) {
      if (error instanceof ProviderError) {
        throw this.refusalOf(error)
      }
      throw error
    }

    const identity = await this.validate(tenant, idToken, state.nonce)

    let mapping: Mapping
    try {
      mapping = await mapIdentity(this.options.principals, tenant, identity)
    } catch (error) {
      if (error instanceof MappingError) {
        throw new LoginError(error.code, error.message)
      }
      if (error instanceof IdentityError) {
        throw new LoginError('identity_rejected', 'the identity was refused')
      }
      throw error
    }

    return {
      principal: mapping.principal,
      tenant,
      redirectUri: state.redirectUri,
      ...(state.codeChallenge ? { codeChallenge: state.codeChallenge } : {}),
      state: state.state,
      nonce: state.nonce,
      scopes: state.scopes,
      created: mapping.created,
    }
  }

  /**
   * The redirect uri of the state of a login.
   *
   * It is read when the provider refuses the login: the answer of the
   * provider is passed to the browser, unchanged, and it goes back to the
   * gateway.
   */
  async redirectUriOf(cookie: string | undefined): Promise<string | null> {
    const state = this.readState(cookie)
    return state?.redirectUri ?? null
  }

  /** The state of the gateway of the state of a login. */
  async stateOf(cookie: string | undefined): Promise<string | null> {
    const state = this.readState(cookie)
    return state?.state ?? null
  }

  /** Reads the state of a login, when it is readable. */
  private readState(cookie: string | undefined): LoginState | null {
    if (!cookie) return null
    try {
      return this.options.state.decrypt(cookie)
    } catch {
      return null
    }
  }

  /** Turns the failure of the provider into a refusal of the login. */
  private refusalOf(error: unknown): LoginError {
    if (error instanceof ProviderError) {
      if (error.code === 'upstream_unavailable') {
        return new LoginError('upstream_unavailable', 'the provider of the tenant is not reachable')
      }
      return new LoginError('identity_rejected', 'the provider of the tenant was refused')
    }
    return error instanceof LoginError
      ? error
      : new LoginError('identity_rejected', 'the provider of the tenant was refused')
  }

  /** Resolves the tenant of a login and turns the failures into refusals. */
  private async resolve(request: AuthorizationRequest): Promise<TenantOfLogin> {
    try {
      return await resolveTenant(this.options.tenants, {
        clientId: request.clientId,
        tenant: request.tenant,
        loginHint: request.loginHint,
      })
    } catch (error) {
      if (error instanceof TenantResolutionError) {
        throw new LoginError(error.code, error.message)
      }
      throw error
    }
  }

  /** Validates the id token of the provider. */
  private async validate(
    tenant: TenantOfLogin,
    idToken: string,
    nonce: string
  ): Promise<{ subject: string; email?: string; name?: string }> {
    const claims = await this.verify(tenant, idToken)
    try {
      return validateProviderToken({
        token: {
          issuer: claims.issuer,
          audience: claims.audience,
          authorizedParty: claims.authorizedParty,
          subject: claims.subject,
          nonce: claims.nonce,
          algorithm: claims.algorithm,
          expiresAt: claims.expiresAt,
          issuedAt: claims.issuedAt,
          email: claims.email,
          name: claims.name,
        },
        expectedIssuer: tenant.issuer,
        expectedAudience: tenant.idpClientId,
        expectedNonce: nonce,
        allowedAlgorithms: this.options.algorithmsOf(tenant),
        skewSeconds: this.options.clockSkewSeconds,
      })
    } catch (error) {
      if (error instanceof IdentityError) {
        throw new LoginError('identity_rejected', 'the token of the provider was refused')
      }
      throw error
    }
  }

  /** Verifies the signature of the id token of the provider. */
  private async verify(
    tenant: TenantOfLogin,
    idToken: string
  ): Promise<{
    issuer?: string
    audience?: string | string[]
    authorizedParty?: string
    subject?: string
    nonce?: string
    algorithm?: string
    expiresAt?: number
    issuedAt?: number
    email?: string
    name?: string
  }> {
    const client = await this.options.clientOf(tenant)
    const jwks = (await client.jwks()) as { keys: [] }
    try {
      const verified = await jwtVerify(idToken, createLocalJWKSet(jwks as { keys: [] }))
      const header = verified.protectedHeader
      const payload = verified.payload
      return {
        issuer: typeof payload.iss === 'string' ? payload.iss : undefined,
        audience: payload.aud as string | string[] | undefined,
        authorizedParty: typeof payload.azp === 'string' ? payload.azp : undefined,
        subject: typeof payload.sub === 'string' ? payload.sub : undefined,
        nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
        algorithm: header.alg,
        expiresAt: typeof payload.exp === 'number' ? payload.exp : undefined,
        issuedAt: typeof payload.iat === 'number' ? payload.iat : undefined,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        name: typeof payload.name === 'string' ? payload.name : undefined,
      }
    } catch {
      throw new LoginError('identity_rejected', 'the token of the provider was refused')
    }
  }

  /**
   * The state of the provider.
   *
   * It is bound to the state cookie: it is derived from the fields of the
   * state and from the secret of the deployment, so it cannot be forged
   * and it does not have to be carried by the cookie.
   */
  private providerStateOf(state: LoginState): string {
    return createHmac('sha256', this.options.secret)
      .update(`${state.tenant}:${state.startedAt}:${state.nonce}`)
      .digest('base64url')
  }

  /** Reports whether the state of the provider is the one of the login. */
  private sameProviderState(state: LoginState, received: string): boolean {
    return this.providerStateOf(state) === received
  }
}

/** Builds the cipher of the state of a login. */
export function stateCipherOf(secret: string): StateCipher {
  return createStateCipher(secret)
}
