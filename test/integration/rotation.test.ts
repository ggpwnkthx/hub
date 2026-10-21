import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createDatabase,
  createSecretCipher,
  MIGRATIONS_DIRECTORY,
  runMigrations,
  TenantRepository,
  type Database,
} from '../../src/platform/postgres'
import { createLogger } from '../../src/observability'
import { openTestDatabase } from './database'

const root = resolve(import.meta.dir, '..', '..')

/** The key that is in use. */
const OLD_KEY = 'the-key-in-use'
/** The key the deployment will use. */
const NEW_KEY = 'the-new-key-of-the-deployment'

describe('the rotation of the key of the client secrets', () => {
  test('the stored secrets are re-encrypted in one transaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hub-rotation-'))
    let database: Database | undefined
    try {
      database = await createDatabase({ driver: 'pglite', path: directory })
      await runMigrations({
        database,
        directory: MIGRATIONS_DIRECTORY,
        logger: createLogger({ level: 'silent' }),
      })
      const tenants = new TenantRepository(database, createSecretCipher(OLD_KEY))
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
      await database.close()

      const proc = Bun.spawn(['bun', 'run', 'scripts/rotate-secrets.ts'], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          HUB_DATABASE_URL: `pglite://${directory}`,
          HUB_SECRET_ENCRYPTION_KEY: OLD_KEY,
          HUB_NEW_SECRET_ENCRYPTION_KEY: NEW_KEY,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(await proc.exited).toBe(0)

      database = await createDatabase({ driver: 'pglite', path: directory })
      const rotated = new TenantRepository(database, createSecretCipher(NEW_KEY))
      expect(await rotated.readProviderSecret(tenant.id)).toBe('the-secret-of-the-provider')
      expect(await rotated.readGatewaySecret(tenant.id)).toBe('the-secret-of-the-gateway')

      // The old key does not read the secrets any more.
      const old = new TenantRepository(database, createSecretCipher(OLD_KEY))
      expect(() => old.readProviderSecret(tenant.id)).toThrow()
    } finally {
      await database?.close().catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('the rotation of the key of the client secrets', () => {
  let database: Database

  beforeAll(async () => {
    database = await openTestDatabase()
  })

  afterAll(async () => {
    await database.close()
  })

  test('the script refuses to run without a key', async () => {
    const proc = Bun.spawn(['bun', 'run', 'scripts/rotate-secrets.ts'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        HUB_DATABASE_URL: 'pglite://memory://',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(1)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('HUB_SECRET_ENCRYPTION_KEY')
  }, 30_000)
})
