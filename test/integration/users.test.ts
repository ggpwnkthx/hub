import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  TenantRepository,
  UserRepository,
  createSecretCipher,
  type Database,
} from '../../src/platform/postgres'
import { openTestDatabase } from './database'

let database: Database
let tenants: TenantRepository
let users: UserRepository
let tenantId: string

beforeAll(async () => {
  database = await openTestDatabase()
  tenants = new TenantRepository(database, createSecretCipher('the-key-of-the-deployment'))
  users = new UserRepository(database)
  const tenant = await tenants.create({
    slug: 'acme',
    displayName: 'Acme Inc',
    issuer: 'https://login.acme.example',
    idpClientId: 'hub-acme',
    idpClientSecret: 'the-secret-of-the-provider',
    idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
    idpScopes: ['openid'],
    idpAlgorithms: ['RS256'],
    clientId: 'shuttle-acme',
    clientSecret: 'the-secret-of-the-gateway',
  })
  tenantId = tenant.id
})

afterAll(async () => {
  await database.close()
})

describe('the principals of Hub', () => {
  test('a principal is created and read back', async () => {
    const created = await users.create({
      tenantId,
      externalSubject: '00u1a2b3c4d5',
      email: 'alice@acme.example',
      displayName: 'Alice',
    })
    expect(created.status).toBe('active')
    expect(created.email).toBe('alice@acme.example')
    expect(created.lastLoginAt).toBeNull()

    const found = await users.findByExternalSubject(tenantId, '00u1a2b3c4d5')
    expect(found?.id).toBe(created.id)
  })

  test('the mapping key is the pair (tenant, subject)', async () => {
    await users.create({ tenantId, externalSubject: 'the-subject', email: 'alice@acme.example' })
    const other = await tenants.create({
      slug: 'other',
      displayName: 'Other',
      issuer: 'https://login.other.example',
      idpClientId: 'hub-other',
      idpClientSecret: 'secret',
      idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
      idpScopes: ['openid'],
      idpAlgorithms: ['RS256'],
      clientId: 'shuttle-other',
      clientSecret: 'secret',
    })
    // The same subject in another tenant is another principal.
    const found = await users.findByExternalSubject(other.id, 'the-subject')
    expect(found).toBeNull()
    // The same subject in the same tenant is the same principal.
    expect((await users.findByExternalSubject(tenantId, 'the-subject'))?.externalSubject).toBe(
      'the-subject'
    )
  })

  test('a principal is disabled and enabled again', async () => {
    const created = await users.create({ tenantId, externalSubject: 'disabled-subject' })
    const disabled = await users.update(created.id, { status: 'disabled' })
    expect(disabled?.status).toBe('disabled')
    const enabled = await users.update(created.id, { status: 'active' })
    expect(enabled?.status).toBe('active')
  })

  test('the last login is stamped', async () => {
    const created = await users.create({ tenantId, externalSubject: 'login-subject' })
    await users.touchLogin(created.id)
    const found = await users.findById(created.id)
    expect(found?.lastLoginAt).toBeInstanceOf(Date)
  })

  test('the principals of a tenant are listed', async () => {
    const listed = await users.findByTenant(tenantId)
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.every((row) => row.tenantId === tenantId)).toBe(true)
  })
})
