import { describe, expect, test } from 'bun:test'
import { sameSecret } from '../../observability'
import {
  AdministrationError,
  AdministrationService,
  FailedAuthenticationLimiter,
  type AuthenticationFailures,
  type AuditContext,
  type ChangeAudit,
  type FailureCount,
  type Grant,
  type GrantFilter,
  type GrantStore,
  type Group,
  type GroupFilter,
  type GroupPage,
  type GroupStore,
  type Permission,
  type PermissionStore,
  type Principal,
  type PrincipalFilter,
  type PrincipalStore,
  type Tenant,
  type TenantStore,
  type TenantSummary,
} from './index'

/** The facts of a call of the administration. */
const CONTEXT: AuditContext = {
  operator: 'the-fingerprint',
  address: '10.0.0.1',
  requestId: 'the-request',
}

/** The storage of the tenants of the tests. */
class FakeTenants implements TenantStore {
  readonly rows: Tenant[] = []
  /** The audits the service asked to write with the changes. */
  readonly audits: (ChangeAudit | null)[] = []

  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.rows.find((row) => row.slug === slug) ?? null
  }

  async findByClientId(clientId: string): Promise<Tenant | null> {
    return this.rows.find((row) => row.clientId === clientId) ?? null
  }

  async list(): Promise<TenantSummary[]> {
    return this.rows.map((row) => ({ ...row, userCount: 0, grantCount: 0 }))
  }

  async create(
    registration: {
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
    },
    audit?: ChangeAudit
  ): Promise<Tenant> {
    this.audits.push(audit ?? null)
    const tenant: Tenant = {
      id: `tenant-${this.rows.length + 1}`,
      slug: registration.slug,
      displayName: registration.displayName,
      issuer: registration.issuer,
      emailDomain: registration.emailDomain,
      clientId: registration.clientId,
      clientRedirectUris: registration.clientRedirectUris,
      autoProvision: registration.autoProvision,
      sharedClient: registration.sharedClient,
      isDefault: registration.isDefault,
      enabled: registration.enabled,
      createdAt: new Date('2026-01-08T10:00:00.000Z'),
    }
    this.rows.push(tenant)
    return tenant
  }

  async update(id: string, changes: Partial<Tenant>, audit?: ChangeAudit): Promise<Tenant | null> {
    this.audits.push(audit ?? null)
    const tenant = this.rows.find((row) => row.id === id)
    if (!tenant) return null
    Object.assign(tenant, changes)
    return tenant
  }
}

/** The storage of the principals of the tests. */
class FakePrincipals implements PrincipalStore {
  readonly rows: Principal[] = []
  /** The audits the service asked to write with the changes. */
  readonly audits: (ChangeAudit | null)[] = []

  async findById(id: string): Promise<Principal | null> {
    return this.rows.find((row) => row.id === id) ?? null
  }

  async findByExternalSubject(
    tenantId: string,
    externalSubject: string
  ): Promise<Principal | null> {
    const tenant = TENANTS.rows.find((row) => row.id === tenantId)
    return (
      this.rows.find(
        (row) => row.tenant === tenant?.slug && row.externalSubject === externalSubject
      ) ?? null
    )
  }

  async create(
    registration: {
      tenantId: string
      externalSubject: string
      email?: string | null
      displayName?: string | null
      status?: 'active' | 'disabled'
    },
    audit?: ChangeAudit
  ): Promise<Principal> {
    this.audits.push(audit ?? null)
    const tenant = TENANTS.rows.find((row) => row.id === registration.tenantId)
    const principal: Principal = {
      id: `principal-${this.rows.length + 1}`,
      tenant: tenant?.slug ?? '',
      externalSubject: registration.externalSubject,
      email: registration.email ?? null,
      displayName: registration.displayName ?? null,
      status: registration.status ?? 'active',
      lastLoginAt: null,
      createdAt: new Date('2026-01-08T10:05:00.000Z'),
    }
    this.rows.push(principal)
    return principal
  }

  async update(
    id: string,
    changes: { email?: string | null; displayName?: string | null; status?: 'active' | 'disabled' },
    audit?: ChangeAudit
  ): Promise<Principal | null> {
    this.audits.push(audit ?? null)
    const principal = this.rows.find((row) => row.id === id)
    if (!principal) return null
    Object.assign(principal, changes)
    return principal
  }

  async list(filter: PrincipalFilter) {
    const matching = this.rows.filter((row) => {
      if (filter.tenantId !== null) {
        const tenant = TENANTS.rows.find((t) => t.id === filter.tenantId)
        if (row.tenant !== tenant?.slug) return false
      }
      if (filter.status !== null && row.status !== filter.status) return false
      if (filter.email !== null && row.email !== filter.email) return false
      return true
    })
    const ordered = [...matching].reverse()
    return {
      principals: ordered.slice(filter.offset, filter.offset + filter.limit),
      total: matching.length,
      limit: filter.limit,
      offset: filter.offset,
    }
  }
}

/** The storage of the permissions of the tests. */
class FakePermissions implements PermissionStore {
  readonly rows: Permission[] = []

  async findCataloguePermission(key: string): Promise<Permission | null> {
    return this.rows.find((row) => row.tenantId === null && row.key === key) ?? null
  }

  async findByTenantAndKey(tenantId: string, key: string): Promise<Permission | null> {
    return this.rows.find((row) => row.tenantId === tenantId && row.key === key) ?? null
  }

  async findByKey(key: string): Promise<Permission | null> {
    return this.rows.find((row) => row.key === key) ?? null
  }

  async create(registration: { tenantId: string | null; key: string }): Promise<Permission> {
    const permission: Permission = {
      id: `permission-${this.rows.length + 1}`,
      tenantId: registration.tenantId,
      key: registration.key,
      description: null,
      enabled: true,
    }
    this.rows.push(permission)
    return permission
  }

  async createOrFind(registration: { tenantId: string | null; key: string }): Promise<Permission> {
    const existing = this.rows.find(
      (row) => row.tenantId === registration.tenantId && row.key === registration.key
    )
    if (existing) return existing
    return await this.create(registration)
  }
}

/** The storage of the grants of the tests. */
class FakeGrants implements GrantStore {
  readonly rows: Grant[] = []
  /** The audits the service asked to write with the changes. */
  readonly audits: (ChangeAudit | null)[] = []

  async findById(id: string): Promise<Grant | null> {
    return this.rows.find((row) => row.id === id) ?? null
  }

  async findLive(
    tenantId: string,
    subject: { userId: string | null; groupId: string | null },
    permissionId: string,
    workspaceId: string | null,
    routeId: string | null
  ): Promise<Grant | null> {
    return (
      this.rows.find(
        (row) =>
          row.tenant === TENANTS.rows.find((t) => t.id === tenantId)?.slug &&
          row.userId === subject.userId &&
          row.group === (subject.groupId ?? null) &&
          row.permission === PERMISSIONS.rows.find((p) => p.id === permissionId)?.key &&
          row.workspaceId === workspaceId &&
          row.routeId === routeId &&
          row.revokedAt === null
      ) ?? null
    )
  }

  async create(
    registration: {
      tenantId: string
      userId: string | null
      groupId: string | null
      permissionId: string
      workspaceId: string | null
      routeId: string | null
      expiresAt: Date | null
      grantedBy: string | null
    },
    audit?: ChangeAudit
  ): Promise<Grant> {
    this.audits.push(audit ?? null)
    const tenant = TENANTS.rows.find((row) => row.id === registration.tenantId)
    const permission = PERMISSIONS.rows.find((row) => row.id === registration.permissionId)
    const group = GROUPS.rows.find((row) => row.id === registration.groupId)
    const grant: Grant = {
      id: `grant-${this.rows.length + 1}`,
      tenant: tenant?.slug ?? '',
      userId: registration.userId,
      group: group?.key ?? null,
      permission: permission?.key ?? '',
      workspaceId: registration.workspaceId,
      routeId: registration.routeId,
      expiresAt: registration.expiresAt,
      revokedAt: null,
      grantedBy: registration.grantedBy,
      createdAt: new Date('2026-01-08T10:06:00.000Z'),
    }
    this.rows.push(grant)
    return grant
  }

  async update(
    id: string,
    changes: { expiresAt?: Date | null; grantedBy?: string | null },
    audit?: ChangeAudit
  ): Promise<Grant | null> {
    this.audits.push(audit ?? null)
    const grant = this.rows.find((row) => row.id === id)
    if (!grant) return null
    Object.assign(grant, changes)
    return grant
  }

  async revoke(id: string, audit?: ChangeAudit): Promise<Grant | null> {
    this.audits.push(audit ?? null)
    const grant = this.rows.find((row) => row.id === id)
    if (!grant) return null
    grant.revokedAt = new Date('2026-01-08T11:00:00.000Z')
    return grant
  }

  async list(filter: GrantFilter) {
    const now = new Date('2026-01-08T12:00:00.000Z')
    const matching = this.rows.filter((row) => {
      if (filter.tenantId !== null) {
        const tenant = TENANTS.rows.find((t) => t.id === filter.tenantId)
        if (row.tenant !== tenant?.slug) return false
      }
      if (filter.userId !== null && row.userId !== filter.userId) return false
      if (filter.live !== null) {
        const live = row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now)
        if (live !== filter.live) return false
      }
      return true
    })
    const ordered = [...matching].reverse()
    return {
      grants: ordered.slice(filter.offset, filter.offset + filter.limit),
      total: matching.length,
      limit: filter.limit,
      offset: filter.offset,
    }
  }
}

/** The storage of the groups of the tests. */
class FakeGroups implements GroupStore {
  readonly rows: Group[] = []
  /** The audits the service asked to write with the changes. */
  readonly audits: (ChangeAudit | null)[] = []

  async findByKey(tenantId: string, key: string): Promise<Group | null> {
    const tenant = TENANTS.rows.find((row) => row.id === tenantId)
    return this.rows.find((row) => row.tenant === tenant?.slug && row.key === key) ?? null
  }

  async create(
    registration: {
      tenantId: string
      key: string
      displayName?: string | null
      memberIds: string[]
    },
    audit?: ChangeAudit
  ): Promise<Group> {
    this.audits.push(audit ?? null)
    const tenant = TENANTS.rows.find((row) => row.id === registration.tenantId)
    const group: Group = {
      id: `group-${this.rows.length + 1}`,
      tenant: tenant?.slug ?? '',
      key: registration.key,
      displayName: registration.displayName ?? null,
      members: registration.memberIds,
      createdAt: new Date('2026-01-08T10:20:00.000Z'),
    }
    this.rows.push(group)
    return group
  }

  async update(
    id: string,
    changes: { displayName?: string | null; memberIds?: string[] },
    audit?: ChangeAudit
  ): Promise<Group | null> {
    this.audits.push(audit ?? null)
    const group = this.rows.find((row) => row.id === id)
    if (!group) return null
    if (changes.displayName !== undefined) group.displayName = changes.displayName
    if (changes.memberIds !== undefined) group.members = changes.memberIds
    return group
  }

  async list(filter: GroupFilter): Promise<GroupPage> {
    const matching = this.rows.filter((row) => {
      if (filter.tenantId !== null) {
        const tenant = TENANTS.rows.find((t) => t.id === filter.tenantId)
        if (row.tenant !== tenant?.slug) return false
      }
      if (filter.key !== null && row.key !== filter.key) return false
      return true
    })
    const ordered = [...matching].reverse()
    return {
      groups: ordered.slice(filter.offset, filter.offset + filter.limit),
      total: matching.length,
      limit: filter.limit,
      offset: filter.offset,
    }
  }
}

const TENANTS = new FakeTenants()
const PRINCIPALS = new FakePrincipals()
const PERMISSIONS = new FakePermissions()
const GRANTS = new FakeGrants()
const GROUPS = new FakeGroups()

/**
 * The count of the failed authentications, in the memory of the tests.
 *
 * The domain owns the rule and the storage is a port: the tests bring
 * their own count, and the platform brings the one of the deployment.
 */
class FakeFailures implements AuthenticationFailures {
  private readonly failures = new Map<string, { count: number; since: number }>()
  private readonly now = () => Date.now()

  async fail(address: string, windowMs: number): Promise<FailureCount> {
    const now = this.now()
    const failure = this.failures.get(address)
    if (!failure || now - failure.since >= windowMs) {
      this.failures.set(address, { count: 1, since: now })
      return { count: 1, retryAfterMs: windowMs }
    }
    failure.count += 1
    return { count: failure.count, retryAfterMs: windowMs - (now - failure.since) }
  }

  async count(address: string, windowMs: number): Promise<FailureCount> {
    const now = this.now()
    const failure = this.failures.get(address)
    if (!failure || now - failure.since >= windowMs) return { count: 0, retryAfterMs: 0 }
    return { count: failure.count, retryAfterMs: windowMs - (now - failure.since) }
  }

  async succeed(address: string): Promise<void> {
    this.failures.delete(address)
  }
}

/** The service of the tests. */
function service(
  options: {
    token?: string
    limiter?: FailedAuthenticationLimiter
    failures?: AuthenticationFailures
  } = {}
) {
  return new AdministrationService({
    tenants: TENANTS,
    principals: PRINCIPALS,
    permissions: PERMISSIONS,
    grants: GRANTS,
    groups: GROUPS,
    token: options.token ?? 'the-admin-token',
    publicUrl: 'https://hub.example.com',
    limiter:
      options.limiter ?? new FailedAuthenticationLimiter(options.failures ?? new FakeFailures()),
  })
}

/** The registration of a tenant of the tests. */
const TENANT = {
  slug: 'acme',
  displayName: 'Acme Inc',
  issuer: 'https://login.acme.example',
  idpClientId: 'hub-acme',
  idpClientSecret: 'the-secret-of-the-provider',
  idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
  idpScopes: ['openid', 'email', 'profile'],
  idpAlgorithms: ['RS256'],
  emailDomain: 'acme.example',
  clientId: 'shuttle-acme',
  clientSecret: 'the-secret-of-the-gateway',
  clientRedirectUris: ['https://shuttle-acme.example.com/auth/callback'],
  autoProvision: false,
  sharedClient: false,
  isDefault: false,
  enabled: true,
}

describe('the authentication of the administration', () => {
  test('the token is compared in constant time', () => {
    expect(sameSecret('the-token', 'the-token')).toBe(true)
    expect(sameSecret('the-token', 'another-token')).toBe(false)
    expect(sameSecret('the-token', 'the-toke')).toBe(false)
  })

  test('a missing token is refused', async () => {
    await expect(service().authenticate(undefined, '10.0.0.1')).rejects.toThrow(AdministrationError)
    await expect(service().authenticate('Bearer wrong', '10.0.0.1')).rejects.toThrow(
      /a valid administration token/
    )
  })

  test('the right token is accepted', async () => {
    await expect(
      service().authenticate('Bearer the-admin-token', '10.0.0.1')
    ).resolves.toBeUndefined()
  })

  test('a deployment without a token has no administrative surface', async () => {
    const administration = new AdministrationService({
      tenants: TENANTS,
      principals: PRINCIPALS,
      permissions: PERMISSIONS,
      grants: GRANTS,
      publicUrl: 'https://hub.example.com',
      limiter: new FailedAuthenticationLimiter(new FakeFailures()),
    })
    await expect(administration.authenticate('Bearer the-admin-token', '10.0.0.1')).rejects.toThrow(
      /a valid administration token/
    )
  })

  test('a burst of failed authentications is refused', async () => {
    const administration = service({
      limiter: new FailedAuthenticationLimiter(new FakeFailures(), { max: 3 }),
    })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(administration.authenticate('Bearer wrong', '10.0.0.2')).rejects.toThrow(
        AdministrationError
      )
    }
    let refused = false
    try {
      await administration.authenticate('Bearer wrong', '10.0.0.2')
    } catch (error) {
      refused = error instanceof AdministrationError && error.code === 'too_many_requests'
    }
    expect(refused).toBe(true)
    // The right token does not open the door of an address that is
    // hammering the endpoint.
    await expect(administration.authenticate('Bearer the-admin-token', '10.0.0.2')).rejects.toThrow(
      /too many failed authentications/
    )
    // Another address is not affected.
    await expect(
      administration.authenticate('Bearer the-admin-token', '10.0.0.3')
    ).resolves.toBeUndefined()
  })

  test('a success clears the failures of the address', async () => {
    const limiter = new FailedAuthenticationLimiter(new FakeFailures(), { max: 2 })
    const administration = service({ limiter })
    await expect(administration.authenticate('Bearer wrong', '10.0.0.4')).rejects.toThrow()
    await expect(
      administration.authenticate('Bearer the-admin-token', '10.0.0.4')
    ).resolves.toBeUndefined()
    expect(await limiter.count('10.0.0.4')).toBe(0)
  })
})

describe('the tenants of the administration', () => {
  test('a tenant is created and then changed', async () => {
    const administration = service()
    const created = await administration.upsertTenant(TENANT, CONTEXT)
    expect(created.created).toBe(true)
    expect(created.audit.action).toBe('tenant.created')

    const updated = await administration.upsertTenant(
      { ...TENANT, displayName: 'Another name' },
      CONTEXT
    )
    expect(updated.created).toBe(false)
    expect(updated.audit.action).toBe('tenant.updated')
    expect(updated.tenant.displayName).toBe('Another name')
  })

  test('a client id belongs to one tenant', async () => {
    const administration = service()
    await expect(
      administration.upsertTenant({ ...TENANT, slug: 'another', clientId: 'shuttle-acme' }, CONTEXT)
    ).rejects.toThrow(/belongs to another tenant/)
  })

  test('at most one tenant is the default', async () => {
    const administration = service()
    await administration.upsertTenant(
      {
        ...TENANT,
        slug: 'first',
        clientId: 'shuttle-first',
        isDefault: true,
      },
      CONTEXT
    )
    await expect(
      administration.upsertTenant(
        {
          ...TENANT,
          slug: 'second',
          clientId: 'shuttle-second',
          isDefault: true,
        },
        CONTEXT
      )
    ).rejects.toThrow(/already the default/)
  })

  test('the tenants are listed', async () => {
    const administration = service()
    const listed = await administration.listTenants()
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((tenant) => typeof tenant.userCount === 'number')).toBe(true)
  })
})

describe('the principals of the administration', () => {
  test('a principal is created and then changed', async () => {
    const administration = service()
    const created = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: '00u1a2b3c4d5',
        email: 'alice@acme.example',
      },
      CONTEXT
    )
    expect(created.created).toBe(true)
    expect(created.principal.status).toBe('active')

    const updated = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: '00u1a2b3c4d5',
        status: 'disabled',
      },
      CONTEXT
    )
    expect(updated.created).toBe(false)
    expect(updated.principal.status).toBe('disabled')
  })

  test('an unknown tenant is a not found', async () => {
    const administration = service()
    await expect(
      administration.upsertPrincipal({ tenant: 'unknown', externalSubject: 'sub' }, CONTEXT)
    ).rejects.toThrow(/the tenant does not exist/)
  })
})

describe('the grants of the administration', () => {
  test('a grant is created and the permission is created on demand', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-grant',
      },
      CONTEXT
    )
    const grant = await administration.upsertGrant(
      {
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'workspace.read',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        routeId: 'workspace-api',
      },
      CONTEXT
    )
    expect(grant.grant.permission).toBe('workspace.read')
    expect(grant.audit.action).toBe('grant.created')
    expect(PERMISSIONS.rows.some((row) => row.key === 'workspace.read')).toBe(true)
  })

  test('a permission of the catalogue is reused', async () => {
    const administration = service()
    await PERMISSIONS.create({ tenantId: null, key: 'platform.read' })
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-the-catalogue',
      },
      CONTEXT
    )
    const grant = await administration.upsertGrant(
      {
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'platform.read',
      },
      CONTEXT
    )
    expect(grant.grant.permission).toBe('platform.read')
    expect(PERMISSIONS.rows.filter((row) => row.key === 'platform.read')).toHaveLength(1)
  })

  test('a key is a name inside a tenant: two tenants hold the same key', async () => {
    // The permission of another tenant is not the permission of this
    // one: the tenant creates its own row, and the grant names that
    // row. A key that another tenant owns never becomes a permission of
    // this tenant.
    const administration = service()
    await PERMISSIONS.create({ tenantId: 'another-tenant', key: 'workspace.write' })
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-another-tenant',
      },
      CONTEXT
    )
    const grant = await administration.upsertGrant(
      {
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'workspace.write',
      },
      CONTEXT
    )
    expect(grant.grant.permission).toBe('workspace.write')
    const rows = PERMISSIONS.rows.filter((row) => row.key === 'workspace.write')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.tenantId).sort()).toEqual(['another-tenant', 'tenant-1'])
  })

  test('a principal of another tenant is refused', async () => {
    const administration = service()
    await administration.upsertTenant(
      {
        ...TENANT,
        slug: 'another',
        clientId: 'shuttle-another',
      },
      CONTEXT
    )
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-another-tenant',
      },
      CONTEXT
    )
    await expect(
      administration.upsertGrant(
        {
          tenant: 'another',
          userId: principal.principal.id,
          permission: 'workspace.read',
        },
        CONTEXT
      )
    ).rejects.toThrow(/belongs to another tenant/)
  })

  test('a grant is revoked and the revocation is idempotent', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-revocation',
      },
      CONTEXT
    )
    const grant = await administration.upsertGrant(
      {
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'workspace.read',
      },
      CONTEXT
    )
    const audit = await administration.revokeGrant(grant.grant.id, CONTEXT)
    expect(audit.action).toBe('grant.revoked')
    await expect(administration.revokeGrant(grant.grant.id, CONTEXT)).resolves.toBeTruthy()
  })

  test('a grant that does not exist is a not found', async () => {
    const administration = service()
    await expect(administration.revokeGrant('grant-does-not-exist', CONTEXT)).rejects.toThrow(
      /the grant does not exist/
    )
  })
})

describe('the lists of the administration', () => {
  test('the principals of a tenant are listed', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-list',
        email: 'listed@acme.example',
      },
      CONTEXT
    )
    const page = await administration.listPrincipals({ tenant: 'acme' })
    expect(page.total).toBeGreaterThan(0)
    expect(page.principals.some((row) => row.id === principal.principal.id)).toBe(true)
    expect(page.limit).toBe(50)
    expect(page.offset).toBe(0)
  })

  test('the list of the principals is filtered by the status and by the e-mail', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-filter',
        email: 'filtered@acme.example',
      },
      CONTEXT
    )
    await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-disabled-one',
        status: 'disabled',
      },
      CONTEXT
    )
    const byStatus = await administration.listPrincipals({ tenant: 'acme', status: 'disabled' })
    expect(byStatus.principals.every((row) => row.status === 'disabled')).toBe(true)
    expect(byStatus.principals.some((row) => row.id === principal.principal.id)).toBe(false)

    const byEmail = await administration.listPrincipals({
      tenant: 'acme',
      email: 'filtered@acme.example',
    })
    expect(byEmail.principals.map((row) => row.id)).toEqual([principal.principal.id])
  })

  test('the list of the principals is paginated', async () => {
    const administration = service()
    for (let index = 0; index < 3; index += 1) {
      await administration.upsertPrincipal(
        {
          tenant: 'acme',
          externalSubject: `the-subject-of-a-page-${index}`,
        },
        CONTEXT
      )
    }
    const first = await administration.listPrincipals({ tenant: 'acme', limit: '2', offset: '0' })
    const second = await administration.listPrincipals({ tenant: 'acme', limit: '2', offset: '2' })
    expect(first.principals).toHaveLength(2)
    expect(first.total).toBe(second.total)
    const ids = new Set([...first.principals, ...second.principals].map((row) => row.id))
    expect(ids.size).toBe(first.principals.length + second.principals.length)
  })

  test('a limit that is not understood is refused', async () => {
    const administration = service()
    await expect(administration.listPrincipals({ limit: 'many' })).rejects.toThrow(
      /limit must be a whole number/
    )
    await expect(administration.listPrincipals({ limit: '5000' })).rejects.toThrow(
      /limit must be between 1 and 200/
    )
    await expect(administration.listPrincipals({ offset: '-1' })).rejects.toThrow(
      /offset must be a whole number/
    )
    await expect(administration.listPrincipals({ status: 'paused' })).rejects.toThrow(
      /status must be active or disabled/
    )
  })

  test('a tenant that does not exist is a not found', async () => {
    const administration = service()
    await expect(administration.listPrincipals({ tenant: 'nowhere' })).rejects.toThrow(
      /the tenant does not exist/
    )
    await expect(administration.listGrants({ tenant: 'nowhere' })).rejects.toThrow(
      /the tenant does not exist/
    )
  })

  test('the grants of a tenant are listed and they carry who granted them', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-listed-grant',
      },
      CONTEXT
    )
    const grant = await administration.upsertGrant(
      {
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'workspace.list',
        grantedBy: 'ops@acme.example',
      },
      CONTEXT
    )
    const page = await administration.listGrants({ tenant: 'acme' })
    const listed = page.grants.find((row) => row.id === grant.grant.id)
    expect(listed?.grantedBy).toBe('ops@acme.example')
    expect(page.total).toBeGreaterThan(0)
  })

  test('the list of the grants is filtered by the principal and by the life', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-the-live-grant',
      },
      CONTEXT
    )
    await administration.upsertGrant(
      {
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'workspace.live',
      },
      CONTEXT
    )
    const revoked = await administration.upsertGrant(
      {
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'workspace.dead',
      },
      CONTEXT
    )
    await administration.revokeGrant(revoked.grant.id, CONTEXT)

    const live = await administration.listGrants({ tenant: 'acme', live: 'true' })
    expect(live.grants.some((row) => row.id === revoked.grant.id)).toBe(false)

    const dead = await administration.listGrants({ tenant: 'acme', live: 'false' })
    expect(dead.grants.some((row) => row.id === revoked.grant.id)).toBe(true)

    const byPrincipal = await administration.listGrants({
      tenant: 'acme',
      userId: principal.principal.id,
    })
    expect(byPrincipal.grants.every((row) => row.userId === principal.principal.id)).toBe(true)
  })

  test('a live filter that is not understood is refused', async () => {
    const administration = service()
    await expect(administration.listGrants({ live: 'maybe' })).rejects.toThrow(
      /live must be true or false/
    )
  })
})

describe('the groups of the administration', () => {
  test('a group is created with its members', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-member',
      },
      CONTEXT
    )
    const result = await administration.upsertGroup(
      {
        tenant: 'acme',
        key: 'team-platform',
        displayName: 'The platform team',
        members: ['the-subject-of-a-member'],
      },
      CONTEXT
    )
    expect(result.created).toBe(true)
    expect(result.group.key).toBe('team-platform')
    expect(result.group.members).toEqual([principal.principal.id])
    expect(result.audit.action).toBe('group.created')
  })

  test('the membership is replaced by the second call', async () => {
    const administration = service()
    await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-the-first-member',
      },
      CONTEXT
    )
    await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-the-second-member',
      },
      CONTEXT
    )
    await administration.upsertGroup(
      {
        tenant: 'acme',
        key: 'team-replaced',
        members: ['the-subject-of-the-first-member'],
      },
      CONTEXT
    )
    const second = await administration.upsertGroup(
      {
        tenant: 'acme',
        key: 'team-replaced',
        members: ['the-subject-of-the-second-member'],
      },
      CONTEXT
    )
    expect(second.created).toBe(false)
    expect(second.group.members).toHaveLength(1)
    expect(second.audit.action).toBe('group.updated')
  })

  test('a member that is not a principal is a not found', async () => {
    const administration = service()
    await expect(
      administration.upsertGroup(
        {
          tenant: 'acme',
          key: 'team-unknown',
          members: ['the-subject-that-does-not-exist'],
        },
        CONTEXT
      )
    ).rejects.toThrow(/does not exist in the tenant/)
  })

  test('the groups of a tenant are listed', async () => {
    const administration = service()
    await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-a-listed-group',
      },
      CONTEXT
    )
    await administration.upsertGroup(
      {
        tenant: 'acme',
        key: 'team-listed',
        members: ['the-subject-of-a-listed-group'],
      },
      CONTEXT
    )
    const page = await administration.listGroups({ tenant: 'acme' })
    expect(page.total).toBeGreaterThan(0)
    expect(page.groups.some((row) => row.key === 'team-listed')).toBe(true)
    expect(page.limit).toBe(50)
    expect(page.offset).toBe(0)
  })

  test('the list of the groups is filtered by the key', async () => {
    const administration = service()
    await administration.upsertGroup(
      {
        tenant: 'acme',
        key: 'team-filtered',
        members: [],
      },
      CONTEXT
    )
    const page = await administration.listGroups({ tenant: 'acme', key: 'team-filtered' })
    expect(page.groups.length).toBe(1)
    expect(page.groups[0]!.key).toBe('team-filtered')
    expect(page.total).toBe(1)
  })

  test('a tenant that does not exist is a not found', async () => {
    const administration = service()
    await expect(administration.listGroups({ tenant: 'nowhere' })).rejects.toThrow(
      /the tenant does not exist/
    )
  })

  test('a grant of a group is created for the group', async () => {
    const administration = service()
    await administration.upsertGroup(
      {
        tenant: 'acme',
        key: 'team-with-a-grant',
        members: [],
      },
      CONTEXT
    )
    const grant = await administration.upsertGrant(
      {
        tenant: 'acme',
        group: 'team-with-a-grant',
        permission: 'workspace.group',
      },
      CONTEXT
    )
    expect(grant.grant.group).toBe('team-with-a-grant')
    expect(grant.grant.userId).toBeNull()
    expect(grant.audit.action).toBe('grant.created')
  })

  test('a grant names a principal or a group, and not both', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal(
      {
        tenant: 'acme',
        externalSubject: 'the-subject-of-an-ambiguous-grant',
      },
      CONTEXT
    )
    await administration.upsertGroup(
      { tenant: 'acme', key: 'team-ambiguous', members: [] },
      CONTEXT
    )
    await expect(
      administration.upsertGrant(
        {
          tenant: 'acme',
          userId: principal.principal.id,
          group: 'team-ambiguous',
          permission: 'workspace.ambiguous',
        },
        CONTEXT
      )
    ).rejects.toThrow(/names a principal or a group/)
    await expect(
      administration.upsertGrant(
        {
          tenant: 'acme',
          permission: 'workspace.ambiguous',
        },
        CONTEXT
      )
    ).rejects.toThrow(/names a principal or a group/)
  })

  test('a grant of a group that does not exist is a not found', async () => {
    const administration = service()
    await expect(
      administration.upsertGrant(
        {
          tenant: 'acme',
          group: 'team-that-does-not-exist',
          permission: 'workspace.nowhere',
        },
        CONTEXT
      )
    ).rejects.toThrow(/the group does not exist/)
  })
})
