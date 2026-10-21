import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  TenantRepository,
  UserRepository,
  bypassesRowLevelSecurity,
  createSecretCipher,
  type Database,
} from '../../src/platform/postgres'
import { againstServer, openTestDatabase } from './database'

/**
 * The isolation of the tenants, enforced by the database.
 *
 * The test does not trust the application: it connects as a role that is
 * subject to the policies of the tables, it opens a scope of a tenant and
 * it reads the rows of the platform. The rows of the other tenant are not
 * there.
 */
let database: Database
let acme: string
let other: string

/**
 * Drops a role of the test, with the privileges that were granted to it.
 *
 * The role is a role of the database and not of the schema of the test:
 * a database that is used twice has to be able to run the test again.
 */
async function dropRole(name: string): Promise<void> {
  await database.exec(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = '${name}') then
        execute 'drop owned by ${name}';
        execute 'drop role ${name}';
      end if;
    end $$;
  `)
}

beforeAll(async () => {
  database = await openTestDatabase()
  const tenants = new TenantRepository(database, createSecretCipher('the-key-of-the-deployment'))
  const first = await tenants.create({
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
  const second = await tenants.create({
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
  acme = first.id
  other = second.id

  const users = new UserRepository(database)
  await users.create({ tenantId: acme, externalSubject: 'the-subject-of-acme' })
  await users.create({ tenantId: other, externalSubject: 'the-subject-of-other' })
})

afterAll(async () => {
  await database.close()
})

describe('the isolation of the tenants', () => {
  test('the policies of the tables are there', async () => {
    const rows = await database.query<{ table_name: string; enabled: boolean; forced: boolean }>(
      `select c.relname as table_name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = current_schema()
         and c.relname in ('tenants', 'users', 'permissions', 'grants', 'groups')
       order by c.relname`
    )
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.enabled).toBe(true)
      expect(row.forced).toBe(true)
    }
  })

  test('a scope of a tenant hides the rows of the other tenants', async () => {
    // The role of the test is not a superuser: the policies are the rules
    // for it. It needs the usage of the schema of the test: a role
    // without it does not see the tables at all.
    const schema = await database.query<{ name: string }>(`select current_schema() as name`)
    const schemaName = schema[0]!.name
    await dropRole('hub_isolation_test')
    await database.exec(`create role hub_isolation_test`)
    await database.exec(`grant usage on schema "${schemaName}" to hub_isolation_test`)
    await database.exec(
      `grant select on tenants, users, permissions, grants, groups to hub_isolation_test`
    )

    try {
      // Everything in one transaction: the role and the statements are on
      // the same connection of the pool.
      await database.transaction(async (client) => {
        await client.query(`set role hub_isolation_test`)

        const everyone = await client.query<{ count: number }>(
          `select count(*)::int as count from users`
        )
        expect(everyone[0]?.count).toBe(2)

        await client.query(`select set_config('hub.tenant_id', $1, true)`, [acme])
        const users = await client.query<{ tenant_id: string }>(`select tenant_id from users`)
        const tenants = await client.query<{ slug: string }>(`select slug from tenants`)
        expect(users).toHaveLength(1)
        expect(users[0]?.tenant_id).toBe(acme)
        expect(tenants.map((row) => row.slug)).toEqual(['acme'])

        // The role is given back before the transaction is committed: a
        // committed `set role` would stay on the connection of the pool.
        await client.query(`reset role`)
      })
    } finally {
      await dropRole('hub_isolation_test')
    }
  })

  test('the role of the deployment is told when it bypasses the isolation', async () => {
    // The role of the test is a superuser: it is not subject to the
    // policies, and a production deployment refuses to start with it.
    expect(await bypassesRowLevelSecurity(database)).toBe(true)

    await dropRole('hub_not_super_test')
    await database.exec(`create role hub_not_super_test nosuperuser nobypassrls`)
    try {
      // The role and the statement are on the same connection of the
      // pool: the role of the connection is a property of the session.
      await database.transaction(async (client) => {
        await client.query(`set role hub_not_super_test`)
        expect(await bypassesRowLevelSecurity(client)).toBe(false)
        await client.query(`reset role`)
      })
    } finally {
      await dropRole('hub_not_super_test')
    }
  })
})

describe('the start of a production deployment', () => {
  test.skipIf(!againstServer)(
    'a production deployment refuses a role that bypasses the isolation',
    async () => {
      const { generateKeyPairSync } = await import('node:crypto')
      const { createRuntime } = await import('../../src/runtime/composition')
      const { readEnv } = await import('../../src/runtime/env')
      const { createDatabase } = await import('../../src/platform/postgres')
      const url = process.env.HUB_TEST_DATABASE_URL ?? ''
      const schema = 'hub_test_production'
      const admin = await createDatabase({ driver: 'postgres', url })
      try {
        await admin.exec(`create schema if not exists "${schema}"`)
      } finally {
        await admin.close()
      }
      const scoped = `${url}${url.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schema}`
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      })
      let message = ''
      try {
        const runtime = await createRuntime(
          readEnv({
            HUB_ENVIRONMENT: 'production',
            HUB_HOST: '127.0.0.1',
            HUB_PORT: '0',
            HUB_DATABASE_URL: scoped,
            HUB_ISSUER: 'https://hub.example.com',
            HUB_ADMIN_TOKEN: 'the-admin-token',
            HUB_ACCESS_TOKEN: 'the-access-token',
            HUB_ALLOW_MEMORY_STATE: 'true',
            HUB_STATE_SECRET: 'a'.repeat(64),
            HUB_SECRET_ENCRYPTION_KEY: 'b'.repeat(64),
            HUB_SIGNING_KEY: privateKey,
            HUB_SIGNING_KID: 'the-kid-of-the-test',
          })
        )
        await runtime.close()
      } catch (error) {
        message = String(error)
      }
      // The role of the test is a superuser: the deployment refuses to
      // start with it.
      expect(message).toContain('bypasses the isolation of the tenants')
    },
    30_000
  )
})
