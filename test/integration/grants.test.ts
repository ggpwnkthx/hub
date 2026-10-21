import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  GrantRepository,
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
      userId,
      permissionId,
      '11111111-1111-4111-8111-111111111111',
      'workspace-api'
    )
    expect(found?.id).toBe(created.id)
  })

  test('a grant of every workspace is not a grant of a workspace', async () => {
    const every = await grants.create({ tenantId, userId, permissionId })
    const scoped = await grants.findLive(tenantId, userId, permissionId, 'a-workspace', null)
    expect(scoped).toBeNull()
    const all = await grants.findLive(tenantId, userId, permissionId, null, null)
    expect(all?.id).toBe(every.id)
  })

  test('the live grants of a principal are the ones that are not revoked', async () => {
    const created = await grants.create({ tenantId, userId, permissionId, routeId: 'to-revoke' })
    const live = await grants.findLiveByUser(userId)
    expect(live.some((row) => row.id === created.id)).toBe(true)

    await grants.revoke(created.id)
    const after = await grants.findLiveByUser(userId)
    expect(after.some((row) => row.id === created.id)).toBe(false)
  })

  test('a revoked grant is kept and the revocation is idempotent', async () => {
    const created = await grants.create({ tenantId, userId, permissionId, routeId: 'kept' })
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
