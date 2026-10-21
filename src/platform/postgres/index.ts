/**
 * The database of Hub.
 *
 * The platform owns the client of PostgreSQL and the migrations of the
 * four tables. It knows no policy: it runs the statements the repositories
 * of the domains ask for, and it applies the schema.
 */

export type { Database, DatabaseOptions, MigrationLock, SqlClient, SqlDriver } from './database'
export { createDatabase } from './factory'
export type { Migration, MigrationResult } from './migrations'
export { MIGRATIONS_DIRECTORY, MIGRATIONS_TABLE, readMigrations, runMigrations } from './migrations'
