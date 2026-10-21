/**
 * The PostgreSQL server of a deployment.
 *
 * The driver is `pg`: the client of PostgreSQL for Node, which runs in the
 * runtime of Bun. The pool is bounded, the statements have a timeout and
 * the transactions are explicit.
 */

import { Pool, type PoolClient } from 'pg'
import type { Database, MigrationLock, SqlClient } from './database'

/** The key of the advisory lock of the migrations. */
export const MIGRATION_LOCK_KEY = 8_675_309

export interface PostgresOptions {
  /** The url of the server. */
  url: string
  /** The size of the pool of the process. */
  max?: number
  /** How long a statement may run, in milliseconds. */
  statementTimeoutMs?: number
  /** How long a connection may wait for a free slot, in milliseconds. */
  connectionTimeoutMs?: number
}

/** A client of the server. */
class PostgresClient implements SqlClient {
  readonly driver = 'postgres' as const

  constructor(
    private readonly pool: Pool,
    /** The session that holds the lock of the migrations, when there is one. */
    private readonly locked: PoolClient | null = null
  ) {}

  private get runner(): Pool | PoolClient {
    return this.locked ?? this.pool
  }

  async query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = await this.runner.query(text, [...params])
    return result.rows as T[]
  }

  async exec(text: string): Promise<void> {
    await this.runner.query(text)
  }

  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(new PostgresClient(this.pool, client))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}

/** The database of a deployment. */
class PostgresDatabase implements Database {
  readonly driver = 'postgres' as const
  private readonly pool: Pool
  /** The session that holds the lock of the migrations, when there is one. */
  private locked: PoolClient | null = null
  /** True once the pool was closed: the close is idempotent. */
  private closed = false

  constructor(options: PostgresOptions) {
    this.pool = new Pool({
      connectionString: options.url,
      max: options.max ?? 10,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
      statement_timeout: options.statementTimeoutMs ?? 10_000,
      application_name: 'hub',
    })
  }

  query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    return new PostgresClient(this.pool, this.locked).query<T>(text, params)
  }

  exec(text: string): Promise<void> {
    return new PostgresClient(this.pool, this.locked).exec(text)
  }

  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return new PostgresClient(this.pool, this.locked).transaction(fn)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.pool.end()
  }

  async lockMigrations(): Promise<MigrationLock> {
    // The lock is held by the session that took it: every statement of
    // the migration runs on that session, and the session is given back
    // when the lock is released.
    const client = await this.pool.connect()
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
    this.locked = client
    return {
      release: async () => {
        this.locked = null
        await client
          .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
          .catch(() => undefined)
        client.release()
      },
    }
  }
}

/** Opens the database of a deployment. */
export function createPostgresDatabase(options: PostgresOptions): Database {
  return new PostgresDatabase(options)
}
