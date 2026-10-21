/**
 * The embedded PostgreSQL of the development machine.
 *
 * The driver is `pglite`: a PostgreSQL compiled to WebAssembly that runs
 * in the process of Hub. It is the same PostgreSQL as the one of a
 * deployment, so a development machine runs the migrations of the
 * production and nothing has to be translated between the two.
 *
 * The package is a development dependency and it is loaded on demand: the
 * image of a deployment never carries it.
 */

import type { PGlite, Transaction } from '@electric-sql/pglite'
import { mkdir } from 'node:fs/promises'
import { normalizeError, type Database, type MigrationLock, type SqlClient } from './database'

/** The key of the advisory lock of the migrations. */
export const MIGRATION_LOCK_KEY = 8_675_309

/** A client of the embedded database. */
class PgliteClient implements SqlClient {
  readonly driver = 'pglite' as const

  constructor(private readonly db: PGlite) {}

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    try {
      const result = await this.db.query(text, [...params])
      return result.rows as T[]
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async exec(text: string): Promise<void> {
    try {
      await this.db.exec(text)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(
        async (tx: Transaction) => await fn(new PgliteClient(tx as unknown as PGlite))
      )
    } catch (error) {
      throw normalizeError(error)
    }
  }
}

/** The embedded database of the process. */
class PgliteDatabase implements Database {
  readonly driver = 'pglite' as const
  /** True once the database was closed: the close is idempotent. */
  private closed = false

  constructor(private readonly db: PGlite) {}

  query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return new PgliteClient(this.db).query<T>(text, params)
  }

  exec(text: string): Promise<void> {
    return new PgliteClient(this.db).exec(text)
  }

  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return new PgliteClient(this.db).transaction(fn)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.db.close()
  }

  async lockMigrations(): Promise<MigrationLock> {
    // The embedded database has one session: the lock is held by the
    // process itself and no other replica can reach it.
    await this.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    return {
      release: async () => {
        await this.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      },
    }
  }
}

/**
 * Opens the embedded database.
 *
 * The path is the directory of the database: the database survives the
 * restarts of the process. The path `memory://` keeps it in the memory of
 * the process, which is what a test that does not need a state wants.
 */
export async function createPgliteDatabase(path: string): Promise<Database> {
  const { PGlite: Embedded } = await import('@electric-sql/pglite')
  const target = path === '' ? 'memory://' : path
  if (target !== 'memory://') {
    // The directory of the database is created: the embedded database of a
    // development machine survives the restarts of the process.
    await mkdir(target, { recursive: true })
  }
  const db = new Embedded(target)
  await db.waitReady
  return new PgliteDatabase(db)
}
