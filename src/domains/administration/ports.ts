/**
 * The ports of the administration.
 *
 * The domain owns the rules of the five endpoints; the storage is a port
 * that the composition root fulfils. The domain knows nothing about
 * PostgreSQL and nothing about the shape of the rows.
 */

/** A tenant of the platform, as the administration knows it. */
export interface Tenant {
  id: string
  slug: string
  displayName: string
  /** The issuer of the provider of the tenant. */
  issuer: string
  emailDomain: string | null
  /** The client id of the gateway of the tenant at Hub. */
  clientId: string
  autoProvision: boolean
  sharedClient: boolean
  isDefault: boolean
  enabled: boolean
  createdAt: Date
}

/** A tenant with the numbers of its principals and of its grants. */
export interface TenantSummary extends Tenant {
  userCount: number
  grantCount: number
}

/** The registration of a tenant, in clear. */
export interface TenantRegistration {
  slug: string
  displayName: string
  issuer: string
  idpClientId: string
  /** The client secret of Hub at the provider, in clear. */
  idpClientSecret: string
  idpRedirectUri: string
  idpScopes: string[]
  idpAlgorithms: string[]
  emailDomain: string | null
  clientId: string
  /** The secret of the gateway of the tenant, in clear. */
  clientSecret: string
  autoProvision: boolean
  sharedClient: boolean
  isDefault: boolean
  enabled: boolean
}

/** The status of a principal. */
export type PrincipalStatus = 'active' | 'disabled'

/** A principal of a tenant. */
export interface Principal {
  id: string
  /** The slug of the tenant of the principal. */
  tenant: string
  /** The `sub` of the provider of the tenant. */
  externalSubject: string
  email: string | null
  displayName: string | null
  status: PrincipalStatus
  lastLoginAt: Date | null
  createdAt: Date
}

/** The registration of a principal. */
export interface PrincipalRegistration {
  /** The slug of the tenant of the principal. */
  tenant: string
  externalSubject: string
  email?: string | null
  displayName?: string | null
  status?: PrincipalStatus
}

/** A permission of the platform. */
export interface Permission {
  id: string
  /** The tenant that owns the permission, or null for the catalogue. */
  tenantId: string | null
  key: string
  description: string | null
  enabled: boolean
}

/** A grant of the policy. */
export interface Grant {
  id: string
  /** The slug of the tenant of the grant. */
  tenant: string
  userId: string
  /** The key of the permission of the grant. */
  permission: string
  workspaceId: string | null
  routeId: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

/** The registration of a grant. */
export interface GrantRegistration {
  /** The slug of the tenant of the grant. */
  tenant: string
  userId: string
  /** The key of the permission of the grant. */
  permission: string
  workspaceId?: string | null
  routeId?: string | null
  expiresAt?: Date | null
  grantedBy?: string | null
}

/** The storage of the tenants. */
export interface TenantStore {
  /** The tenant of a slug: the slug is the key of the row. */
  findBySlug(slug: string): Promise<Tenant | null>
  /** The tenant of a client id of a gateway. */
  findByClientId(clientId: string): Promise<Tenant | null>
  /** The tenants of the platform, with their numbers. */
  list(): Promise<TenantSummary[]>
  /** Creates a tenant. */
  create(registration: TenantRegistration): Promise<Tenant>
  /** Changes a tenant. */
  update(id: string, registration: Partial<TenantRegistration>): Promise<Tenant | null>
}

/** The storage of the principals. */
export interface PrincipalStore {
  /** The principal of an id. */
  findById(id: string): Promise<Principal | null>
  /** The principal of an external identity of a tenant. */
  findByExternalSubject(tenantId: string, externalSubject: string): Promise<Principal | null>
  /** Creates a principal. */
  create(registration: {
    tenantId: string
    externalSubject: string
    email?: string | null
    displayName?: string | null
    status?: PrincipalStatus
  }): Promise<Principal>
  /** Changes a principal. */
  update(
    id: string,
    changes: { email?: string | null; displayName?: string | null; status?: PrincipalStatus }
  ): Promise<Principal | null>
}

/** The storage of the permissions. */
export interface PermissionStore {
  /** The permission of the catalogue of the platform. */
  findCataloguePermission(key: string): Promise<Permission | null>
  /** The permission of a tenant. */
  findByTenantAndKey(tenantId: string, key: string): Promise<Permission | null>
  /** The permission of a key, whatever the tenant that owns it. */
  findByKey(key: string): Promise<Permission | null>
  /** Creates a permission. */
  create(registration: { tenantId: string | null; key: string }): Promise<Permission>
}

/** The storage of the grants. */
export interface GrantStore {
  /** The grant of an id. */
  findById(id: string): Promise<Grant | null>
  /** The live grant of a scope. */
  findLive(
    tenantId: string,
    userId: string,
    permissionId: string,
    workspaceId: string | null,
    routeId: string | null
  ): Promise<Grant | null>
  /** Creates a grant. */
  create(registration: {
    tenantId: string
    userId: string
    permissionId: string
    workspaceId: string | null
    routeId: string | null
    expiresAt: Date | null
    grantedBy: string | null
  }): Promise<Grant>
  /** Changes the expiry of a grant. */
  update(
    id: string,
    changes: { expiresAt?: Date | null; grantedBy?: string | null }
  ): Promise<Grant | null>
  /** Revokes a grant: the row is kept and stamped. */
  revoke(id: string): Promise<Grant | null>
}
