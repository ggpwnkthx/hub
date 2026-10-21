import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from '../../src/observability'
import {
  createDatabase,
  MIGRATIONS_DIRECTORY,
  MIGRATIONS_TABLE,
  readMigrations,
  runMigrations,
} from '../../src/platform/postgres'
import { againstServer, openTestDatabase } from './database'

const logger = createLogger({ level: 'silent' })

describe('the migrations of the schema', () => {
  test('a migration that fails stops the runner and names the migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hub-migration-'))
    try {
      await writeFile(join(directory, '0001_broken.sql'), 'this is not sql;\n')
      // The database is empty: the migration of the directory is the first
      // one the runner meets.
      const database = await createDatabase({ driver: 'pglite', path: 'memory://' })
      try {
        let message = ''
        try {
          await runMigrations({ database, directory, logger })
        } catch (error) {
          message = String(error)
        }
        expect(message).toContain('0001_broken.sql')
        // The migration that failed is not recorded: the runner refuses to
        // start against a schema it does not understand.
        const rows = await database.query<{ name: string }>(
          `select name from ${MIGRATIONS_TABLE} where name = $1`,
          ['0001_broken.sql']
        )
        expect(rows).toEqual([])
      } finally {
        await database.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('the migration that is applied is recorded once', async () => {
    const database = await openTestDatabase()
    try {
      const rows = await database.query<{ name: string; count: number }>(
        `select name, count(*)::int as count from ${MIGRATIONS_TABLE} group by name`
      )
      expect(rows.every((row) => row.count === 1)).toBe(true)
    } finally {
      await database.close()
    }
  })
})

describe('the runners that start at the same time', () => {
  let url: string

  beforeAll(() => {
    url = process.env.HUB_TEST_DATABASE_URL ?? ''
  })

  afterAll(async () => {
    if (!againstServer) return
    const admin = await createDatabase({ driver: 'postgres', url })
    try {
      await admin.exec(`drop schema if exists hub_concurrency cascade`)
    } finally {
      await admin.close()
    }
  })

  test.skipIf(!againstServer)(
    'two runners apply the migration once',
    async () => {
      const schema = 'hub_concurrency'
      const admin = await createDatabase({ driver: 'postgres', url })
      await admin.exec(`create schema if not exists "${schema}"`)
      await admin.close()

      const first = await createDatabase({ driver: 'postgres', url, schema })
      const second = await createDatabase({ driver: 'postgres', url, schema })
      try {
        // The two runners start at the same time: the advisory lock of the
        // migrations makes one of them wait for the other.
        const [a, b] = await Promise.all([
          runMigrations({ database: first, directory: MIGRATIONS_DIRECTORY, logger }),
          runMigrations({ database: second, directory: MIGRATIONS_DIRECTORY, logger }),
        ])
        // Every migration is applied by one of the two runners, and by
        // one of them only: the advisory lock is the whole point.
        const applied = [...a.applied, ...b.applied].sort()
        const migrations = (await readMigrations(MIGRATIONS_DIRECTORY)).map((m) => m.name)
        expect(applied).toEqual(migrations)
        expect(new Set(applied).size).toBe(applied.length)
        // Every migration is recorded once and only once.
        const rows = await first.query<{ count: number }>(
          `select count(*)::int as count from ${MIGRATIONS_TABLE}`
        )
        expect(rows[0]?.count).toBe(migrations.length)
      } finally {
        await first.close()
        await second.close()
      }
    },
    30_000
  )
})
