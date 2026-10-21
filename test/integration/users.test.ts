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

describe('the list of the principals', () => {
  test('the list is paginated and the order is stable', async () => {
    const tenant = await tenants.create({
      slug: 'listed',
      displayName: 'Listed',
      issuer: 'https://login.listed.example',
      idpClientId: 'hub-listed',
      idpClientSecret: 'secret',
      idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
      idpScopes: ['openid'],
      idpAlgorithms: ['RS256'],
      clientId: 'shuttle-listed',
      clientSecret: 'secret',
    })
    for (let index = 0; index < 5; index += 1) {
      await users.create({
        tenantId: tenant.id,
        externalSubject: `subject-${index}`,
        email: `person-${index}@listed.example`,
      })
    }

    const all = await users.list({
      tenantId: tenant.id,
      status: null,
      email: null,
      limit: 50,
      offset: 0,
    })
    expect(all.total).toBe(5)
    expect(all.rows).toHaveLength(5)

    const first = await users.list({
      tenantId: tenant.id,
      status: null,
      email: null,
      limit: 2,
      offset: 0,
    })
    const second = await users.list({
      tenantId: tenant.id,
      status: null,
      email: null,
      limit: 2,
      offset: 2,
    })
    const third = await users.list({
      tenantId: tenant.id,
      status: null,
      email: null,
      limit: 2,
      offset: 4,
    })
    expect(first.rows).toHaveLength(2)
    expect(third.rows).toHaveLength(1)
    // The pages do not overlap and they do not skip a row.
    const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id)
    expect(new Set(ids).size).toBe(5)
  })

  test('the list is filtered by the tenant, by the status and by the e-mail', async () => {
    const page = await users.list({
      tenantId: null,
      status: null,
      email: 'person-0@listed.example',
      limit: 50,
      offset: 0,
    })
    expect(page.total).toBe(1)
    expect(page.rows[0]?.email).toBe('person-0@listed.example')

    const disabled = await users.list({
      tenantId: null,
      status: 'disabled',
      email: null,
      limit: 50,
      offset: 0,
    })
    expect(disabled.rows.every((row) => row.status === 'disabled')).toBe(true)
  })
})
