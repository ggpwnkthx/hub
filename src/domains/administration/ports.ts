/**
 * The ports of the administration.
 *
 * The domain owns the rules of the eight endpoints; the storage is a port
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

/** A group of principals (spec §3.5). */
export interface Group {
  id: string
  /** The slug of the tenant of the group. */
  tenant: string
  /** The name of the group. */
  key: string
  displayName: string | null
  /** The external subjects of the principals of the group. */
  members: string[]
  createdAt: Date
}

/** The registration of a group. */
export interface GroupRegistration {
  /** The slug of the tenant of the group. */
  tenant: string
  /** The name of the group. */
  key: string
  displayName?: string | null
  /** The external subjects of the principals of the group. */
  members: string[]
}

/** A grant of the policy. */
export interface Grant {
  id: string
  /** The slug of the tenant of the grant. */
  tenant: string
  /** The principal of the grant, or null when the grant names a group. */
  userId: string | null
  /** The key of the group of the grant, when it names one. */
  group: string | null
  /** The key of the permission of the grant. */
  permission: string
  workspaceId: string | null
  routeId: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  /** Who granted it, for the audit log. */
  grantedBy: string | null
  createdAt: Date
}

/** The registration of a grant. */
export interface GrantRegistration {
  /** The slug of the tenant of the grant. */
  tenant: string
  /** The id of the principal of the grant, when it names one. */
  userId?: string | null
  /** The key of the group of the grant, when it names one. */
  group?: string | null
  /** The key of the permission of the grant. */
  permission: string
  workspaceId?: string | null
  routeId?: string | null
  expiresAt?: Date | null
  grantedBy?: string | null
}

/** The filter of the list of the principals. */
export interface PrincipalFilter {
  /** The id of the tenant, or null for every tenant. */
  tenantId: string | null
  /** The status of the principals, or null for every status. */
  status: PrincipalStatus | null
  /** The exact e-mail of the principals, or null for every one. */
  email: string | null
  /** The size of the page. */
  limit: number
  /** The number of rows that are skipped. */
  offset: number
}

/** A page of principals and the number of the principals that match. */
export interface PrincipalPage {
  principals: Principal[]
  /** The number of principals that match the filter, the page included. */
  total: number
  /** The size of the page that was asked for. */
  limit: number
  /** The number of rows that were skipped. */
  offset: number
}

/** The filter of the list of the grants. */
export interface GrantFilter {
  /** The id of the tenant, or null for every tenant. */
  tenantId: string | null
  /** The id of the principal, or null for every principal. */
  userId: string | null
  /**
   * True: the grants that are not revoked and not expired. False: the
   * others. Null: every grant.
   */
  live: boolean | null
  /** The size of the page. */
  limit: number
  /** The number of rows that are skipped. */
  offset: number
}

/** A page of grants and the number of the grants that match. */
export interface GrantPage {
  grants: Grant[]
  /** The number of grants that match the filter, the page included. */
  total: number
  /** The size of the page that was asked for. */
  limit: number
  /** The number of rows that were skipped. */
  offset: number
}

/**
 * The row of the audit of the administration (spec §9.1).
 *
 * The row names what changed, when, and who changed it. It never carries
 * a secret: the operator is a fingerprint of the credential that made the
 * call.
 */
export interface AuditRecord {
  id: string
  /** The moment of the change. */
  at: Date
  /** What happened: `tenant.created`, `grant.revoked`, and so on. */
  action: string
  /** The identifier of the thing that changed. */
  targetId: string | null
  /** The slug of the tenant, when the change belongs to one. */
  tenant: string | null
  /** The fingerprint of the credential of the operator. */
  operator: string | null
  /** The address of the socket of the call. */
  address: string | null
  /** The identifier of the request. */
  requestId: string | null
}

/** The entry of the audit: what is written. */
export interface AuditWrite {
  /** What happened. */
  action: string
  /** The identifier of the thing that changed. */
  targetId?: string | null
  /** The slug of the tenant, when the change belongs to one. */
  tenant?: string | null
  /** The fingerprint of the credential of the operator. */
  operator?: string | null
  /** The address of the socket of the call. */
  address?: string | null
  /** The identifier of the request. */
  requestId?: string | null
}

/** The filter of the list of the audit. */
export interface AuditFilter {
  /** The slug of the tenant, or null for every tenant. */
  tenant: string | null
  /** The action, or null for every action. */
  action: string | null
  /** The size of the page. */
  limit: number
  /** The number of rows that are skipped. */
  offset: number
}

/** A page of the audit and the number of the rows that match the filter. */
export interface AuditPage {
  records: AuditRecord[]
  /** The number of rows that match the filter, the page included. */
  total: number
  /** The size of the page that was asked for. */
  limit: number
  /** The number of rows that were skipped. */
  offset: number
}

/**
 * The storage of the audit of the administration.
 *
 * The audit is a port like the others: the domain asks for a row to be
 * written and for the rows to be read, and it never sees the table.
 */
export interface AuditStore {
  /** Writes a row of the audit. */
  append(entry: AuditWrite): Promise<void>
  /** The rows of the audit that match a filter, and their number. */
  list(filter: AuditFilter): Promise<AuditPage>
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
  /** The principals that match a filter, and their number. */
  list(filter: PrincipalFilter): Promise<PrincipalPage>
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

/** The storage of the groups. */
export interface GroupStore {
  /** The group of a key, in the scope of a tenant. */
  findByKey(tenantId: string, key: string): Promise<Group | null>
  /** Creates a group. */
  create(registration: {
    tenantId: string
    key: string
    displayName?: string | null
    /** The ids of the principals of the group. */
    memberIds: string[]
  }): Promise<Group>
  /** Changes a group: the membership is replaced. */
  update(
    id: string,
    changes: { displayName?: string | null; memberIds?: string[] }
  ): Promise<Group | null>
}

/** The storage of the grants. */
export interface GrantStore {
  /** The grant of an id. */
  findById(id: string): Promise<Grant | null>
  /** The live grant of a scope. */
  findLive(
    tenantId: string,
    subject: { userId: string | null; groupId: string | null },
    permissionId: string,
    workspaceId: string | null,
    routeId: string | null
  ): Promise<Grant | null>
  /** Creates a grant. */
  create(registration: {
    tenantId: string
    userId: string | null
    groupId: string | null
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
  /** The grants that match a filter, and their number. */
  list(filter: GrantFilter): Promise<GrantPage>
}
