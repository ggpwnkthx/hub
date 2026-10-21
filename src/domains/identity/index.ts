/**
 * The identity of the callers.
 *
 * The domain owns the validation of the token of the provider of a tenant,
 * the mapping of the external identity `(tenant, subject)` to a principal
 * and the resolution of the tenant of a login.
 */

export type { ExternalIdentity, Mapping, Principal, PrincipalLookup } from './mapping'
export type { HttpTransport, ProviderDiscovery, TransportResponse } from './provider-client'
export { ProviderClient, ProviderError } from './provider-client'
export { mapIdentity, MappingError } from './mapping'
export type {
  AuthorizationRequest,
  BegunLogin,
  CompletedLogin,
  LoginOptions,
} from './service'
export { LoginError, LoginService, stateCipherOf } from './service'
export type { LoginState, StateCipher } from './state'
export {
  aChallenge,
  aNonce,
  aVerifier,
  createStateCipher,
  isAlive,
  LoginStateError,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
} from './state'
export type { TenantLookup, TenantOfLogin } from './tenant'
export { domainOf, resolveTenant, TenantResolutionError } from './tenant'
export type { ProviderToken, ValidatedIdentity, ValidationOptions } from './token'
export { IdentityError, validateProviderToken } from './token'
