/**
 * The identity of the callers.
 *
 * The domain owns the validation of the token of the provider of a tenant,
 * the mapping of the external identity `(tenant, subject)` to a principal
 * and the resolution of the tenant of a login.
 */

export type { Principal } from './mapping'
export type {
  HttpTransport,
  TransportResponse,
} from './provider-client'
export { ProviderClient } from './provider-client'
export { mapIdentity, MappingError } from './mapping'
export type {
  AuthorizationRequest,
  BegunLogin,
  CompletedLogin,
} from './service'
export { LoginError, LoginService } from './service'
export type { LoginState } from './state'
export {
  aChallenge,
  aVerifier,
  createStateCipher,
  isAlive,
  LoginStateError,
} from './state'
export type { TenantOfLogin } from './tenant'
export { domainOf, resolveTenant, TenantResolutionError } from './tenant'

export { validateProviderToken } from './token'
