/**
 * The tenant of a login (spec §5.2).
 *
 * The tenant of a login is resolved in this order: the client of the
 * request, the parameter of the tenant, the hint of the e-mail and the
 * tenant that is the default. The parameter and the hint are only usable
 * when the tenant of the client is shared: a shared client is a
 * deliberate weakening and it is refused by default.
 */

/** The tenant of a login, as the identity domain knows it. */
export interface TenantOfLogin {
  id: string
  slug: string
  enabled: boolean
  sharedClient: boolean
  isDefault: boolean
  /** Whether an unknown external identity creates a principal row. */
  autoProvision: boolean
  /** The issuer of the provider of the tenant. */
  issuer: string
  /** The client id of Hub at the provider of the tenant. */
  idpClientId: string
  /** The url of Hub at the provider of the tenant. */
  idpRedirectUri: string
  /** The domain of the tenant; a hint, never an authorization. */
  emailDomain: string | null
  /** The client id of the gateway of the tenant. */
  clientId: string
  /** The scopes Hub asks the provider for. */
  scopes: string[]
  /** The algorithms a token of the tenant may be signed with. */
  algorithms: string[]
}

/** The request of an authorization, as the resolution reads it. */
export interface AuthorizationRequest {
  /** The client id of the request. */
  clientId: string
  /** The tenant that the request names, when it names one. */
  tenant?: string
  /** The hint of the caller, when there is one. */
  loginHint?: string
}

/** The failure of the resolution of a tenant. */
export class TenantResolutionError extends Error {
  constructor(
    /** The code of the failure. */
    readonly code: 'invalid_request' | 'tenant_disabled',
    message: string
  ) {
    super(message)
    this.name = 'TenantResolutionError'
  }
}

/** The storage of the tenants of the identity. */
export interface TenantLookup {
  /** The tenant of a client id of a gateway. */
  findByClientId(clientId: string): Promise<TenantOfLogin | null>
  /** The tenant of a slug. */
  findBySlug(slug: string): Promise<TenantOfLogin | null>
  /** The tenant of a domain of the e-mail. */
  findByEmailDomain(emailDomain: string): Promise<TenantOfLogin | null>
  /** The tenant that is the default of the platform. */
  findDefault(): Promise<TenantOfLogin | null>
}

/**
 * Resolves the tenant of a login.
 *
 * The first match wins. A client that names no tenant is an
 * `invalid_request` and a tenant that is disabled is a
 * `tenant_disabled`.
 */
export async function resolveTenant(
  lookup: TenantLookup,
  request: AuthorizationRequest
): Promise<TenantOfLogin> {
  const client = await lookup.findByClientId(request.clientId)
  if (!client) {
    throw new TenantResolutionError(
      'invalid_request',
      'the client id of the request names no tenant of the platform'
    )
  }

  let tenant = client

  // The parameter of the tenant and the hint are only usable when the
  // client is shared: a parameter that a caller controls may not move a
  // login to another tenant.
  if (client.sharedClient) {
    if (request.tenant) {
      const named = await lookup.findBySlug(request.tenant)
      if (!named) {
        throw new TenantResolutionError(
          'invalid_request',
          'the tenant of the request does not exist'
        )
      }
      tenant = named
    } else if (request.loginHint) {
      const domain = domainOf(request.loginHint)
      if (domain) {
        const hinted = await lookup.findByEmailDomain(domain)
        if (hinted) tenant = hinted
      }
    } else {
      const fallback = await lookup.findDefault()
      if (fallback) tenant = fallback
    }
  }

  if (!tenant.enabled) {
    throw new TenantResolutionError('tenant_disabled', 'the tenant of the login is disabled')
  }
  return tenant
}

/** The domain of an e-mail, when the value is one. */
export function domainOf(hint: string): string | null {
  const at = hint.lastIndexOf('@')
  if (at <= 0 || at === hint.length - 1) return null
  return hint.slice(at + 1).toLowerCase()
}
