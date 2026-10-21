/**
 * The provider of Hub.
 *
 * The domain owns the tokens Hub issues: the signing, the JWKS, the
 * discovery document and the claims of the userinfo.
 */

export type { CodeRecord, CodeStore } from './code'
export { aCode, CODE_TTL_SECONDS, hashOf } from './code'
export type { PrincipalLookup, PrincipalOfLogin, TokenIssuer } from './exchange'
export { CodeService, ExchangeError } from './exchange'
export {
  acceptedScopes,
  discoveryDocument,
  SUPPORTED_SCOPES,
  type DiscoveryDocument,
} from './discovery'
export {
  jwksOf,
  loadSigningKeys,
  SIGNING_ALGORITHM,
  type PublishedKey,
  type SigningKeyOptions,
  type SigningKeys,
} from './keys'
export type { AudienceStore, PrincipalStore, RoleStore, UserinfoClaims } from './service'
export { ProviderService, type ProviderOptions } from './service'
export {
  issueTokens,
  MAX_ROLES,
  rolesClaim,
  TOKEN_LIFE_SECONDS,
  type IssueOptions,
  type TokenPair,
  type TokenSubject,
} from './tokens'
