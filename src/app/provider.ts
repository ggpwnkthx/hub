/**
 * The endpoints of the provider of Hub (spec §5.1, §7.5).
 *
 * The gateway discovers the service at `/.well-known/openid-configuration`,
 * it reads the keys at `/oauth/jwks` and it asks the claims of a principal
 * at `/oauth/userinfo`.
 */

import type { Context } from 'hono'
import type { HubDependencies } from './dependencies'
import { jsonError } from './errors'
import type { HubEnv } from './state'

/** `GET /oauth/jwks`: the keys of the service. */
export async function jwksHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  return context.json(await dependencies.provider.jwks())
}

/** `GET /.well-known/openid-configuration`: the discovery document. */
export async function discoveryHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  return context.json(await dependencies.provider.discovery())
}

/**
 * `GET /oauth/userinfo`: the claims of the principal of a bearer token.
 *
 * A token that is expired, that is signed with another key or that
 * belongs to another audience is a `401`.
 */
export async function userinfoHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const header = context.req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const token = match?.[1]?.trim() ?? ''
  if (!token) {
    return jsonError(401, 'unauthorized', 'a valid access token is required')
  }
  const claims = await dependencies.provider.userinfo(token)
  if (!claims) {
    return jsonError(401, 'unauthorized', 'a valid access token is required')
  }
  return context.json(claims)
}
