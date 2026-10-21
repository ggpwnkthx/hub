/**
 * The discovery document of Hub (spec §7.5).
 *
 * The gateway reads the document once and caches it for ten minutes. The
 * issuer of the document is exactly the issuer of the service: the
 * gateway refuses a document whose issuer is not the one it was
 * configured with.
 */

/** The fields of the discovery document that the gateway reads. */
export interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint: string
  response_types_supported: string[]
  subject_types_supported: string[]
  id_token_signing_alg_values_supported: string[]
  grant_types_supported: string[]
  scopes_supported: string[]
  code_challenge_methods_supported: string[]
  token_endpoint_auth_methods_supported: string[]
}

/** The scopes Hub accepts (§7.4): a scope it does not know is ignored. */
export const SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'groups']

/** Builds the discovery document of the service. */
export function discoveryDocument(options: {
  issuer: string
  publicUrl: string
}): DiscoveryDocument {
  const base = options.publicUrl.replace(/\/$/, '')
  return {
    issuer: options.issuer,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    jwks_uri: `${base}/oauth/jwks`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    grant_types_supported: ['authorization_code'],
    scopes_supported: SUPPORTED_SCOPES,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic'],
  }
}

/**
 * The scopes of a request, as Hub accepts them.
 *
 * A scope Hub does not know is ignored, not refused: the gateway asks
 * for `groups` by default and a broker that refused an unknown scope
 * would break a gateway that never changed.
 */
export function acceptedScopes(requested: string[]): string[] {
  return requested.filter((scope) => SUPPORTED_SCOPES.includes(scope))
}
