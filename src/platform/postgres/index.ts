/**
 * The database of Hub.
 *
 * The platform owns the client of PostgreSQL, the migrations of the four
 * tables and the storage of the rows. It knows no policy: it runs the
 * statements the domains ask for, it applies the schema and it encrypts
 * the secrets that are stored.
 */

export type { Database } from './database'
export {
  CHECK_VIOLATION,
  DatabaseError,
  GROUP_MEMBERSHIP_CONSTRAINT,
  UNIQUE_VIOLATION,
} from './database'
export { createDatabase } from './factory'

export {
  MIGRATION_STATEMENT_TIMEOUT_MS,
  MIGRATIONS_DIRECTORY,
  MIGRATIONS_TABLE,
  readMigrations,
  resolveMigrationsDirectory,
  runMigrations,
} from './migrations'

export { AuditRepository, type AuditRow } from './audit'

export { AccessContextRepository } from './access-context'
export { DecisionRepository, TimeoutError } from './decisions'
export type { GrantRow } from './grants'
export { GrantRepository } from './grants'
export type { GroupRow } from './groups'
export { GroupRepository } from './groups'
export type { PermissionRow } from './permissions'
export { PermissionRepository } from './permissions'
export type { SecretCipher } from './secrets'
export {
  createSecretCipher,
  SecretError,
} from './secrets'
export {
  bypassesRowLevelSecurity,
  roleOf,
} from './scope'
export type { NewTenant, TenantRow, TenantSummary } from './tenants'
export { TenantRepository } from './tenants'
export type { UserRow } from './users'
export { UserRepository } from './users'

export { createTracedClient } from './trace'
