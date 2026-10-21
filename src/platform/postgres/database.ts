/**
 * The port of the database.
 *
 * Hub stores its four tables in PostgreSQL. The port is the same for the
 * two drivers: a PostgreSQL server of a deployment and the embedded
 * PostgreSQL of a development machine. The domains and the repositories
 * never know which one they talk to.
 */

/** The driver of the database. */
export type SqlDriver = 'postgres' | 'pglite'

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
}
