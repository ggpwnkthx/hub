/**
 * The decision contract of the gateway (spec §8).
 *
 * The handler answers the request the gateway already sends: it does not
 * require a field the gateway does not send and it does not refuse a field
 * it does not know. Every failure of the dependency is a denial: the
 * gateway fails closed on anything that is not a successful answer.
 */

import type { Context } from 'hono'
import { decide, isMissingRole, REASONS, type DecisionFacts } from '../domains/authorization'
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
 * `POST /v1/decisions`: the answer of the access service of the gateway.
 */
export async function decisionHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const started = Date.now()
  const requestId = context.get('requestId')

  // The token of the gateway is compared in constant time.
  const header = context.req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const presented = match?.[1]?.trim() ?? ''
  const expected = dependencies.accessToken
  if (!expected || !presented || !sameSecret(presented, expected)) {
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
  const tenant = facts.tenantSlug ?? 'unknown'

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

  return context.json({ allow: answer.allow, reason: answer.reason })
}

/** The reason of an allowance, for the tests of the contract. */
export const ALLOWED_REASON = REASONS.allowed
