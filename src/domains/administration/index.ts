/**
 * The administration of Hub.
 *
 * The domain owns the nine endpoints, the validation of their bodies and
 * the audit of every change. It is the whole administration surface of the
 * platform: there is no console and no second way to change a tenant, a
 * principal or a grant.
 */

export { AdministrationError, ERROR_CODES, type ErrorCode } from './errors'
export { FailedAuthenticationLimiter, MAX_FAILURES, WINDOW_MS } from './limiter'
export type {
  AuthenticationFailures,
  FailureCount,
  LimiterOptions,
} from './limiter'
export type {
  AuditContext,
  AuditFilter,
  AuditFormat,
  AuditPage,
  AuditRecord,
  AuditRows,
  AuditStore,
  ChangeAudit,
  Grant,
  GrantFilter,
  Group,
  GroupFilter,
  GroupPage,
  GroupRegistration,
  GroupStore,
  GrantPage,
  GrantRegistration,
  GrantStore,
  Permission,
  PermissionStore,
  Principal,
  PrincipalFilter,
  PrincipalPage,
  PrincipalRegistration,
  PrincipalStatus,
  PrincipalStore,
  Tenant,
  TenantRegistration,
  TenantStore,
  TenantSummary,
} from './ports'
export {
  GrantBatchBody,
  GrantBody,
  GroupBody,
  MAX_BATCH_ITEMS,
  PERMISSION_PATTERN,
  PrincipalBatchBody,
  PrincipalBody,
  SLUG_PATTERN,
  TenantBody,
  type GrantBatchInput,
  type GrantInput,
  type GroupInput,
  type PrincipalBatchInput,
  type PrincipalInput,
  type TenantInput,
} from './schemas'
export {
  AdministrationService,
  DEFAULT_IDP_ALGORITHMS,
  DEFAULT_IDP_SCOPES,
  DEFAULT_PAGE_SIZE,
  MAX_EXPORT_ROWS,
  MAX_PAGE_SIZE,
  type AdministrationOptions,
  type AuditEntry,
  type GrantOutcome,
  type PrincipalOutcome,
} from './service'
