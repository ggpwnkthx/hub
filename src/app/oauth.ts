/**
 * The token endpoint of Hub (spec §5.1).
 *
 * The gateway exchanges the code of the login for the tokens. The client
 * authenticates itself with `client_secret_basic`; a client without a
 * secret is refused.
 */

import type { Context } from 'hono'
import { ExchangeError } from '../domains/provider'
import { sameSecret } from '../observability'
import type { HubDependencies } from './dependencies'
import type { HubEnv } from './state'

/**
 * The headers that keep a token out of a cache.
 *
 * The answer of the token endpoint carries a token: it is never stored by
 * an intermediary or by a browser (RFC 6749 §5.1).
 */
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const

/** The answer of a refusal of the token endpoint. */
function refusal(code: string, message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: code, error_description: message }), {
    status,
    headers: { 'content-type': 'application/json', ...NO_STORE },
  })
}

/**
 * `POST /oauth/token`: the exchange of a code for the tokens.
 */
export async function tokenHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  // The client authenticates itself with its secret: the comparison is in
  // constant time.
  const header = context.req.header('authorization') ?? ''
  const match = /^Basic\s+(.+)$/i.exec(header.trim())
  if (!match) {
    return refusal(
      'invalid_client',
      'the client authenticates itself with client_secret_basic',
      401
    )
  }
  let clientId = ''
  let clientSecret = ''
  try {
    const decoded = Buffer.from(match[1]!.trim(), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 0) throw new Error('the credentials are not readable')
    clientId = decodeURIComponent(decoded.slice(0, separator))
    clientSecret = decodeURIComponent(decoded.slice(separator + 1))
  } catch {
    return refusal('invalid_client', 'the credentials of the client are not readable', 401)
  }

  const form = await context.req.formData().catch(() => null)
  const grantType = String(form?.get('grant_type') ?? '')
  const code = String(form?.get('code') ?? '')
  const redirectUri = String(form?.get('redirect_uri') ?? '')
  const codeVerifier = form?.get('code_verifier')
  if (grantType !== 'authorization_code') {
    return refusal('invalid_request', 'the grant type of the request is not supported')
  }
  if (!code || !redirectUri) {
    return refusal('invalid_request', 'the code and the redirect uri are required')
  }

  const tenant = await dependencies.tenants.findByClientId(clientId)
  if (!tenant) {
    return refusal('invalid_client', 'the client is not registered', 401)
  }
  // The secret of a gateway is accepted in two forms during a rotation:
  // the one that is in use and the one it replaced, which is accepted
  // until the end of the window of the rotation (spec §4.3).
  const secrets = await dependencies.tenants.gatewaySecrets(tenant.id)
  const previousAccepted =
    secrets.previous !== null &&
    secrets.previousUntil !== null &&
    secrets.previousUntil.getTime() > Date.now()
  const accepted =
    clientSecret !== '' &&
    secrets.current !== null &&
    (sameSecret(clientSecret, secrets.current) ||
      (previousAccepted && secrets.previous !== null && sameSecret(clientSecret, secrets.previous)))
  if (!accepted) {
    return refusal('invalid_client', 'the client is not authenticated', 401)
  }

  try {
    const pair = await dependencies.codes.exchange({
      code,
      clientId,
      redirectUri,
      codeVerifier: typeof codeVerifier === 'string' ? codeVerifier : undefined,
    })
    return context.json(
      {
        access_token: pair.accessToken,
        token_type: pair.tokenType,
        expires_in: pair.expiresIn,
        id_token: pair.idToken,
      },
      200,
      NO_STORE
    )
  } catch (error) {
    if (error instanceof ExchangeError) {
      return refusal(error.code, error.message)
    }
    dependencies.logger.error('the exchange failed', { error })
    return refusal('invalid_request', 'the exchange failed', 500)
  }
}
