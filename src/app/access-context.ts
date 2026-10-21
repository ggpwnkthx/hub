/**
 * The contract of the access context (spec §8bis).
 *
 * The contract has two methods. The discovery tells a consumer which
 * versions of the contract the service speaks and what its limits are.
 * The evaluation answers the context of a principal: the complete set of
 * the capabilities the principal holds for a workspace and a route.
 *
 * Both methods need a dedicated read only service credential. The
 * credential is scoped to an explicit set of tenants: it authorizes the
 * reading of a context and nothing else.
 */

import type { Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import {
  type AccessContextAnswer,
  type AccessContextFacts,
  type AccessContextRequest,
  type AccessContextStore,
  isUuid,
  ACCESS_CONTEXT_VERSION,
  MAX_LIFETIME_MS,
  MAX_PERMISSION_KEYS,
  MAX_REQUEST_BYTES,
  evaluateAccessContext,
} from '../domains/authorization'
import { jsonError } from './errors'
import type { HubEnv } from './state'

/** A credential of the contract. */
export interface AccessContextCredential {
  /** The bearer token of the credential. */
  token: string
  /** The tenants the credential may ask about, or null for every tenant. */
  tenants: string[] | null
}

/** The dependencies of the contract. */
export interface AccessContextDependencies {
  /** The storage of the context. */
  store: AccessContextStore
  /** The credentials of the contract. */
  credentials: AccessContextCredential[]
  /** The observer of the service. */
  observer?: {
    recordDecision?: (result: 'allow' | 'deny', tenant: string, durationMs: number) => void
  }
}

/** The fields of a request of a context. */
const REQUEST_FIELDS = ['version', 'subject', 'tenantId', 'workspaceId', 'routeId']

/** The refusal of a request that is not understood. */
class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequestError'
  }
}

/** Compares two secrets in constant time. */
function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Reads the credential of a call.
 *
 * The credential of a tenant may only ask about the principals of that
 * tenant. A credential of the platform may ask about every tenant: it is
 * a choice of the deployment and not the default of a tenant credential.
 */
function readCredential(
  header: string | undefined,
  credentials: readonly AccessContextCredential[]
): AccessContextCredential | null {
  const value = (header ?? '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(value)
  const presented = match?.[1]?.trim() ?? ''
  if (!presented) return null
  for (const credential of credentials) {
    if (sameSecret(presented, credential.token)) return credential
  }
  return null
}

/** Reads the body of a request of a context. */
async function readBody(context: Context<HubEnv>): Promise<AccessContextRequest> {
  const text = await context.req.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) {
    throw new InvalidRequestError('the body is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new InvalidRequestError('the body is not json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidRequestError('the body is not an object')
  }
  const body = parsed as Record<string, unknown>
  const unknown = Object.keys(body).filter((key) => !REQUEST_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw new InvalidRequestError(`the body has unknown fields: ${unknown.sort().join(', ')}`)
  }
  if (body.version !== ACCESS_CONTEXT_VERSION) {
    throw new InvalidRequestError('the version of the contract is not supported')
  }
  for (const field of ['subject', 'tenantId', 'workspaceId', 'routeId']) {
    if (typeof body[field] !== 'string' || (body[field] as string).length === 0) {
      throw new InvalidRequestError(`the field "${field}" is required and it is a string`)
    }
  }
  // The subject and the tenant are the ids of the rows of the platform:
  // a value that is not one names no row, and the request is refused
  // instead of being asked of the database (spec §8bis.2).
  for (const field of ['subject', 'tenantId']) {
    if (!isUuid(body[field] as string)) {
      throw new InvalidRequestError(`the field "${field}" is the id of a row of the platform`)
    }
  }
  return {
    subject: body.subject as string,
    tenantId: body.tenantId as string,
    workspaceId: body.workspaceId as string,
    routeId: body.routeId as string,
  }
}

/**
 * `GET /v1/access-context`: the discovery of the contract.
 *
 * The discovery is the readiness check of a consumer: an unknown version
 * stops the readiness of the consumer.
 */
export function accessContextDiscoveryHandler(
  context: Context<HubEnv>,
  dependencies: AccessContextDependencies
): Response {
  const credential = readCredential(context.req.header('authorization'), dependencies.credentials)
  if (!credential) {
    return jsonError(401, 'unauthorized', 'a valid access context credential is required')
  }
  return context.json({
    versions: [ACCESS_CONTEXT_VERSION],
    maxPermissionKeys: MAX_PERMISSION_KEYS,
    maxLifetimeMs: MAX_LIFETIME_MS,
  })
}

/**
 * `POST /v1/access-context`: the context of a principal.
 *
 * A refusal is an answer of 200: the caller learns that the principal
 * may not use the workspace, and it learns nothing about the cause.
 */
export async function accessContextHandler(
  context: Context<HubEnv>,
  dependencies: AccessContextDependencies
): Promise<Response> {
  const started = Date.now()
  const credential = readCredential(context.req.header('authorization'), dependencies.credentials)
  if (!credential) {
    return jsonError(401, 'unauthorized', 'a valid access context credential is required')
  }

  let request: AccessContextRequest
  try {
    request = await readBody(context)
  } catch (error) {
    if (error instanceof InvalidRequestError) {
      return jsonError(400, 'bad_request', error.message)
    }
    throw error
  }

  if (credential.tenants !== null && !credential.tenants.includes(request.tenantId)) {
    return jsonError(403, 'forbidden', 'the credential may not ask about this tenant')
  }

  let facts: AccessContextFacts
  try {
    facts = await dependencies.store.context(request)
  } catch {
    return jsonError(503, 'service_unavailable', 'the context could not be computed')
  }

  const answer: AccessContextAnswer = evaluateAccessContext(facts, new Date())
  if (answer.permissionKeys.length > MAX_PERMISSION_KEYS) {
    // The answer is never partial: too many keys is a failure.
    return jsonError(503, 'service_unavailable', 'the context is larger than the contract allows')
  }

  dependencies.observer?.recordDecision?.(
    answer.allow ? 'allow' : 'deny',
    request.tenantId,
    Date.now() - started
  )

  const body: Record<string, unknown> = {
    version: ACCESS_CONTEXT_VERSION,
    allow: answer.allow,
    subject: request.subject,
    tenantId: request.tenantId,
    workspaceId: request.workspaceId,
    routeId: request.routeId,
    permissionKeys: answer.permissionKeys,
    evaluatedAt: answer.evaluatedAt.toISOString(),
  }
  if (answer.allow && answer.validUntil) {
    body.validUntil = answer.validUntil.toISOString()
  }
  return context.json(body)
}
