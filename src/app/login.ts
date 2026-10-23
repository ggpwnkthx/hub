/**
 * The login of the callers (spec §5.1, §5.4).
 *
 * The gateway sends the browser to `/oauth/authorize` and the provider of
 * the tenant sends it back to `/oauth/tenant/callback`. The handlers are
 * thin: they read the parameters, they ask the identity domain and they
 * write the answer.
 */

import type { Context } from 'hono'
import { LoginError } from '../domains/identity'
import { acceptedScopes } from '../domains/provider'
import type { HubDependencies } from './dependencies'
import { refusalPage } from './pages'
import type { HubEnv } from './state'

/** The cookie of the state of a login. */
const STATE_COOKIE = 'hub_login_state'

/** The attributes of the cookie of the state of a login. */
function stateCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${STATE_COOKIE}=${value}`,
    'Path=/oauth/tenant/callback',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** The cookie that deletes the state of a login. */
function deletedStateCookie(secure: boolean): string {
  return stateCookie('', secure, 0)
}

/** Reads a cookie of a request. */
function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

/**
 * `GET /oauth/authorize`: the beginning of a login.
 *
 * The tenant of the login is resolved, the state of the login is created
 * and the browser is sent to the provider of the tenant.
 */
export async function authorizeHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const query = context.req.query()
  const clientId = query.client_id ?? ''
  const redirectUri = query.redirect_uri ?? ''
  if (!clientId || !redirectUri) {
    return refusalPage(
      'invalid_request',
      'the client id and the redirect uri of the request are required',
      400
    )
  }
  if (query.response_type && query.response_type !== 'code') {
    return refusalPage('invalid_request', 'the response type of the request is not supported', 400)
  }
  if (query.code_challenge_method && query.code_challenge_method !== 'S256') {
    return refusalPage(
      'invalid_request',
      'the challenge method of the request is not supported',
      400
    )
  }

  try {
    const begun = await dependencies.login.begin({
      clientId,
      redirectUri,
      state: query.state ?? '',
      nonce: query.nonce,
      scopes: acceptedScopes((query.scope ?? 'openid').split(' ').filter(Boolean)),
      tenant: query.tenant,
      loginHint: query.login_hint,
      codeChallenge: query.code_challenge,
    })
    return new Response(null, {
      status: 302,
      headers: {
        location: begun.url,
        'set-cookie': stateCookie(begun.cookie, dependencies.cookieSecure, 600),
      },
    })
  } catch (error) {
    return refusalOf(error, dependencies)
  }
}

/**
 * `GET /oauth/tenant/callback`: the end of a login.
 *
 * The provider sends the browser back with the code and its state, or with
 * the answer of a refusal.
 */
export async function callbackHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const query = context.req.query()
  const cookie = readCookie(context.req.raw, STATE_COOKIE)

  // The state cookie is single use: it is deleted whatever the outcome of
  // the callback is.
  const deleted = { 'set-cookie': deletedStateCookie(dependencies.cookieSecure) }

  // The provider refuses the login: its own answer is passed to the
  // browser, unchanged.
  if (query.error) {
    const redirectUri = await dependencies.login.redirectUriOf(cookie)
    if (!redirectUri) {
      return refusalPage('login_state_invalid', 'the login has to start again', 400)
    }
    const url = new URL(redirectUri)
    url.searchParams.set('error', query.error)
    if (query.error_description) url.searchParams.set('error_description', query.error_description)
    const state = await dependencies.login.stateOf(cookie)
    if (state) url.searchParams.set('state', state)
    return new Response(null, {
      status: 302,
      headers: { ...deleted, location: url.toString() },
    })
  }

  if (!query.code) {
    return refusalPage('invalid_request', 'the callback carries no code', 400)
  }

  try {
    const completed = await dependencies.login.complete({
      cookie,
      providerState: query.state ?? '',
      code: query.code,
    })
    const code = await dependencies.codes.issue({
      // The client that began the login, and not necessarily the tenant
      // of the login: with a shared client, the gateway presents the
      // client id it is registered with, and the code and the audience
      // belong to it (spec §5.2).
      clientId: completed.clientId,
      redirectUri: completed.redirectUri,
      codeChallenge: completed.codeChallenge,
      subject: completed.principal.id,
      tenant: completed.principal.tenantSlug,
      audience: completed.clientId,
      scopes: completed.scopes,
      nonce: completed.nonce,
    })
    const url = new URL(completed.redirectUri)
    url.searchParams.set('code', code)
    if (completed.state) url.searchParams.set('state', completed.state)
    return new Response(null, {
      status: 302,
      headers: { ...deleted, location: url.toString() },
    })
  } catch (error) {
    return refusalOf(error, dependencies)
  }
}

/** Turns the failure of the login into the page of the refusal. */
function refusalOf(error: unknown, dependencies: HubDependencies): Response {
  if (error instanceof LoginError) {
    dependencies.logger.warn('the login was refused', { code: error.code })
    const status =
      error.code === 'invalid_request' || error.code === 'login_state_invalid'
        ? 400
        : error.code === 'tenant_disabled'
          ? 403
          : error.code === 'upstream_unavailable'
            ? 502
            : 403
    return refusalPage(error.code, error.message, status)
  }
  dependencies.logger.error('the login failed', { error })
  return refusalPage('internal_error', 'the service failed to answer', 500)
}
