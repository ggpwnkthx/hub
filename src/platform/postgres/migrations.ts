/**
 * The migrations of the schema of Hub.
 *
 * The schema is created by plain SQL files, applied in the order of their
 * names. One runner applies them, under an advisory lock, so two replicas
 * that start at the same time do not apply the same migration twice.
 *
 * A migration that fails stops the process: Hub does not start against a
 * schema it does not understand.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../../observability'
import type { Database } from './database'

/** The table that holds the migrations that were applied. */
export const MIGRATIONS_TABLE = 'hub_schema_migrations'

/** The directory the migrations of the schema are read from. */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url))

/** A migration of the schema. */
export interface Migration {
  /** The name of the file of the migration; it is its identity. */
  name: string
  /** The statements of the migration. */
  sql: string
}

export interface MigrationRunnerOptions {
  /** The database the migrations are applied to. */
  database: Database
  /** The directory the migrations are read from. */
  directory: string
  /** The logger of the service. */
  logger: Logger
}

export interface MigrationResult {
  /** The migrations that were applied by this run. */
  applied: string[]
  /** The migrations that were already applied. */
  alreadyApplied: string[]
}

/**
 * Reads the migrations of a directory.
 *
 * The order of the names is the order of the application: a migration is
 * named after the moment it was written.
 */
export async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory)
  const migrations: Migration[] = []
  for (const name of entries.filter((entry) => entry.endsWith('.sql')).sort()) {
    migrations.push({ name, sql: await readFile(join(directory, name), 'utf8') })
  }
  return migrations
}

/**
 * Applies the migrations that are not applied yet.
 *
 * The runner refuses to start against a database that holds a migration
 * this version of Hub does not know: the code is older than the schema and
 * it does not know what it would find in the tables.
 */
export async function runMigrations(options: MigrationRunnerOptions): Promise<MigrationResult> {
  const { database, directory, logger } = options
  const migrations = await readMigrations(directory)
  const lock = await database.lockMigrations()
  try {
    await database.exec(
      `create table if not exists ${MIGRATIONS_TABLE} (
         name text primary key,
         applied_at timestamptz not null default now()
       )`
    )
    const rows = await database.query<{ name: string }>(
      `select name from ${MIGRATIONS_TABLE} order by name`
    )
    const applied = new Set(rows.map((row) => row.name))

    for (const row of rows) {
      if (!migrations.some((migration) => migration.name === row.name)) {
        throw new Error(
          `the database has the migration "${row.name}" that this version of Hub does not know: the deployment runs a version of the image that is older than the schema`
        )
      }
    }

    const result: MigrationResult = { applied: [], alreadyApplied: [] }
    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        result.alreadyApplied.push(migration.name)
        continue
      }
      logger.info('the migration is applied', { migration: migration.name })
      try {
        await database.transaction(async (client) => {
          await client.exec(migration.sql)
          await client.query(`insert into ${MIGRATIONS_TABLE} (name) values ($1)`, [migration.name])
        })
      } catch (error) {
        // The name of the migration is in the failure: the operator has to
        // know which one of them stopped the service.
        throw new Error(
          `the migration "${migration.name}" failed: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      result.applied.push(migration.name)
    }
    return result
  } finally {
    await lock.release()
  }
}
