/**
 * The provider of Hub.
 *
 * The domain owns the tokens Hub issues: the signing, the JWKS, the
 * discovery document and the claims of the userinfo.
 */

export type { CodeRecord, CodeStore } from './code'

export { CodeService, ExchangeError } from './exchange'
export {
  acceptedScopes,
  discoveryDocument,
  SUPPORTED_SCOPES,
} from './discovery'
export { loadSigningKeys } from './keys'

export { ProviderService } from './service'
export {
  issueTokens,
  MAX_ROLES,
  rolesClaim,
  TOKEN_LIFE_SECONDS,
  type TokenPair,
} from './tokens'
