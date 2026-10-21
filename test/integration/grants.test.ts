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

let database: Database
let grants: GrantRepository
let tenantId: string
let userId: string
let permissionId: string

beforeAll(async () => {
  database = await openTestDatabase()
  const tenants = new TenantRepository(database, createSecretCipher('the-key-of-the-deployment'))
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

  const users = new UserRepository(database)
  const principal = await users.create({ tenantId, externalSubject: 'the-subject' })
  userId = principal.id

  const permissions = new PermissionRepository(database)
  const permission = await permissions.create({ tenantId, key: 'workspace.read' })
  permissionId = permission.id

  grants = new GrantRepository(database)
})

afterAll(async () => {
  await database.close()
})

describe('the grants of Hub', () => {
  test('a grant is created and read back', async () => {
    const created = await grants.create({
      tenantId,
      userId,
      groupId: null,
      permissionId,
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
      grantedBy: 'the-operator',
    })
    expect(created.revokedAt).toBeNull()
    expect(created.expiresAt).toBeNull()
    expect(created.workspaceId).toBe('11111111-1111-4111-8111-111111111111')
    expect(created.routeId).toBe('workspace-api')

    const found = await grants.findLive(
      tenantId,
      { userId, groupId: null },
      permissionId,
      '11111111-1111-4111-8111-111111111111',
      'workspace-api'
    )
    expect(found?.id).toBe(created.id)
  })

  test('a grant of every workspace is not a grant of a workspace', async () => {
    const every = await grants.create({ tenantId, userId, groupId: null, permissionId })
    const scoped = await grants.findLive(
      tenantId,
      { userId, groupId: null },
      permissionId,
      'a-workspace',
      null
    )
    expect(scoped).toBeNull()
    const all = await grants.findLive(tenantId, { userId, groupId: null }, permissionId, null, null)
    expect(all?.id).toBe(every.id)
  })

  test('the live grants of a principal are the ones that are not revoked', async () => {
    const created = await grants.create({
      tenantId,
      userId,
      groupId: null,
      permissionId,
      routeId: 'to-revoke',
    })
    const live = await grants.findLiveByUser(userId)
    expect(live.some((row) => row.id === created.id)).toBe(true)

    await grants.revoke(created.id)
    const after = await grants.findLiveByUser(userId)
    expect(after.some((row) => row.id === created.id)).toBe(false)
  })

  test('a revoked grant is kept and the revocation is idempotent', async () => {
    const created = await grants.create({
      tenantId,
      userId,
      groupId: null,
      permissionId,
      routeId: 'kept',
    })
    const revoked = await grants.revoke(created.id)
    expect(revoked?.revokedAt).toBeInstanceOf(Date)
    const again = await grants.revoke(created.id)
    expect(again?.revokedAt?.getTime()).toBe(revoked?.revokedAt?.getTime())
    // The row is kept: the history of the policy is worth more than the
    // bytes.
    expect((await grants.findById(created.id))?.id).toBe(created.id)
  })

  test('an expired grant is not live', async () => {
    await grants.create({
      tenantId,
      userId,
      groupId: null,
      permissionId,
      routeId: 'expired',
      expiresAt: new Date(Date.now() - 60_000),
    })
    const live = await grants.findLiveByUser(userId)
    expect(live.some((row) => row.routeId === 'expired')).toBe(false)
  })

  test('the grants of a tenant and of a principal are listed', async () => {
    const byTenant = await grants.findByTenant(tenantId)
    expect(byTenant.length).toBeGreaterThan(0)
    const byUser = await grants.findByUser(userId)
    expect(byUser.every((row) => row.userId === userId)).toBe(true)
  })
})

describe('the list of the grants', () => {
  test('the list is filtered by the tenant, by the principal and by the life', async () => {
    const page = await grants.list({
      tenantId,
      userId: null,
      live: null,
      limit: 50,
      offset: 0,
    })
    expect(page.total).toBeGreaterThan(0)
    expect(page.rows.every((row) => row.tenantId === tenantId)).toBe(true)

    const live = await grants.list({ tenantId, userId: null, live: true, limit: 50, offset: 0 })
    const now = new Date()
    expect(
      live.rows.every(
        (row) =>
          row.revokedAt === null &&
          (row.expiresAt === null || row.expiresAt.getTime() > now.getTime())
      )
    ).toBe(true)

    const dead = await grants.list({ tenantId, userId: null, live: false, limit: 50, offset: 0 })
    expect(dead.rows.every((row) => row.revokedAt !== null || row.expiresAt !== null)).toBe(true)
  })

  test('the list is paginated and the order is stable', async () => {
    const permissions = new PermissionRepository(database)
    const permission = await permissions.create({ tenantId, key: 'workspace.listed' })
    for (let index = 0; index < 4; index += 1) {
      await grants.create({
        tenantId,
        userId,
        groupId: null,
        permissionId: permission.id,
        workspaceId: null,
        routeId: `route-${index}`,
        expiresAt: null,
        grantedBy: 'the-operator',
      })
    }
    const first = await grants.list({
      tenantId,
      userId: null,
      live: null,
      limit: 2,
      offset: 0,
    })
    const second = await grants.list({
      tenantId,
      userId: null,
      live: null,
      limit: 2,
      offset: 2,
    })
    expect(first.rows).toHaveLength(2)
    expect(second.rows).toHaveLength(2)
    const ids = [...first.rows, ...second.rows].map((row) => row.id)
    expect(new Set(ids).size).toBe(4)
    expect(first.total).toBe(second.total)
  })
})

describe('the grants of a group', () => {
  test('the live grants of a principal include the grants of its groups', async () => {
    const groups = new GroupRepository(database)
    const users = new UserRepository(database)
    const permissions = new PermissionRepository(database)

    const member = await users.create({ tenantId, externalSubject: 'the-subject-of-a-member' })
    const outsider = await users.create({ tenantId, externalSubject: 'the-subject-of-an-outsider' })
    const group = await groups.create({
      tenantId,
      key: 'team-integration',
      displayName: 'The team of the integration',
      members: [member.id],
    })
    const permission = await permissions.create({ tenantId, key: 'workspace.team' })
    const grant = await grants.create({
      tenantId,
      userId: null,
      groupId: group.id,
      permissionId: permission.id,
      workspaceId: null,
      routeId: null,
      expiresAt: null,
      grantedBy: 'the-operator',
    })
    expect(grant.groupId).toBe(group.id)
    expect(grant.userId).toBeNull()
    expect(grant.groupKey).toBe('team-integration')

    // The roles of the member carry the permission of the group.
    const roles = await grants.findLivePermissionKeys(member.id)
    expect(roles).toContain('workspace.team')
    // The roles of the outsider do not.
    const others = await grants.findLivePermissionKeys(outsider.id)
    expect(others).not.toContain('workspace.team')
  })

  test('the membership is replaced and the access of the leaver ends', async () => {
    const groups = new GroupRepository(database)
    const users = new UserRepository(database)
    const member = await users.create({ tenantId, externalSubject: 'the-subject-of-a-leaver' })
    const group = await groups.findByKey(tenantId, 'team-integration')
    expect(group).toBeTruthy()

    const updated = await groups.update(group!.id, { members: [] })
    expect(updated?.members).toEqual([])
    const roles = await grants.findLivePermissionKeys(member.id)
    expect(roles).not.toContain('workspace.team')
  })
})
