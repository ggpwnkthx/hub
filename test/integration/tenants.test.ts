import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createSecretCipher, SecretError, type NewTenant } from '../../src/platform/postgres'
import { TenantRepository } from '../../src/platform/postgres'
import type { Database } from '../../src/platform/postgres'
import { openTestDatabase } from './database'

let database: Database
let tenants: TenantRepository

/**
 * The fields of a tenant of the tests.
 *
 * The slug, the client id and the domain of the e-mail are unique: the
 * three are unique in the table and a test that breaks one of them has to
 * say so.
 */
function tenantOf(slug: string): NewTenant {
  return {
    slug,
    displayName: 'Acme Inc',
    issuer: `https://login.${slug}.example`,
    idpClientId: `hub-${slug}`,
    idpClientSecret: 'the-secret-of-the-provider',
    idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
    idpScopes: ['openid', 'email', 'profile'],
    idpAlgorithms: ['RS256'],
    emailDomain: `${slug}.example`,
    clientId: `shuttle-${slug}`,
    clientSecret: 'the-secret-of-the-gateway',
  }
}

beforeAll(async () => {
  database = await openTestDatabase()
  tenants = new TenantRepository(database, createSecretCipher('the-key-of-the-deployment'))
})

afterAll(async () => {
  await database.close()
})

describe('the tenants of Hub', () => {
  test('a tenant is created and read back', async () => {
    const created = await tenants.create(tenantOf('acme'))
    expect(created.slug).toBe('acme')
    expect(created.enabled).toBe(true)
    expect(created.autoProvision).toBe(false)
    expect(created.sharedClient).toBe(false)
    expect(created.isDefault).toBe(false)
    expect(created.idpScopes).toEqual(['openid', 'email', 'profile'])

    const found = await tenants.findBySlug('acme')
    expect(found?.id).toBe(created.id)
    expect(found?.displayName).toBe('Acme Inc')
  })

  test('the client secrets are not readable in the table', async () => {
    const created = await tenants.create(tenantOf('secret'))
    const rows = await database.query<{ idp_client_secret: Uint8Array; client_secret: Uint8Array }>(
      'select idp_client_secret, client_secret from tenants where id = $1',
      [created.id]
    )
    const stored = Buffer.from(rows[0]!.idp_client_secret).toString('utf8')
    expect(stored).not.toContain('the-secret-of-the-provider')
    expect(stored).not.toContain('the-secret-of-the-gateway')
  })

  test('the secrets are read back in clear for the caller that needs them', async () => {
    const created = await tenants.create(tenantOf('clear'))
    expect(await tenants.readProviderSecret(created.id)).toBe('the-secret-of-the-provider')
    expect(await tenants.readGatewaySecret(created.id)).toBe('the-secret-of-the-gateway')
  })

  test('a tenant without a key of the deployment cannot be written', async () => {
    const withoutKey = new TenantRepository(database)
    await expect(withoutKey.create(tenantOf('nokey'))).rejects.toThrow(SecretError)
  })

  test('the tenant of a client id, of a domain and of the default', async () => {
    await tenants.create(tenantOf('found'))
    expect((await tenants.findByClientId('shuttle-found'))?.slug).toBe('found')
    expect((await tenants.findByEmailDomain('acme.example'))?.slug).toBe('acme')
    expect(await tenants.findDefault()).toBeNull()

    await tenants.create({ ...tenantOf('the-default'), isDefault: true })
    expect((await tenants.findDefault())?.slug).toBe('the-default')
  })

  test('a change keeps the secrets that are not given', async () => {
    const created = await tenants.create(tenantOf('changed'))
    const updated = await tenants.update(created.id, { displayName: 'Another name' })
    expect(updated?.displayName).toBe('Another name')
    expect(await tenants.readProviderSecret(created.id)).toBe('the-secret-of-the-provider')

    await tenants.update(created.id, { idpClientSecret: 'another-secret' })
    expect(await tenants.readProviderSecret(created.id)).toBe('another-secret')
  })

  test('the listing carries the numbers of the principals and of the grants', async () => {
    const created = await tenants.create(tenantOf('counted'))
    await database.query('insert into users (tenant_id, external_subject) values ($1, $2)', [
      created.id,
      'the-subject',
    ])
    const listed = await tenants.list()
    const tenant = listed.find((row) => row.slug === 'counted')
    expect(tenant?.userCount).toBe(1)
    expect(tenant?.grantCount).toBe(0)
  })

  test('a client id belongs to one tenant', async () => {
    await expect(
      tenants.create({ ...tenantOf('conflict'), clientId: 'shuttle-found' })
    ).rejects.toThrow()
  })
})
