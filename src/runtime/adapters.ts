/**
 * The adapters of the storage.
 *
 * The composition root is the only place where the concrete pieces are
 * joined: the repositories of the platform are adapted to the ports of
 * the domains here, and nowhere else. The adaptation is a translation of
 * the rows and of the failures: a domain never sees a row of PostgreSQL
 * and never sees the error of a driver.
 */

import {
  AdministrationError,
  AdministrationService,
  FailedAuthenticationLimiter,
  type AdminCredential,
  type AuditFilter,
  type AuditRecord,
  type AuditRows,
  type AuditStore,
  type AuthenticationFailures,
  type GrantFilter,
  type GrantStore,
  type Group,
  type GroupFilter,
  type GroupStore,
  type PermissionStore,
  type PrincipalFilter,
  type PrincipalStore,
  type TenantStore,
} from '../domains/administration'
import {
  CHECK_VIOLATION,
  DatabaseError,
  GROUP_MEMBERSHIP_CONSTRAINT,
  UNIQUE_VIOLATION,
  type AuditRepository,
  type AuditRow,
  type GrantRepository,
  type GrantRow,
  type GroupRepository,
  type GroupRow,
  type PermissionRepository,
  type PermissionRow,
  type TenantRepository,
  type TenantRow,
  type TenantSummary,
  type UserRepository,
  type UserRow,
} from '../platform/postgres'

/** Turns a tenant of the storage into a tenant of the domain. */
function toTenant(row: TenantRow): {
  id: string
  slug: string
  displayName: string
  issuer: string
  emailDomain: string | null
  clientId: string
  clientRedirectUris: string[]
  autoProvision: boolean
  sharedClient: boolean
  isDefault: boolean
  enabled: boolean
  createdAt: Date
} {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    issuer: row.idpIssuer,
    emailDomain: row.emailDomain,
    clientId: row.clientId,
    clientRedirectUris: row.clientRedirectUris,
    autoProvision: row.autoProvision,
    sharedClient: row.sharedClient,
    isDefault: row.isDefault,
    enabled: row.enabled,
    createdAt: row.createdAt,
  }
}

/** Turns a principal of the storage into a principal of the domain. */
function toPrincipal(row: UserRow): {
  id: string
  tenant: string
  externalSubject: string
  email: string | null
  displayName: string | null
  status: 'active' | 'disabled'
  lastLoginAt: Date | null
  createdAt: Date
} {
  return {
    id: row.id,
    tenant: row.tenantSlug,
    externalSubject: row.externalSubject,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  }
}

/** Turns a permission of the storage into a permission of the domain. */
function toPermission(row: PermissionRow): {
  id: string
  tenantId: string | null
  key: string
  description: string | null
  enabled: boolean
} {
  return {
    id: row.id,
    tenantId: row.tenantId,
    key: row.key,
    description: row.description,
    enabled: row.enabled,
  }
}

/** Turns a group of the storage into a group of the domain. */
function toGroup(row: GroupRow, members: string[]): Group {
  return {
    id: row.id,
    tenant: row.tenantSlug,
    key: row.key,
    displayName: row.displayName,
    members,
    createdAt: row.createdAt,
  }
}

/** Turns a grant of the storage into a grant of the domain. */
function toGrant(row: GrantRow): {
  id: string
  tenant: string
  userId: string | null
  group: string | null
  permission: string
  workspaceId: string | null
  routeId: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  grantedBy: string | null
  createdAt: Date
} {
  return {
    id: row.id,
    tenant: row.tenantSlug,
    userId: row.userId,
    group: row.groupKey,
    permission: row.permissionKey,
    workspaceId: row.workspaceId,
    routeId: row.routeId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    grantedBy: row.grantedBy,
    createdAt: row.createdAt,
  }
}

/**
 * Turns the failure of the storage into the failure of the domain.
 *
 * A unique violation is a conflict: the slug, the client id, the domain
 * of the e-mail and the tuple of a grant are unique.
 *
 * The membership of a group is checked by the database (spec §3.5): a
 * member that is not a principal of the tenant is a `404`, the same
 * answer that the administration gives when it finds it before the
 * write.
 */
function translate(error: unknown): unknown {
  if (error instanceof DatabaseError && error.code === UNIQUE_VIOLATION) {
    return new AdministrationError('conflict', 'the value is already used by another tenant')
  }
  if (
    error instanceof DatabaseError &&
    error.code === CHECK_VIOLATION &&
    error.constraint === GROUP_MEMBERSHIP_CONSTRAINT
  ) {
    return new AdministrationError(
      'not_found',
      'a member of the group is not a principal of the tenant'
    )
  }
  return error
}

/** Runs a statement of the storage and translates its failures. */
async function run<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw translate(error)
  }
}

export interface AdministrationDependencies {
  tenants: TenantRepository
  users: UserRepository
  groups?: GroupRepository
  permissions: PermissionRepository
  grants: GrantRepository
  /** The storage of the audit of the administration. */
  audit?: AuditRepository
  /**
   * The count of the failed authentications.
   *
   * It is the shared store of the deployment when it has one, so the
   * window of the limiter is the window of the deployment and not the
   * window of a replica (spec §10.1).
   */
  failures: AuthenticationFailures
  /** The bearer token of the administration. */
  token?: string
  /** The token that the current one replaced, during a rotation. */
  previousToken?: string
  /** The credentials of the tenants of the administration (spec §10.1). */
  credentials?: AdminCredential[]
  /** The public url of Hub. */
  publicUrl: string
  /**
   * Called when the registration of a tenant changes.
   *
   * The client of the provider of the tenant is dropped, so that the next
   * login builds a new one with the new registration (spec §6.6).
   */
  onTenantChanged?: (tenantId: string) => void
}

/**
 * Builds the administration of the platform.
 *
 * The repositories are adapted to the ports of the domain here: the
 * domain never sees the storage.
 */
export function createAdministrationService(
  dependencies: AdministrationDependencies
): AdministrationService {
  const tenantStore: TenantStore = {
    findBySlug: async (slug) => {
      const row = await run(async () => await dependencies.tenants.findBySlug(slug))
      return row ? toTenant(row) : null
    },
    findByClientId: async (clientId) => {
      const row = await run(async () => await dependencies.tenants.findByClientId(clientId))
      return row ? toTenant(row) : null
    },
    list: async () => {
      const rows = await run(async () => await dependencies.tenants.list())
      return rows.map((row: TenantSummary) => ({
        ...toTenant(row),
        userCount: row.userCount,
        grantCount: row.grantCount,
      }))
    },
    create: async (registration, audit) => {
      const row = await run(async () => await dependencies.tenants.create(registration, audit))
      dependencies.onTenantChanged?.(row.id)
      return toTenant(row)
    },
    update: async (id, registration, audit) => {
      const row = await run(async () => await dependencies.tenants.update(id, registration, audit))
      if (row) dependencies.onTenantChanged?.(id)
      return row ? toTenant(row) : null
    },
  }

  const principalStore: PrincipalStore = {
    findById: async (id) => {
      const row = await run(async () => await dependencies.users.findById(id))
      return row ? toPrincipal(row) : null
    },
    findByExternalSubject: async (tenantId, externalSubject) => {
      const row = await run(
        async () => await dependencies.users.findByExternalSubject(tenantId, externalSubject)
      )
      return row ? toPrincipal(row) : null
    },
    create: async (registration, audit) => {
      const row = await run(async () => await dependencies.users.create(registration, audit))
      return toPrincipal(row)
    },
    update: async (id, changes, audit) => {
      const row = await run(async () => await dependencies.users.update(id, changes, audit))
      return row ? toPrincipal(row) : null
    },
    list: async (filter: PrincipalFilter) => {
      const page = await run(async () => await dependencies.users.list(filter))
      return {
        principals: page.rows.map(toPrincipal),
        total: page.total,
        limit: filter.limit,
        offset: filter.offset,
      }
    },
  }

  const permissionStore: PermissionStore = {
    findCataloguePermission: async (key) => {
      const row = await run(async () => await dependencies.permissions.findCataloguePermission(key))
      return row ? toPermission(row) : null
    },
    findByTenantAndKey: async (tenantId, key) => {
      const row = await run(
        async () => await dependencies.permissions.findByTenantAndKey(tenantId, key)
      )
      return row ? toPermission(row) : null
    },
    findByKey: async (key) => {
      const row = await run(async () => await dependencies.permissions.findByKey(key))
      return row ? toPermission(row) : null
    },
    create: async (registration) => {
      const row = await run(async () => await dependencies.permissions.create(registration))
      return toPermission(row)
    },
    createOrFind: async (registration) => {
      const row = await run(async () => await dependencies.permissions.createOrFind(registration))
      return toPermission(row)
    },
  }

  /**
   * The external subjects of the principals of a group.
   *
   * The membership is stored as the ids of the principals and it is
   * published as the external identities of the principals: the
   * translation is the work of the adapter.
   */
  const membersOf = async (ids: string[]): Promise<string[]> => {
    if (ids.length === 0) return []
    const rows = await run(async () => await dependencies.users.findExternalSubjectsByIds(ids))
    return rows
  }

  const groupStore: GroupStore | undefined = dependencies.groups
    ? {
        findByKey: async (tenantId, key) => {
          const row = await run(async () => await dependencies.groups!.findByKey(tenantId, key))
          if (!row) return null
          return toGroup(row, await membersOf(row.members))
        },
        list: async (filter: GroupFilter) => {
          const page = await run(async () => await dependencies.groups!.list(filter))
          const groups = await Promise.all(
            page.rows.map(async (row: GroupRow) => toGroup(row, await membersOf(row.members)))
          )
          return {
            groups,
            total: page.total,
            limit: filter.limit,
            offset: filter.offset,
          }
        },
        create: async (registration, audit) => {
          const row = await run(
            async () =>
              await dependencies.groups!.create(
                {
                  tenantId: registration.tenantId,
                  key: registration.key,
                  displayName: registration.displayName ?? null,
                  members: registration.memberIds,
                },
                audit
              )
          )
          return toGroup(row, await membersOf(row.members))
        },
        update: async (id, changes, audit) => {
          const row = await run(
            async () =>
              await dependencies.groups!.update(
                id,
                {
                  displayName: changes.displayName,
                  ...(changes.memberIds ? { members: changes.memberIds } : {}),
                },
                audit
              )
          )
          if (!row) return null
          return toGroup(row, await membersOf(row.members))
        },
      }
    : undefined

  const grantStore: GrantStore = {
    findById: async (id) => {
      const row = await run(async () => await dependencies.grants.findById(id))
      return row ? toGrant(row) : null
    },
    findLive: async (tenantId, subject, permissionId, workspaceId, routeId) => {
      const row = await run(
        async () =>
          await dependencies.grants.findLive(tenantId, subject, permissionId, workspaceId, routeId)
      )
      return row ? toGrant(row) : null
    },
    create: async (registration, audit) => {
      const row = await run(async () => await dependencies.grants.create(registration, audit))
      return toGrant(row)
    },
    update: async (id, changes, audit) => {
      const row = await run(async () => await dependencies.grants.update(id, changes, audit))
      return row ? toGrant(row) : null
    },
    revoke: async (id, audit) => {
      const row = await run(async () => await dependencies.grants.revoke(id, audit))
      return row ? toGrant(row) : null
    },
    list: async (filter: GrantFilter) => {
      const page = await run(async () => await dependencies.grants.list(filter))
      return {
        grants: page.rows.map(toGrant),
        total: page.total,
        limit: filter.limit,
        offset: filter.offset,
      }
    },
  }

  /** Turns a row of the audit into a row of the domain. */
  const toAudit = (row: AuditRow): AuditRecord => ({
    id: row.id,
    at: row.at,
    action: row.action,
    targetId: row.targetId,
    tenant: row.tenant,
    operator: row.operator,
    address: row.address,
    requestId: row.requestId,
  })

  const auditStore: AuditStore | undefined = dependencies.audit
    ? {
        list: async (filter: AuditFilter): Promise<AuditRows> => {
          const page = await run(async () => await dependencies.audit!.list(filter))
          return {
            records: page.rows.map(toAudit),
            total: page.total,
          }
        },
      }
    : undefined

  return new AdministrationService({
    tenants: tenantStore,
    principals: principalStore,
    permissions: permissionStore,
    grants: grantStore,
    groups: groupStore,
    audit: auditStore,
    token: dependencies.token,
    previousToken: dependencies.previousToken,
    credentials: dependencies.credentials,
    publicUrl: dependencies.publicUrl,
    limiter: new FailedAuthenticationLimiter(dependencies.failures),
  })
}
