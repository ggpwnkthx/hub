/**
 * The administration of Hub (spec §9).
 *
 * Five endpoints, and they are the whole surface of the administration:
 * a tenant, a principal and a grant are created and revoked with them and
 * with nothing else. The service owns the rules; the storage is a port
 * that the composition root fulfils.
 */

import { sameSecret } from '../../observability'
import { AdministrationError } from './errors'
import { FailedAuthenticationLimiter } from './limiter'
import type {
  Grant,
  GrantRegistration,
  GrantStore,
  Permission,
  PermissionStore,
  Principal,
  PrincipalRegistration,
  PrincipalStore,
  Tenant,
  TenantRegistration,
  TenantStore,
  TenantSummary,
} from './ports'

export interface AdministrationOptions {
  /** The storage of the tenants. */
  tenants: TenantStore
  /** The storage of the principals. */
  principals: PrincipalStore
  /** The storage of the permissions. */
  permissions: PermissionStore
  /** The storage of the grants. */
  grants: GrantStore
  /** The bearer token of the administration. */
  token?: string
  /** The public url of Hub, for the default callback of a tenant. */
  publicUrl: string
  /** The limiter of the failed authentications. */
  limiter?: FailedAuthenticationLimiter
}

/**
 * The entry of the audit of a change (spec §9.1).
 *
 * The audit names what changed and the thing that changed: the secrets are
 * never in it.
 */
export interface AuditEntry {
  /** What happened: `tenant.created`, `grant.revoked`, and so on. */
  action: string
  /** The identifier of the thing that changed. */
  id: string
  /** The slug of the tenant, when the change belongs to one. */
  tenant?: string
}

/** The defaults of the registration of a tenant. */
export const DEFAULT_IDP_SCOPES = ['openid', 'email', 'profile']

/** The defaults of the algorithms of a tenant. */
export const DEFAULT_IDP_ALGORITHMS = ['RS256']

/** The administration of Hub. */
export class AdministrationService {
  private readonly limiter: FailedAuthenticationLimiter

  constructor(private readonly options: AdministrationOptions) {
    this.limiter = options.limiter ?? new FailedAuthenticationLimiter()
  }

  /**
   * Authenticates a call of the administration.
   *
   * The token is compared in constant time. A failure is counted: a burst
   * of them is refused with `429`, so the token cannot be guessed by
   * hammering the endpoint.
   */
  authenticate(header: string | undefined, address: string): void {
    const expected = this.options.token
    const match = /^Bearer\s+(.+)$/i.exec((header ?? '').trim())
    const presented = match?.[1]?.trim() ?? ''

    // An address that used up its budget is refused, whatever it
    // presents.
    if (this.limiter.blocked(address)) {
      throw new AdministrationError(
        'too_many_requests',
        'too many failed authentications from this address',
        this.limiter.retryAfterMs(address)
      )
    }

    // A deployment without a token has no administrative surface: every
    // call is refused.
    if (!expected || !presented || !sameSecret(presented, expected)) {
      const failure = this.limiter.fail(address)
      if (!failure.allowed) {
        throw new AdministrationError(
          'too_many_requests',
          'too many failed authentications from this address',
          failure.retryAfterMs
        )
      }
      throw new AdministrationError('unauthorized', 'a valid administration token is required')
    }
    this.limiter.succeed(address)
  }

  /**
   * Creates a tenant, or updates the tenant of that slug.
   *
   * The slug is the key of the row: the call is an upsert. A client id
   * belongs to one tenant and a default belongs to one tenant: both are
   * a conflict.
   */
  async upsertTenant(
    registration: TenantRegistration
  ): Promise<{ tenant: Tenant; created: boolean; audit: AuditEntry }> {
    const existing = await this.options.tenants.findBySlug(registration.slug)

    // A client id belongs to one tenant.
    const owner = await this.options.tenants.findByClientId(registration.clientId)
    if (owner && owner.id !== existing?.id) {
      throw new AdministrationError(
        'conflict',
        'the client id of the gateway belongs to another tenant'
      )
    }

    // At most one tenant is the default.
    if (registration.isDefault) {
      const current = (await this.options.tenants.list()).find((tenant) => tenant.isDefault)
      if (current && current.id !== existing?.id) {
        throw new AdministrationError('conflict', 'another tenant is already the default')
      }
    }

    if (!existing) {
      const tenant = await this.options.tenants.create(registration)
      return {
        tenant,
        created: true,
        audit: { action: 'tenant.created', id: tenant.id, tenant: tenant.slug },
      }
    }

    const tenant = await this.options.tenants.update(existing.id, registration)
    if (!tenant) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }
    return {
      tenant,
      created: false,
      audit: { action: 'tenant.updated', id: tenant.id, tenant: tenant.slug },
    }
  }

  /** The tenants of the platform, with their numbers. */
  async listTenants(): Promise<TenantSummary[]> {
    return await this.options.tenants.list()
  }

  /**
   * Creates a principal, or updates the principal of that
   * `(tenant, externalSubject)` pair.
   */
  async upsertPrincipal(
    registration: PrincipalRegistration
  ): Promise<{ principal: Principal; created: boolean; audit: AuditEntry }> {
    const tenant = await this.options.tenants.findBySlug(registration.tenant)
    if (!tenant) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }

    const existing = await this.options.principals.findByExternalSubject(
      tenant.id,
      registration.externalSubject
    )
    if (!existing) {
      const principal = await this.options.principals.create({
        tenantId: tenant.id,
        externalSubject: registration.externalSubject,
        email: registration.email ?? null,
        displayName: registration.displayName ?? null,
        status: registration.status ?? 'active',
      })
      return {
        principal,
        created: true,
        audit: { action: 'principal.created', id: principal.id, tenant: tenant.slug },
      }
    }

    const principal = await this.options.principals.update(existing.id, {
      email: registration.email,
      displayName: registration.displayName,
      status: registration.status,
    })
    if (!principal) {
      throw new AdministrationError('not_found', 'the principal does not exist')
    }
    return {
      principal,
      created: false,
      audit: { action: 'principal.updated', id: principal.id, tenant: tenant.slug },
    }
  }

  /**
   * Creates a grant, or updates the grant of that
   * `(tenant, user, permission, workspace, route)` tuple.
   *
   * The permission is created on demand in the scope of the tenant. A
   * permission of the catalogue of the platform is reused, and a
   * permission of another tenant is refused.
   */
  async upsertGrant(registration: GrantRegistration): Promise<{ grant: Grant; audit: AuditEntry }> {
    const tenant = await this.options.tenants.findBySlug(registration.tenant)
    if (!tenant) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }

    const principal = await this.options.principals.findById(registration.userId)
    if (!principal) {
      throw new AdministrationError('not_found', 'the principal does not exist')
    }
    if (principal.tenant !== tenant.slug) {
      throw new AdministrationError('forbidden', 'the principal belongs to another tenant')
    }

    const permission = await this.resolvePermission(tenant.id, registration.permission)

    const workspaceId = registration.workspaceId ?? null
    const routeId = registration.routeId ?? null
    const existing = await this.options.grants.findLive(
      tenant.id,
      principal.id,
      permission.id,
      workspaceId,
      routeId
    )
    if (!existing) {
      const grant = await this.options.grants.create({
        tenantId: tenant.id,
        userId: principal.id,
        permissionId: permission.id,
        workspaceId,
        routeId,
        expiresAt: registration.expiresAt ?? null,
        grantedBy: registration.grantedBy ?? null,
      })
      return {
        grant,
        audit: { action: 'grant.created', id: grant.id, tenant: tenant.slug },
      }
    }

    const grant = await this.options.grants.update(existing.id, {
      expiresAt: registration.expiresAt,
      grantedBy: registration.grantedBy,
    })
    if (!grant) {
      throw new AdministrationError('not_found', 'the grant does not exist')
    }
    return {
      grant,
      audit: { action: 'grant.updated', id: grant.id, tenant: tenant.slug },
    }
  }

  /**
   * Revokes a grant.
   *
   * The call is idempotent: a grant that is already revoked answers the
   * same way. A grant that does not exist is a `404`.
   */
  async revokeGrant(id: string): Promise<AuditEntry> {
    const existing = await this.options.grants.findById(id)
    if (!existing) {
      throw new AdministrationError('not_found', 'the grant does not exist')
    }
    await this.options.grants.revoke(id)
    return { action: 'grant.revoked', id, tenant: existing.tenant }
  }

  /**
   * The permission of a grant.
   *
   * The catalogue of the platform is reused, the permission of the tenant
   * is reused, the permission of another tenant is refused and the
   * permission that does not exist is created in the scope of the tenant.
   */
  private async resolvePermission(tenantId: string, key: string): Promise<Permission> {
    const catalogue = await this.options.permissions.findCataloguePermission(key)
    if (catalogue) return catalogue

    const own = await this.options.permissions.findByTenantAndKey(tenantId, key)
    if (own) return own

    const other = await this.options.permissions.findByKey(key)
    if (other) {
      throw new AdministrationError('forbidden', 'the permission belongs to another tenant')
    }

    return await this.options.permissions.create({ tenantId, key })
  }
}
