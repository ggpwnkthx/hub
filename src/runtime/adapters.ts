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
  type GrantStore,
  type PermissionStore,
  type PrincipalStore,
  type TenantStore,
} from '../domains/administration'
import {
  DatabaseError,
  UNIQUE_VIOLATION,
  type GrantRepository,
  type GrantRow,
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

/** Turns a grant of the storage into a grant of the domain. */
function toGrant(row: GrantRow): {
  id: string
  tenant: string
  userId: string
  permission: string
  workspaceId: string | null
  routeId: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
} {
  return {
    id: row.id,
    tenant: row.tenantSlug,
    userId: row.userId,
    permission: row.permissionKey,
    workspaceId: row.workspaceId,
    routeId: row.routeId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  }
}

/**
 * Turns the failure of the storage into the failure of the domain.
 *
 * A unique violation is a conflict: the slug, the client id, the domain
 * of the e-mail and the tuple of a grant are unique.
 */
function translate(error: unknown): unknown {
  if (error instanceof DatabaseError && error.code === UNIQUE_VIOLATION) {
    return new AdministrationError('conflict', 'the value is already used by another tenant')
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
  permissions: PermissionRepository
  grants: GrantRepository
  /** The bearer token of the administration. */
  token?: string
  /** The public url of Hub. */
  publicUrl: string
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
    create: async (registration) => {
      const row = await run(async () => await dependencies.tenants.create(registration))
      return toTenant(row)
    },
    update: async (id, registration) => {
      const row = await run(async () => await dependencies.tenants.update(id, registration))
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
    create: async (registration) => {
      const row = await run(async () => await dependencies.users.create(registration))
      return toPrincipal(row)
    },
    update: async (id, changes) => {
      const row = await run(async () => await dependencies.users.update(id, changes))
      return row ? toPrincipal(row) : null
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
  }

  const grantStore: GrantStore = {
    findById: async (id) => {
      const row = await run(async () => await dependencies.grants.findById(id))
      return row ? toGrant(row) : null
    },
    findLive: async (tenantId, userId, permissionId, workspaceId, routeId) => {
      const row = await run(
        async () =>
          await dependencies.grants.findLive(tenantId, userId, permissionId, workspaceId, routeId)
      )
      return row ? toGrant(row) : null
    },
    create: async (registration) => {
      const row = await run(async () => await dependencies.grants.create(registration))
      return toGrant(row)
    },
    update: async (id, changes) => {
      const row = await run(async () => await dependencies.grants.update(id, changes))
      return row ? toGrant(row) : null
    },
    revoke: async (id) => {
      const row = await run(async () => await dependencies.grants.revoke(id))
      return row ? toGrant(row) : null
    },
  }

  return new AdministrationService({
    tenants: tenantStore,
    principals: principalStore,
    permissions: permissionStore,
    grants: grantStore,
    token: dependencies.token,
    publicUrl: dependencies.publicUrl,
  })
}
