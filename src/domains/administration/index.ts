/**
 * The administration of Hub.
 *
 * The domain owns the five endpoints, the validation of their bodies and
 * the audit of every change. It is the whole administration surface of the
 * platform: there is no console and no second way to change a tenant, a
 * principal or a grant.
 */

export { AdministrationError, ERROR_CODES, type ErrorCode } from './errors'
export { FailedAuthenticationLimiter, MAX_FAILURES, WINDOW_MS } from './limiter'
export type {
  Grant,
  GrantRegistration,
  GrantStore,
  Permission,
  PermissionStore,
  Principal,
  PrincipalRegistration,
  PrincipalStore,
  Tenant,
  TenantRegistration,
  TenantStore,
  TenantSummary,
} from './ports'
export {
  GrantBody,
  PERMISSION_PATTERN,
  PrincipalBody,
  SLUG_PATTERN,
  TenantBody,
  type GrantInput,
  type PrincipalInput,
  type TenantInput,
} from './schemas'
export {
  AdministrationService,
  DEFAULT_IDP_ALGORITHMS,
  DEFAULT_IDP_SCOPES,
  sameSecret,
  type AdministrationOptions,
  type AuditEntry,
} from './service'
