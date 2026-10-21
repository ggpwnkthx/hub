import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  GrantRepository,
  GroupRepository,
  PermissionRepository,
  TenantRepository,
  UserRepository,
  createSecretCipher,
  type Database,
} from '../../src/platform/postgres'
import { openTestDatabase } from './database'

/**
 * The audit of the administration is written by the statement that
 * changes the thing (spec §9.1, invariant 6).
 *
 * A change that is not audited does not exist: when the write of the
 * audit fails, the change is rolled back with it. These tests make the
 * write of the audit fail and check that the row of the change is not
 * there.
 */

let database: Database
let tenants: TenantRepository
let users: UserRepository
let permissions: PermissionRepository
let groups: GroupRepository
let grants: GrantRepository
let tenantId: string
let userId: string
let permissionId: string

/** The audit of a change, as the administration asks for it. */
const AUDIT = {
  action: 'grant.created',
  tenant: 'acme',
  operator: 'the-fingerprint',
  address: '10.0.0.1',
  requestId: 'the-request',
}

beforeAll(async () => {
  database = await openTestDatabase()
  tenants = new TenantRepository(database, createSecretCipher('the-key-of-the-deployment'))
  const tenant = await tenants.create({
    slug: 'acme',
    displayName: 'Acme Inc',
    issuer: 'https://login.acme.example',
    idpClientId: 'hub-acme',
    idpClientSecret: 'secret',
    idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
    idpScopes: ['openid'],
    idpAlgorithms: ['RS256'],
    clientId: 'shuttle-acme',
    clientSecret: 'secret',
  })
  tenantId = tenant.id

  users = new UserRepository(database)
  const principal = await users.create({ tenantId, externalSubject: 'the-subject' })
  userId = principal.id

  permissions = new PermissionRepository(database)
  const permission = await permissions.create({ tenantId, key: 'workspace.read' })
  permissionId = permission.id

  groups = new GroupRepository(database)
  grants = new GrantRepository(database)
})

afterAll(async () => {
  await database.close()
})

/**
 * Makes the write of the audit fail.
 *
 * The constraint is removed at the end of the test, so the tests that
 * follow are not affected by it.
 */
async function withFailingAudit(refused: string, body: () => Promise<void>): Promise<void> {
  // The constraint is added without being validated: the rows that are
  // already in the table are not checked, and the rows that are written
  // from now on are.
  await database.exec(
    `alter table admin_audit add constraint the_audit_refuses check (action <> '${refused}') not valid`
  )
  try {
    await body()
  } finally {
    await database.exec(`alter table admin_audit drop constraint the_audit_refuses`)
  }
}

describe('the audit of the administration', () => {
  test('the creation of a grant writes the row of the audit', async () => {
    const created = await grants.create(
      {
        tenantId,
        userId,
        groupId: null,
        permissionId,
        workspaceId: null,
        routeId: null,
        expiresAt: null,
        grantedBy: 'the-operator',
      },
      AUDIT
    )
    const rows = await database.query<{ action: string; target_id: string; tenant: string }>(
      `select action, target_id, tenant from admin_audit where target_id = $1`,
      [created.id]
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.action).toBe('grant.created')
    expect(rows[0]!.tenant).toBe('acme')
  })

  test('the creation of a grant is rolled back when the audit fails', async () => {
    await withFailingAudit('grant.created', async () => {
      await expect(
        grants.create(
          {
            tenantId,
            userId,
            groupId: null,
            permissionId,
            workspaceId: 'the-workspace-of-the-failure',
            routeId: null,
            expiresAt: null,
            grantedBy: 'the-operator',
          },
          AUDIT
        )
      ).rejects.toThrow()
    })
    // The grant is not there: a change that is not audited does not
    // exist.
    const grantsOfTheFailure = await grants.findLive(
      tenantId,
      { userId, groupId: null },
      permissionId,
      'the-workspace-of-the-failure',
      null
    )
    expect(grantsOfTheFailure).toBeNull()
  })

  test('the change of a grant is rolled back when the audit fails', async () => {
    const created = await grants.create(
      {
        tenantId,
        userId,
        groupId: null,
        permissionId,
        workspaceId: 'the-workspace-of-the-change',
        routeId: null,
        expiresAt: null,
        grantedBy: 'the-operator',
      },
      AUDIT
    )
    await withFailingAudit('grant.updated', async () => {
      await expect(
        grants.update(
          created.id,
          { expiresAt: new Date('2030-01-01T00:00:00.000Z') },
          {
            ...AUDIT,
            action: 'grant.updated',
          }
        )
      ).rejects.toThrow()
    })
    // The grant is still there, and it is not expired: the change was
    // rolled back with the audit that failed.
    const rows = await database.query<{ expires_at: Date | null }>(
      `select expires_at from grants where id = $1`,
      [created.id]
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.expires_at).toBeNull()
  })

  test('the revocation of a grant is rolled back when the audit fails', async () => {
    const created = await grants.create(
      {
        tenantId,
        userId,
        groupId: null,
        permissionId,
        workspaceId: 'the-workspace-of-the-revocation',
        routeId: null,
        expiresAt: null,
        grantedBy: 'the-operator',
      },
      AUDIT
    )
    await withFailingAudit('grant.revoked', async () => {
      await expect(
        grants.revoke(created.id, { ...AUDIT, action: 'grant.revoked' })
      ).rejects.toThrow()
    })
    const rows = await database.query<{ revoked_at: Date | null }>(
      `select revoked_at from grants where id = $1`,
      [created.id]
    )
    expect(rows.length).toBe(1)
    expect(rows[0]!.revoked_at).toBeNull()
  })

  test('the creation of a principal is rolled back when the audit fails', async () => {
    await withFailingAudit('principal.created', async () => {
      await expect(
        users.create(
          { tenantId, externalSubject: 'the-subject-of-the-failure' },
          { ...AUDIT, action: 'principal.created' }
        )
      ).rejects.toThrow()
    })
    const principal = await users.findByExternalSubject(tenantId, 'the-subject-of-the-failure')
    expect(principal).toBeNull()
  })

  test('the creation of a tenant is rolled back when the audit fails', async () => {
    await withFailingAudit('tenant.created', async () => {
      await expect(
        tenants.create(
          {
            slug: 'the-tenant-of-the-failure',
            displayName: 'The tenant of the failure',
            issuer: 'https://login.failure.example',
            idpClientId: 'hub-failure',
            idpClientSecret: 'secret',
            idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
            idpScopes: ['openid'],
            idpAlgorithms: ['RS256'],
            clientId: 'shuttle-failure',
            clientSecret: 'secret',
          },
          { ...AUDIT, action: 'tenant.created', tenant: 'the-tenant-of-the-failure' }
        )
      ).rejects.toThrow()
    })
    const tenant = await tenants.findBySlug('the-tenant-of-the-failure')
    expect(tenant).toBeNull()
  })

  test('the creation of a group is rolled back when the audit fails', async () => {
    await withFailingAudit('group.created', async () => {
      await expect(
        groups.create(
          { tenantId, key: 'the-group-of-the-failure', displayName: null, members: [] },
          { ...AUDIT, action: 'group.created' }
        )
      ).rejects.toThrow()
    })
    const group = await groups.findByKey(tenantId, 'the-group-of-the-failure')
    expect(group).toBeNull()
  })

  test('a caller that is not the administration writes no row of the audit', async () => {
    const before = await database.query<{ count: number }>(
      `select count(*)::int as count from admin_audit`
    )
    await users.create({ tenantId, externalSubject: 'the-subject-of-the-login' })
    const after = await database.query<{ count: number }>(
      `select count(*)::int as count from admin_audit`
    )
    expect(after[0]!.count).toBe(before[0]!.count)
  })

  test('a call that changes nothing is still audited', async () => {
    const before = await database.query<{ count: number }>(
      `select count(*)::int as count from admin_audit`
    )
    // The change carries no field: the row of the principal keeps its
    // values, and the row of the audit is written all the same.
    await users.update(userId, {}, { ...AUDIT, action: 'principal.updated' })
    const after = await database.query<{ count: number }>(
      `select count(*)::int as count from admin_audit`
    )
    expect(after[0]!.count).toBe(before[0]!.count + 1)
    const principal = await users.findById(userId)
    expect(principal?.externalSubject).toBe('the-subject')
  })
})
