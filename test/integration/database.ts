/**
 * The database of the integration tests.
 *
 * The tests run on the embedded PostgreSQL of the process by default: they
 * need no server and they run the migrations of the production. A workflow
 * that has a server names it in `HUB_TEST_DATABASE_URL` and the same tests
 * run against it.
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

/**
 * Opens a database with the schema of Hub applied.
 *
 * Every file opens its own database: the tests do not share their rows
 * and they do not depend on the order they run in.
 */
export async function openTestDatabase(): Promise<Database> {
  const database = await createDatabase(
    url.startsWith('pglite://')
      ? { driver: 'pglite', path: url.slice('pglite://'.length) }
      : { driver: 'postgres', url }
  )
  await runMigrations({
    database,
    directory: MIGRATIONS_DIRECTORY,
    logger: createLogger({ level: 'silent' }),
  })
  return database
}
