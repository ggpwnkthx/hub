/**
 * The pieces the application is built with.
 *
 * The application knows the interfaces of the domains and the observation
 * interfaces, never a concrete adapter: the runtime assembles the pieces
 * and hands them over here.
 */

import type { AdministrationService } from '../domains/administration'
import type { AccessContextStore, DecisionStore } from '../domains/authorization'
import type { AccessContextCredential } from './access-context'
import type { AuthorizationRequest, BegunLogin, CompletedLogin } from '../domains/identity'
import type { ProviderService, TokenPair } from '../domains/provider'
import type { Logger, Observer } from '../observability'

/** The login of the callers, as the application sees it. */
export interface LoginPort {
  /** Starts a login. */
  begin: (request: AuthorizationRequest) => Promise<BegunLogin>
  /** Finishes a login. */
  complete: (options: {
    cookie: string | undefined
    providerState: string
    code: string
  }) => Promise<CompletedLogin>
  /** The redirect uri of the state of a login. */
  redirectUriOf: (cookie: string | undefined) => Promise<string | null>
  /** The state of the gateway of the state of a login. */
  stateOf: (cookie: string | undefined) => Promise<string | null>
}

/** The codes of the logins, as the application sees them. */
export interface CodePort {
  /** Issues a code for a completed login. */
  issue: (options: {
    clientId: string
    redirectUri: string
    codeChallenge?: string
    subject: string
    tenant: string
    audience: string
    scopes: string[]
    nonce?: string
  }) => Promise<string>
  /** Exchanges a code for the tokens. */
  exchange: (options: {
    code: string
    clientId: string
    redirectUri: string
    codeVerifier?: string
  }) => Promise<TokenPair>
}

/** The tenants of the platform, as the application sees them. */
export interface TenantPort {
  /** The tenant of a client id of a gateway. */
  findByClientId: (
    clientId: string
  ) => Promise<{ id: string; slug: string; clientId: string; sharedClient: boolean } | null>
  /** The secret of the gateway of a tenant, in clear. */
  gatewaySecret: (tenantId: string) => Promise<string | null>
}

/**
 * The probe of the readiness.
 *
 * The readiness of Hub is the health of its dependencies: the database has
 * to answer and the migrations have to be applied. The port is implemented
 * by the platform of the database, and the runtime hands it over.
 */
export interface ReadinessProbe {
  /** True when the dependencies of the service answer. */
  ready: () => Promise<boolean>
}

/** Everything the application needs to answer a request. */
export interface HubDependencies {
  /** The version of Hub, as the health endpoint reports it. */
  version: string
  /** The logger of the service. */
  logger: Logger
  /** The probe of the readiness. */
  probe: ReadinessProbe
  /** True while the service is draining: it does not accept new work. */
  isDraining: () => boolean
  /** The administration of the platform. */
  administration: AdministrationService
  /** The decision of the gateway. */
  decisions: DecisionStore
  /** The storage of the access context. */
  accessContexts: AccessContextStore
  /** The credentials of the access context contract. */
  accessContextCredentials: AccessContextCredential[]
  /** The provider of the gateway: the JWKS, the discovery and the tokens. */
  provider: ProviderService
  /** The bearer token the gateway presents on the decisions. */
  accessToken?: string
  /** The observer of the service. */
  observer: Observer
  /** The bearer token that guards the metrics endpoint. */
  metricsToken?: string
  /** The login of the callers. */
  login: LoginPort
  /** The codes of the logins. */
  codes: CodePort
  /** The tenants of the platform. */
  tenants: TenantPort
  /** The `Secure` attribute of the cookies of the login. */
  cookieSecure: boolean
  /** The public url of Hub, for the default callback of a tenant. */
  publicUrl: string
  /** The address of the peer of a request: the address of the socket. */
  peerAddress: (request: Request) => string
}
