/**
 * The port of the database.
 *
 * Hub stores its five tables in PostgreSQL. The port is the same for the
 * two drivers: a PostgreSQL server of a deployment and the embedded
 * PostgreSQL of a development machine. The domains and the repositories
 * never know which one they talk to.
 */

/** The driver of the database. */
type SqlDriver = 'postgres' | 'pglite'

/** The failure of a unique constraint. */
export const UNIQUE_VIOLATION = '23505'

/** The failure of a check constraint. */
export const CHECK_VIOLATION = '23514'

/**
 * The name of the constraint of the membership of the groups.
 *
 * The membership is checked by the database (spec §3.5): a member that is
 * not a principal of the tenant is refused by the constraint, and the
 * application turns that refusal into the `404` of the administration.
 */
export const GROUP_MEMBERSHIP_CONSTRAINT = 'groups_membership_is_principals'

/**
 * The failure of a statement of the database.
 *
 * The code is the one of PostgreSQL: the domains turn it into the answer
 * of the protocol (`409 conflict` for a unique violation, `403 forbidden`
 * for a foreign key) without reading the message of the driver.
 */
export class DatabaseError extends Error {
  constructor(
    message: string,
    /** The code of the failure of PostgreSQL. */
    readonly code: string,
    /** The constraint that was broken, when the failure is a constraint. */
    readonly constraint?: string
  ) {
    super(message)
    this.name = 'DatabaseError'
  }
}

/**
 * Turns the error of a driver into the failure of the database.
 *
 * The two drivers report the failures of PostgreSQL the same way: the
 * error carries a code and, for a constraint, the name of the constraint.
 */
export function normalizeError(error: unknown): unknown {
  if (error instanceof DatabaseError) return error
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown }
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return new DatabaseError(
        candidate.message,
        candidate.code,
        typeof candidate.constraint === 'string' ? candidate.constraint : undefined
      )
    }
  }
  return error
}

/** A client of the database. */
export interface SqlClient {
  /** The driver behind the client. */
  readonly driver: SqlDriver
  /** Runs a statement and returns its rows. */
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>
  /** Runs a statement that returns no rows. */
  exec(text: string): Promise<void>
  /** Runs a function inside a transaction. */
  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>
}

/** The lock the migrations are applied under. */
export interface MigrationLock {
  /** Releases the lock. */
  release(): Promise<void>
}

/** The database of Hub. */
export interface Database extends SqlClient {
  /** Closes the database and everything it owns. */
  close(): Promise<void>
  /**
   * Takes the advisory lock of the migrations.
   *
   * The lock is held by the session that took it: two replicas that start
   * at the same time do not apply the same migration twice.
   */
  lockMigrations(): Promise<MigrationLock>
}

/** The options of the database. */
export interface DatabaseOptions {
  /** The driver of the database. */
  driver: SqlDriver
  /** The url of the PostgreSQL server, when the driver is the server. */
  url?: string
  /** The directory of the embedded database, when the driver is embedded. */
  path?: string
  /** The schema the tables live in, when the driver is the server. */
  schema?: string
  /**
   * The size of the pool of the process, when the driver is the server.
   *
   * The pool is bounded: a connection of the pool is reused, and a
   * reused connection is a connection that carries what the previous
   * statement left on it.
   */
  max?: number
  /**
   * The deadline of the statements of the server, in milliseconds.
   *
   * The deadline is the one of the server: it is set when the connection
   * is opened, and it is the deadline of every statement of that
   * connection. A statement that takes too long is stopped by PostgreSQL
   * and the connection is given back to the pool at once.
   */
  statementTimeoutMs?: number
}
