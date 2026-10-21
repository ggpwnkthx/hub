/**
 * The database of Hub.
 *
 * The platform owns the client of PostgreSQL, the migrations of the four
 * tables and the storage of the rows. It knows no policy: it runs the
 * statements the domains ask for, it applies the schema and it encrypts
 * the secrets that are stored.
 */

export type { Database, DatabaseOptions, MigrationLock, SqlClient, SqlDriver } from './database'
export {
  CHECK_VIOLATION,
  DatabaseError,
  FOREIGN_KEY_VIOLATION,
  normalizeError,
  UNIQUE_VIOLATION,
} from './database'
export { createDatabase } from './factory'
export type { Migration, MigrationResult } from './migrations'
export {
  MIGRATION_STATEMENT_TIMEOUT_MS,
  MIGRATIONS_DIRECTORY,
  MIGRATIONS_TABLE,
  readMigrations,
  runMigrations,
} from './migrations'
export type { AuditFilter, AuditPage } from './audit'
export { AuditRepository, type AuditRow } from './audit'
export type { DecisionFacts, DecisionRequest } from '../../domains/authorization'
export { AccessContextRepository } from './access-context'
export { DecisionRepository, TimeoutError, withTimeout } from './decisions'
export type { GrantRow, NewGrant } from './grants'
export { GrantRepository } from './grants'
export type { GroupRow, NewGroup } from './groups'
export { GroupRepository } from './groups'
export type { PermissionRow, NewPermission } from './permissions'
export { PermissionRepository } from './permissions'
export type { SecretCipher } from './secrets'
export {
  CIPHERTEXT_VERSION,
  createSecretCipher,
  deriveKey,
  KEY_BYTES,
  SecretError,
} from './secrets'
export {
  bypassesRowLevelSecurity,
  roleOf,
  TENANT_SCOPE_SETTING,
  withTenantScope,
  type DatabaseRole,
} from './scope'
export type { NewTenant, TenantRow, TenantSummary, TenantUpdate } from './tenants'
export { SECRET_ROTATION_WINDOW_MS, TenantRepository, type GatewaySecrets } from './tenants'
export type { NewUser, PrincipalStatus, UserRow, UserUpdate } from './users'
export { UserRepository } from './users'
export type { TraceOptions } from './trace'
export { createTracedClient, SLOW_QUERY_MS } from './trace'
