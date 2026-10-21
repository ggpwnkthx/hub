/**
 * The database of the integration tests.
 *
 * The tests run on the embedded PostgreSQL of the process by default: they
 * need no server and they run the migrations of the production. A workflow
 * that has a server names it in `HUB_TEST_DATABASE_URL` and the same tests
 * run against it, in a schema of their own: the files do not share their
 * rows.
 */

import { createLogger } from '../../src/observability'
import {
  createDatabase,
  MIGRATIONS_DIRECTORY,
  runMigrations,
  type Database,
} from '../../src/platform/postgres'

/** The url of the database of the tests. */
const url = process.env.HUB_TEST_DATABASE_URL ?? 'pglite://memory://'

/** True when the tests run against a PostgreSQL server. */
export const againstServer = !url.startsWith('pglite://')

/** The logger of the tests. */
const logger = createLogger({ level: 'silent' })

/**
 * Opens a database with the schema of Hub applied.
 *
 * Every file opens its own database: the tests do not share their rows
 * and they do not depend on the order they run in.
 */
export async function openTestDatabase(): Promise<Database> {
  if (againstServer) {
    const schema = `hub_test_${Math.random().toString(36).slice(2, 10)}`
    const admin = await createDatabase({ driver: 'postgres', url })
    try {
      await admin.exec(`create schema if not exists "${schema}"`)
    } finally {
      await admin.close()
    }
    const database = await createDatabase({ driver: 'postgres', url, schema })
    await runMigrations({ database, directory: MIGRATIONS_DIRECTORY, logger })
    return database
  }
  const database = await createDatabase({
    driver: 'pglite',
    path: url.slice('pglite://'.length),
  })
  await runMigrations({ database, directory: MIGRATIONS_DIRECTORY, logger })
  return database
}
