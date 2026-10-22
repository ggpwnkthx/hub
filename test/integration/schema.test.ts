import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../../src/observability'
import {
  createDatabase,
  MIGRATIONS_DIRECTORY,
  MIGRATIONS_TABLE,
  runMigrations,
  type Database,
} from '../../src/platform/postgres'

/**
 * The database of the integration tests.
 *
 * It is the embedded PostgreSQL of the process by default: the tests run
 * everywhere and they run the migrations of the production. A workflow
 * that has a server names it in `HUB_TEST_DATABASE_URL` and the same
 * tests run against it.
 */
const url = process.env.HUB_TEST_DATABASE_URL ?? 'pglite://memory://'

/** The table of the audit of the administration: it is infrastructure. */
const AUDIT_TABLE = 'admin_audit'

let database: Database

beforeAll(async () => {
  database = await createDatabase(
    url.startsWith('pglite://')
      ? { driver: 'pglite', path: url.slice('pglite://'.length) }
      : { driver: 'postgres', url }
  )
  await runMigrations({
    database,
    directory: MIGRATIONS_DIRECTORY,
    logger: createLogger({ level: 'silent' }),
  })
})

afterAll(async () => {
  await database.close()
})

/** Creates a tenant and returns its id. */
async function tenant(slug: string, options: { default?: boolean } = {}): Promise<string> {
  const rows = await database.query<{ id: string }>(
    `insert into tenants (slug, display_name, idp_issuer, idp_client_id, idp_client_secret,
       idp_redirect_uri, client_id, client_secret, is_default)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      slug,
      slug,
      'https://login.example.com',
      `hub-${slug}`,
      Buffer.from('secret'),
      'https://hub.example.com/oauth/tenant/callback',
      `shuttle-${slug}`,
      Buffer.from('secret'),
      options.default ?? false,
    ]
  )
  return rows[0]!.id
}

/** Creates a principal and returns its id. */
async function user(tenantId: string, subject: string): Promise<string> {
  const rows = await database.query<{ id: string }>(
    `insert into users (tenant_id, external_subject) values ($1, $2) returning id`,
    [tenantId, subject]
  )
  return rows[0]!.id
}

describe('the schema of Hub', () => {
  test('the migration is applied and it is idempotent', async () => {
    const applied = await database.query<{ name: string }>(
      `select name from ${MIGRATIONS_TABLE} order by name`
    )
    expect(applied.map((row) => row.name)).toEqual([
      '0001_initial.sql',
      '0002_list_indexes.sql',
      '0003_tenant_isolation.sql',
      '0004_groups.sql',
      '0005_group_members_index.sql',
      '0006_secret_rotation.sql',
      '0007_admin_audit.sql',
      '0008_gateway_redirect_uris.sql',
      '0009_empty_scope_is_the_platform.sql',
    ])

    const second = await runMigrations({
      database,
      directory: MIGRATIONS_DIRECTORY,
      logger: createLogger({ level: 'silent' }),
    })
    expect(second.applied).toEqual([])
    expect(second.alreadyApplied).toEqual([
      '0001_initial.sql',
      '0002_list_indexes.sql',
      '0003_tenant_isolation.sql',
      '0004_groups.sql',
      '0005_group_members_index.sql',
      '0006_secret_rotation.sql',
      '0007_admin_audit.sql',
      '0008_gateway_redirect_uris.sql',
      '0009_empty_scope_is_the_platform.sql',
    ])
  })

  test('the five tables are the only tables of the domain', async () => {
    const rows = await database.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name not in ('${MIGRATIONS_TABLE}', '${AUDIT_TABLE}')
       order by table_name`
    )
    expect(rows.map((row) => row.table_name)).toEqual([
      'grants',
      'groups',
      'permissions',
      'tenants',
      'users',
    ])
  })

  test('the tables of the infrastructure are the migrations and the audit', async () => {
    const rows = await database.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public'
         and table_name in ('${MIGRATIONS_TABLE}', '${AUDIT_TABLE}')
       order by table_name`
    )
    expect(rows.map((row) => row.table_name)).toEqual([AUDIT_TABLE, MIGRATIONS_TABLE])
  })

  test('a client id belongs to one tenant', async () => {
    const first = await tenant('acme')
    expect(first).toBeTruthy()
    await expect(
      database.query(
        `insert into tenants (slug, display_name, idp_issuer, idp_client_id, idp_client_secret,
           idp_redirect_uri, client_id, client_secret)
         values ('acme-two', 'Acme Two', 'https://login.example.com', 'hub-acme-two', $1,
           'https://hub.example.com/oauth/tenant/callback', 'shuttle-acme', $2)`,
        [Buffer.from('secret'), Buffer.from('secret')]
      )
    ).rejects.toThrow()
  })

  test('at most one tenant is the default', async () => {
    await tenant('default-one', { default: true })
    await expect(
      database.query(
        `insert into tenants (slug, display_name, idp_issuer, idp_client_id, idp_client_secret,
           idp_redirect_uri, client_id, client_secret, is_default)
         values ('default-two', 'Default Two', 'https://login.example.com', 'hub-default-two', $1,
           'https://hub.example.com/oauth/tenant/callback', 'shuttle-default-two', $2, true)`,
        [Buffer.from('secret'), Buffer.from('secret')]
      )
    ).rejects.toThrow()
  })

  test('the mapping key is the pair (tenant, subject)', async () => {
    const acme = await tenant('mapping')
    const subject = '00u1a2b3c4d5'
    await user(acme, subject)
    await expect(user(acme, subject)).rejects.toThrow()
  })

  test('a grant can never name a principal of another tenant', async () => {
    const acme = await tenant('grants-acme')
    const other = await tenant('grants-other')
    const principal = await user(acme, 'the-subject')
    const rows = await database.query<{ id: string }>(
      `insert into permissions (tenant_id, key) values ($1, 'workspace.read') returning id`,
      [acme]
    )
    const permission = rows[0]!.id

    await expect(
      database.query(`insert into grants (tenant_id, user_id, permission_id) values ($1, $2, $3)`, [
        other,
        principal,
        permission,
      ])
    ).rejects.toThrow()
  })

  test('the catalogue of the platform holds one row per key', async () => {
    await database.query(`insert into permissions (tenant_id, key) values (null, 'platform.read')`)
    await expect(
      database.query(`insert into permissions (tenant_id, key) values (null, 'platform.read')`)
    ).rejects.toThrow()
  })

  test('a revoked grant does not hold the tuple of a live one', async () => {
    const acme = await tenant('revoked')
    const principal = await user(acme, 'the-subject')
    const rows = await database.query<{ id: string }>(
      `insert into permissions (tenant_id, key) values ($1, 'workspace.write') returning id`,
      [acme]
    )
    const permission = rows[0]!.id

    const live = await database.query<{ id: string }>(
      `insert into grants (tenant_id, user_id, permission_id) values ($1, $2, $3) returning id`,
      [acme, principal, permission]
    )
    await expect(
      database.query(`insert into grants (tenant_id, user_id, permission_id) values ($1, $2, $3)`, [
        acme,
        principal,
        permission,
      ])
    ).rejects.toThrow()

    await database.query(`update grants set revoked_at = now() where id = $1`, [live[0]!.id])
    const revived = await database.query<{ id: string }>(
      `insert into grants (tenant_id, user_id, permission_id) values ($1, $2, $3) returning id`,
      [acme, principal, permission]
    )
    expect(revived).toHaveLength(1)
  })

  test('the index of the decision is there', async () => {
    const rows = await database.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = 'grants' order by indexname`
    )
    expect(rows.map((row) => row.indexname)).toContain('grants_user_live')
  })

  test('the embedded database is created in its directory', async () => {
    const directory = join(tmpdir(), `hub-pglite-${Date.now()}`)
    const embedded = await createDatabase({ driver: 'pglite', path: directory })
    try {
      const rows = await embedded.query<{ answer: number }>('select 1 as answer')
      expect(rows[0]!.answer).toBe(1)
    } finally {
      await embedded.close()
    }
    expect(existsSync(directory)).toBe(true)
  })
})
