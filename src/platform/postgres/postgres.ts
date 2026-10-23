/**
 * The PostgreSQL server of a deployment.
 *
 * The driver is `pg`: the client of PostgreSQL for Node, which runs in the
 * runtime of Bun. The pool is bounded, the statements have a timeout and
 * the transactions are explicit.
 */

import { Pool, type PoolClient } from 'pg'
import { normalizeError, type Database, type MigrationLock, type SqlClient } from './database'
import { MIGRATION_STATEMENT_TIMEOUT_MS } from './migrations'

/** The key of the advisory lock of the migrations. */
const MIGRATION_LOCK_KEY = 8_675_309

export interface PostgresOptions {
  /** The url of the server. */
  url: string
  /** The size of the pool of the process. */
  max?: number
  /** How long a statement may run, in milliseconds. */
  statementTimeoutMs?: number
  /** How long a connection may wait for a free slot, in milliseconds. */
  connectionTimeoutMs?: number
  /**
   * The schema the tables live in.
   *
   * The schema of a deployment is the one of PostgreSQL by default. The
   * tests that run against a server use one schema per file, so they do
   * not share their rows.
   */
  schema?: string
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
    try {
      const result = await this.runner.query(text, [...params])
      return result.rows as T[]
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async exec(text: string): Promise<void> {
    try {
      await this.runner.query(text)
    } catch (error) {
      throw normalizeError(error)
    }
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
      throw normalizeError(error)
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
    if (options.schema) {
      // The schema of the connection is the one the caller asked for: the
      // statements of the repositories do not name a schema.
      const schema = options.schema
      this.pool.on('connect', (client) => {
        void client.query(`set search_path to "${schema.replace(/"/g, '""')}"`)
      })
    }
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
    // The deadline of the connection is the deadline of the service: a
    // migration builds an index, and an index on a table that has rows
    // takes more time than a decision. The connection of the migrations
    // raises its own deadline.
    await client.query(`set statement_timeout = ${MIGRATION_STATEMENT_TIMEOUT_MS}`)
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
