import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  PermissionRepository,
  TenantRepository,
  createSecretCipher,
  type Database,
} from '../../src/platform/postgres'
import { openTestDatabase } from './database'

let database: Database
let permissions: PermissionRepository
let tenantId: string

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
  permissions = new PermissionRepository(database)
})

afterAll(async () => {
  await database.close()
})

describe('the permissions of Hub', () => {
  test('a permission of a tenant is created and read back', async () => {
    const created = await permissions.create({ tenantId, key: 'workspace.read' })
    expect(created.enabled).toBe(true)
    expect(created.tenantId).toBe(tenantId)
    expect((await permissions.findByTenantAndKey(tenantId, 'workspace.read'))?.id).toBe(created.id)
  })

  test('a permission of the catalogue belongs to every tenant', async () => {
    const created = await permissions.create({ key: 'platform.read' })
    expect(created.tenantId).toBeNull()
    expect((await permissions.findCataloguePermission('platform.read'))?.id).toBe(created.id)

    const listed = await permissions.findByTenant(tenantId)
    expect(listed.some((row) => row.key === 'platform.read')).toBe(true)
    expect(listed.some((row) => row.key === 'workspace.read')).toBe(true)
  })

  test('the catalogue holds one row per key', async () => {
    await expect(permissions.create({ key: 'platform.read' })).rejects.toThrow()
  })

  test('a permission is disabled and enabled again', async () => {
    const created = await permissions.create({ tenantId, key: 'workspace.write' })
    const disabled = await permissions.setEnabled(created.id, false)
    expect(disabled?.enabled).toBe(false)
    const enabled = await permissions.setEnabled(created.id, true)
    expect(enabled?.enabled).toBe(true)
  })
})
