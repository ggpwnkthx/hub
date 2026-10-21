import { describe, expect, test } from 'bun:test'
import { sameSecret } from '../../observability'
import {
  AdministrationError,
  AdministrationService,
  FailedAuthenticationLimiter,
  type Grant,
  type GrantStore,
  type Permission,
  type PermissionStore,
  type Principal,
  type PrincipalStore,
  type Tenant,
  type TenantStore,
  type TenantSummary,
} from './index'

/** The storage of the tenants of the tests. */
class FakeTenants implements TenantStore {
  readonly rows: Tenant[] = []

  async findBySlug(slug: string): Promise<Tenant | null> {
    return this.rows.find((row) => row.slug === slug) ?? null
  }

  async findByClientId(clientId: string): Promise<Tenant | null> {
    return this.rows.find((row) => row.clientId === clientId) ?? null
  }

  async list(): Promise<TenantSummary[]> {
    return this.rows.map((row) => ({ ...row, userCount: 0, grantCount: 0 }))
  }

  async create(registration: {
    slug: string
    displayName: string
    issuer: string
    emailDomain: string | null
    clientId: string
    autoProvision: boolean
    sharedClient: boolean
    isDefault: boolean
    enabled: boolean
  }): Promise<Tenant> {
    const tenant: Tenant = {
      id: `tenant-${this.rows.length + 1}`,
      slug: registration.slug,
      displayName: registration.displayName,
      issuer: registration.issuer,
      emailDomain: registration.emailDomain,
      clientId: registration.clientId,
      autoProvision: registration.autoProvision,
      sharedClient: registration.sharedClient,
      isDefault: registration.isDefault,
      enabled: registration.enabled,
      createdAt: new Date('2026-01-08T10:00:00.000Z'),
    }
    this.rows.push(tenant)
    return tenant
  }

  async update(id: string, changes: Partial<Tenant>): Promise<Tenant | null> {
    const tenant = this.rows.find((row) => row.id === id)
    if (!tenant) return null
    Object.assign(tenant, changes)
    return tenant
  }
}

/** The storage of the principals of the tests. */
class FakePrincipals implements PrincipalStore {
  readonly rows: Principal[] = []

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

  async create(registration: {
    tenantId: string
    externalSubject: string
    email?: string | null
    displayName?: string | null
    status?: 'active' | 'disabled'
  }): Promise<Principal> {
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
    changes: { email?: string | null; displayName?: string | null; status?: 'active' | 'disabled' }
  ): Promise<Principal | null> {
    const principal = this.rows.find((row) => row.id === id)
    if (!principal) return null
    Object.assign(principal, changes)
    return principal
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
}

/** The storage of the grants of the tests. */
class FakeGrants implements GrantStore {
  readonly rows: Grant[] = []

  async findById(id: string): Promise<Grant | null> {
    return this.rows.find((row) => row.id === id) ?? null
  }

  async findLive(
    tenantId: string,
    userId: string,
    permissionId: string,
    workspaceId: string | null,
    routeId: string | null
  ): Promise<Grant | null> {
    return (
      this.rows.find(
        (row) =>
          row.tenant === TENANTS.rows.find((t) => t.id === tenantId)?.slug &&
          row.userId === userId &&
          row.permission === PERMISSIONS.rows.find((p) => p.id === permissionId)?.key &&
          row.workspaceId === workspaceId &&
          row.routeId === routeId &&
          row.revokedAt === null
      ) ?? null
    )
  }

  async create(registration: {
    tenantId: string
    userId: string
    permissionId: string
    workspaceId: string | null
    routeId: string | null
    expiresAt: Date | null
    grantedBy: string | null
  }): Promise<Grant> {
    const tenant = TENANTS.rows.find((row) => row.id === registration.tenantId)
    const permission = PERMISSIONS.rows.find((row) => row.id === registration.permissionId)
    const grant: Grant = {
      id: `grant-${this.rows.length + 1}`,
      tenant: tenant?.slug ?? '',
      userId: registration.userId,
      permission: permission?.key ?? '',
      workspaceId: registration.workspaceId,
      routeId: registration.routeId,
      expiresAt: registration.expiresAt,
      revokedAt: null,
      createdAt: new Date('2026-01-08T10:06:00.000Z'),
    }
    this.rows.push(grant)
    return grant
  }

  async update(
    id: string,
    changes: { expiresAt?: Date | null; grantedBy?: string | null }
  ): Promise<Grant | null> {
    const grant = this.rows.find((row) => row.id === id)
    if (!grant) return null
    Object.assign(grant, changes)
    return grant
  }

  async revoke(id: string): Promise<Grant | null> {
    const grant = this.rows.find((row) => row.id === id)
    if (!grant) return null
    grant.revokedAt = new Date('2026-01-08T11:00:00.000Z')
    return grant
  }
}

const TENANTS = new FakeTenants()
const PRINCIPALS = new FakePrincipals()
const PERMISSIONS = new FakePermissions()
const GRANTS = new FakeGrants()

/** The service of the tests. */
function service(options: { token?: string; limiter?: FailedAuthenticationLimiter } = {}) {
  return new AdministrationService({
    tenants: TENANTS,
    principals: PRINCIPALS,
    permissions: PERMISSIONS,
    grants: GRANTS,
    token: options.token ?? 'the-admin-token',
    publicUrl: 'https://hub.example.com',
    limiter: options.limiter,
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

  test('a missing token is refused', () => {
    expect(() => service().authenticate(undefined, '10.0.0.1')).toThrow(AdministrationError)
    expect(() => service().authenticate('Bearer wrong', '10.0.0.1')).toThrow(
      /a valid administration token/
    )
  })

  test('the right token is accepted', () => {
    expect(() => service().authenticate('Bearer the-admin-token', '10.0.0.1')).not.toThrow()
  })

  test('a deployment without a token has no administrative surface', () => {
    const administration = new AdministrationService({
      tenants: TENANTS,
      principals: PRINCIPALS,
      permissions: PERMISSIONS,
      grants: GRANTS,
      publicUrl: 'https://hub.example.com',
    })
    expect(() => administration.authenticate('Bearer the-admin-token', '10.0.0.1')).toThrow(
      /a valid administration token/
    )
  })

  test('a burst of failed authentications is refused', () => {
    const administration = service({ limiter: new FailedAuthenticationLimiter({ max: 3 }) })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => administration.authenticate('Bearer wrong', '10.0.0.2')).toThrow(
        AdministrationError
      )
    }
    let refused = false
    try {
      administration.authenticate('Bearer wrong', '10.0.0.2')
    } catch (error) {
      refused = error instanceof AdministrationError && error.code === 'too_many_requests'
    }
    expect(refused).toBe(true)
    // The right token does not open the door of an address that is
    // hammering the endpoint.
    expect(() => administration.authenticate('Bearer the-admin-token', '10.0.0.2')).toThrow(
      /too many failed authentications/
    )
    // Another address is not affected.
    expect(() => administration.authenticate('Bearer the-admin-token', '10.0.0.3')).not.toThrow()
  })

  test('a success clears the failures of the address', () => {
    const limiter = new FailedAuthenticationLimiter({ max: 2 })
    const administration = service({ limiter })
    expect(() => administration.authenticate('Bearer wrong', '10.0.0.4')).toThrow()
    expect(() => administration.authenticate('Bearer the-admin-token', '10.0.0.4')).not.toThrow()
    expect(limiter.count('10.0.0.4')).toBe(0)
  })
})

describe('the tenants of the administration', () => {
  test('a tenant is created and then changed', async () => {
    const administration = service()
    const created = await administration.upsertTenant(TENANT)
    expect(created.created).toBe(true)
    expect(created.audit.action).toBe('tenant.created')

    const updated = await administration.upsertTenant({ ...TENANT, displayName: 'Another name' })
    expect(updated.created).toBe(false)
    expect(updated.audit.action).toBe('tenant.updated')
    expect(updated.tenant.displayName).toBe('Another name')
  })

  test('a client id belongs to one tenant', async () => {
    const administration = service()
    await expect(
      administration.upsertTenant({ ...TENANT, slug: 'another', clientId: 'shuttle-acme' })
    ).rejects.toThrow(/belongs to another tenant/)
  })

  test('at most one tenant is the default', async () => {
    const administration = service()
    await administration.upsertTenant({
      ...TENANT,
      slug: 'first',
      clientId: 'shuttle-first',
      isDefault: true,
    })
    await expect(
      administration.upsertTenant({
        ...TENANT,
        slug: 'second',
        clientId: 'shuttle-second',
        isDefault: true,
      })
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
    const created = await administration.upsertPrincipal({
      tenant: 'acme',
      externalSubject: '00u1a2b3c4d5',
      email: 'alice@acme.example',
    })
    expect(created.created).toBe(true)
    expect(created.principal.status).toBe('active')

    const updated = await administration.upsertPrincipal({
      tenant: 'acme',
      externalSubject: '00u1a2b3c4d5',
      status: 'disabled',
    })
    expect(updated.created).toBe(false)
    expect(updated.principal.status).toBe('disabled')
  })

  test('an unknown tenant is a not found', async () => {
    const administration = service()
    await expect(
      administration.upsertPrincipal({ tenant: 'unknown', externalSubject: 'sub' })
    ).rejects.toThrow(/the tenant does not exist/)
  })
})

describe('the grants of the administration', () => {
  test('a grant is created and the permission is created on demand', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal({
      tenant: 'acme',
      externalSubject: 'the-subject-of-a-grant',
    })
    const grant = await administration.upsertGrant({
      tenant: 'acme',
      userId: principal.principal.id,
      permission: 'workspace.read',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
    })
    expect(grant.grant.permission).toBe('workspace.read')
    expect(grant.audit.action).toBe('grant.created')
    expect(PERMISSIONS.rows.some((row) => row.key === 'workspace.read')).toBe(true)
  })

  test('a permission of the catalogue is reused', async () => {
    const administration = service()
    await PERMISSIONS.create({ tenantId: null, key: 'platform.read' })
    const principal = await administration.upsertPrincipal({
      tenant: 'acme',
      externalSubject: 'the-subject-of-the-catalogue',
    })
    const grant = await administration.upsertGrant({
      tenant: 'acme',
      userId: principal.principal.id,
      permission: 'platform.read',
    })
    expect(grant.grant.permission).toBe('platform.read')
    expect(PERMISSIONS.rows.filter((row) => row.key === 'platform.read')).toHaveLength(1)
  })

  test('a permission of another tenant is refused', async () => {
    const administration = service()
    await PERMISSIONS.create({ tenantId: 'another-tenant', key: 'workspace.write' })
    const principal = await administration.upsertPrincipal({
      tenant: 'acme',
      externalSubject: 'the-subject-of-another-tenant',
    })
    await expect(
      administration.upsertGrant({
        tenant: 'acme',
        userId: principal.principal.id,
        permission: 'workspace.write',
      })
    ).rejects.toThrow(/belongs to another tenant/)
  })

  test('a principal of another tenant is refused', async () => {
    const administration = service()
    await administration.upsertTenant({
      ...TENANT,
      slug: 'another',
      clientId: 'shuttle-another',
    })
    const principal = await administration.upsertPrincipal({
      tenant: 'acme',
      externalSubject: 'the-subject-of-another-tenant',
    })
    await expect(
      administration.upsertGrant({
        tenant: 'another',
        userId: principal.principal.id,
        permission: 'workspace.read',
      })
    ).rejects.toThrow(/belongs to another tenant/)
  })

  test('a grant is revoked and the revocation is idempotent', async () => {
    const administration = service()
    const principal = await administration.upsertPrincipal({
      tenant: 'acme',
      externalSubject: 'the-subject-of-a-revocation',
    })
    const grant = await administration.upsertGrant({
      tenant: 'acme',
      userId: principal.principal.id,
      permission: 'workspace.read',
    })
    const audit = await administration.revokeGrant(grant.grant.id)
    expect(audit.action).toBe('grant.revoked')
    await expect(administration.revokeGrant(grant.grant.id)).resolves.toBeTruthy()
  })

  test('a grant that does not exist is a not found', async () => {
    const administration = service()
    await expect(administration.revokeGrant('grant-does-not-exist')).rejects.toThrow(
      /the grant does not exist/
    )
  })
})
