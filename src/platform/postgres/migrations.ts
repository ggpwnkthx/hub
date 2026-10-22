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

import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Logger } from '../../observability'
import type { Database } from './database'

/** The table that holds the migrations that were applied. */
export const MIGRATIONS_TABLE = 'hub_schema_migrations'

/**
 * The deadline of the statements of a migration.
 *
 * A migration builds an index, and an index on a table that has rows
 * takes more time than a decision: the connection of the migrations
 * raises its own deadline. The deadline of the pool is the deadline of
 * the service, and the service does not wait ten minutes for a decision.
 */
export const MIGRATION_STATEMENT_TIMEOUT_MS = 600_000

/** The directory the migrations of the schema are read from. */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url))

/**
 * The name of the first migration of the schema.
 *
 * It is the name of the directory of the migrations: a directory that does
 * not hold it is not the directory of the migrations.
 */
export const FIRST_MIGRATION = '0001_initial.sql'

/**
 * The directories the migrations of the schema are looked for in.
 *
 * The first one is the directory next to this module: it is the one of the
 * source tree and of the image. The second one is the directory next to
 * the executable: a compiled binary carries no directory, and the schema
 * is deployed with it.
 */
export function migrationsDirectoryCandidates(): string[] {
  return [MIGRATIONS_DIRECTORY, join(dirname(process.execPath), 'migrations')]
}

/**
 * The first of the candidates that holds the migrations of the schema.
 *
 * The first candidate is the answer when none of them holds them: the
 * runner then says which file it could not read, and the operator knows
 * that the schema was not deployed.
 */
export function migrationsDirectoryOf(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    if (existsSync(join(candidate, FIRST_MIGRATION))) return candidate
  }
  return candidates[0] ?? MIGRATIONS_DIRECTORY
}

/**
 * The directory of the migrations of the schema of the running Hub.
 *
 * The source tree and the image carry the directory next to the module.
 * A compiled binary carries the directory next to the executable: the
 * schema of the release is deployed with the binary.
 */
export function resolveMigrationsDirectory(): string {
  return migrationsDirectoryOf(migrationsDirectoryCandidates())
}

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
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    // The name of the directory is in the failure: the operator has to
    // know that the schema of the release was not deployed with the
    // service.
    throw new Error(
      `the migrations of the schema are not in "${directory}": the schema of the release is deployed with the service, and the directory of the migrations is the one next to the executable`
    )
  }
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
