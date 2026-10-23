/**
 * The decision contract of the gateway (spec §8).
 *
 * The handler answers the request the gateway already sends: it does not
 * require a field the gateway does not send and it does not refuse a field
 * it does not know. Every failure of the dependency is a denial: the
 * gateway fails closed on anything that is not a successful answer.
 */

import type { Context } from 'hono'
import {
  decide,
  isMissingRole,
  isUuid,
  reasonCodeOf,
  REASONS,
  type DecisionFacts,
} from '../domains/authorization'
import { sameSecret } from '../observability'
import type { HubDependencies } from './dependencies'
import { jsonError } from './errors'
import type { HubEnv } from './state'

/**
 * The body of a decision.
 *
 * The four fields are the ones the gateway sends. The subject is the only
 * one that is required: a request without a subject names no principal.
 */
interface DecisionBody {
  subject: string
  workspaceId?: string
  routeId?: string
  roles?: string[]
}

/** Reads the body of a decision. */
async function readBody(context: Context<HubEnv>): Promise<DecisionBody> {
  let parsed: unknown
  try {
    parsed = await context.req.json()
  } catch {
    throw new InvalidRequestError('the body is not json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidRequestError('the body is not an object')
  }
  const body = parsed as Record<string, unknown>
  if (typeof body.subject !== 'string' || body.subject.length === 0) {
    throw new InvalidRequestError('the subject is required and it is a string')
  }
  // The subject is the id of a principal: a value that is not one names
  // no principal, and the request is refused instead of being asked of
  // the database (spec §8.1).
  if (!isUuid(body.subject)) {
    throw new InvalidRequestError('the subject is the id of a principal')
  }
  if (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') {
    throw new InvalidRequestError('the workspace is a string')
  }
  if (body.routeId !== undefined && typeof body.routeId !== 'string') {
    throw new InvalidRequestError('the route is a string')
  }
  if (
    body.roles !== undefined &&
    (!Array.isArray(body.roles) || body.roles.some((role) => typeof role !== 'string'))
  ) {
    throw new InvalidRequestError('the roles are a list of strings')
  }
  return {
    subject: body.subject,
    workspaceId: (body.workspaceId as string | undefined) ?? '',
    routeId: (body.routeId as string | undefined) ?? '',
    roles: (body.roles as string[] | undefined) ?? [],
  }
}

/** The refusal of a body that is not understood. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequestError'
  }
}

/**
 * The credentials of a call of the decision (spec §8.8).
 *
 * Two schemes are accepted: the bearer token of the deployment, which is
 * the scheme of the gateway of the reference and is not scoped, and the
 * credentials of a tenant, which are scoped to that tenant.
 */
interface DecisionCredentials {
  /** The tenant the decision is scoped to, or null for every tenant. */
  tenantId: string | null
  /** The slug of the tenant, for the log. */
  tenantSlug: string
  /** True when the caller presented the bearer token of the deployment. */
  sharedToken: boolean
}

/**
 * Reads the credentials of a call of the decision.
 *
 * The comparison of a secret is in constant time in both schemes. The
 * secret of a tenant is read from the storage and compared, and it is
 * never written to a log.
 */
async function readCredentials(
  header: string | undefined,
  dependencies: HubDependencies
): Promise<DecisionCredentials | null> {
  const value = (header ?? '').trim()

  // The credentials of a tenant: the client id names the tenant and the
  // secret is the one of the registration of its gateway.
  const basic = /^Basic\s+(.+)$/i.exec(value)
  if (basic) {
    let clientId = ''
    let clientSecret = ''
    try {
      const decoded = Buffer.from(basic[1]!.trim(), 'base64').toString('utf8')
      const separator = decoded.indexOf(':')
      if (separator < 0) return null
      clientId = decodeURIComponent(decoded.slice(0, separator))
      clientSecret = decodeURIComponent(decoded.slice(separator + 1))
    } catch {
      return null
    }
    if (!clientId || !clientSecret) return null
    const tenant = await dependencies.tenants.findByClientId(clientId)
    if (!tenant) return null
    const secrets = await dependencies.tenants.gatewaySecrets(tenant.id)
    if (!secrets.current) return null
    // The secret that a rotation replaced is accepted until the end of
    // the window of the rotation (spec §4.3).
    const previousAccepted =
      secrets.previous !== null &&
      secrets.previousUntil !== null &&
      secrets.previousUntil.getTime() > Date.now()
    const accepted =
      sameSecret(clientSecret, secrets.current) ||
      (previousAccepted && secrets.previous !== null && sameSecret(clientSecret, secrets.previous))
    if (!accepted) return null
    // A tenant with a shared client may ask about the principals of the
    // other tenants (spec §5.2): its decisions are not scoped.
    return {
      tenantId: tenant.sharedClient ? null : tenant.id,
      tenantSlug: tenant.slug,
      sharedToken: false,
    }
  }

  // The bearer token of the deployment: the scheme of the reference. The
  // token that a rotation replaced is accepted as well, so that the
  // rotation is a rolling change and not a simultaneous one.
  const bearer = /^Bearer\s+(.+)$/i.exec(value)
  const presented = bearer?.[1]?.trim() ?? ''
  const expectedToken = dependencies.accessToken
  const previousToken = dependencies.previousAccessToken
  const accepted =
    presented !== '' &&
    ((expectedToken !== undefined && sameSecret(presented, expectedToken)) ||
      (previousToken !== undefined && sameSecret(presented, previousToken)))
  if (!accepted) return null
  return { tenantId: null, tenantSlug: 'every-tenant', sharedToken: true }
}

/**
 * `POST /v1/decisions`: the answer of the access service of the gateway.
 */
export async function decisionHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const started = Date.now()
  const requestId = context.get('requestId')

  // The token of the gateway is compared in constant time.
  const credentials = await readCredentials(context.req.header('authorization'), dependencies)
  if (!credentials) {
    dependencies.logger.warn('the decision was refused', { requestId, reason: 'unauthorized' })
    dependencies.observer.recordDecision('deny', 'unknown', Date.now() - started)
    return jsonError(401, 'unauthorized', 'a valid access token is required')
  }

  let body: DecisionBody
  try {
    body = await readBody(context)
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      dependencies.logger.warn('the decision was refused', {
        requestId,
        reason: 'bad_request',
        detail: error.message,
      })
      return jsonError(400, 'bad_request', error.message)
    }
    throw error
  }

  let facts: DecisionFacts
  try {
    facts = await dependencies.decisions.decide({
      subject: body.subject,
      workspaceId: body.workspaceId ?? '',
      routeId: body.routeId ?? '',
      roles: body.roles ?? [],
      tenantId: credentials.tenantId,
    })
  } catch (error) {
    // A database that is down and a decision that is too slow are the same
    // thing for the gateway: it fails closed.
    dependencies.observer.recordStoreError('postgres')
    dependencies.logger.error('the decision could not be computed', { requestId, error })
    return jsonError(503, 'service_unavailable', 'the decision could not be computed')
  }

  const answer = decide(facts)
  const durationMs = Date.now() - started
  const tenant = facts.tenantSlug ?? credentials.tenantSlug

  // The bearer token of the deployment is deprecated: the notice says it
  // once, and it says what to do instead.
  if (credentials.sharedToken && !dependencies.sharedTokenNoticeWritten) {
    dependencies.sharedTokenNoticeWritten = true
    dependencies.logger.warn(
      'the decision was asked with the shared credential of the deployment, which is deprecated: it is not scoped to a tenant. The credentials of the tenant of the gateway are scoped to it, and they are the scheme to use (spec §8.8)',
      { requestId }
    )
  }

  dependencies.observer.recordDecision(answer.allow ? 'allow' : 'deny', tenant, durationMs)
  dependencies.logger.info('the decision was answered', {
    requestId,
    subject: body.subject,
    workspaceId: body.workspaceId,
    routeId: body.routeId,
    allow: answer.allow,
    reason: answer.reason,
    missingRole: answer.allow ? false : isMissingRole(answer.reason),
    // The roles of the request are the context of the decision: they are
    // recorded and they are never the policy.
    roles: body.roles,
    durationMs,
  })

  // The answer carries the code of the reason: the gateway counts the
  // code when the service sends one, and it counts the text of the
  // reason when the service sends none. The two agree, so the metric of
  // the gateway is the same with the pinned gateway and with the next
  // one (spec §8.7).
  if (answer.allow) {
    return context.json({ allow: true, reason: answer.reason })
  }
  return context.json({
    allow: false,
    reason: answer.reason,
    reasonCode: reasonCodeOf(answer.reason),
  })
}

/** The reason of an allowance, for the tests of the contract. */
export const ALLOWED_REASON = REASONS.allowed
