/**
 * The administrative endpoints of Hub (spec §9).
 *
 * The handlers are thin: they authenticate the call, they validate the
 * body, they ask the administration domain and they write the answer. The
 * rules live in the domain.
 */

import type { Context } from 'hono'
import {
  AdministrationError,
  GrantBody,
  PrincipalBody,
  TenantBody,
  type AuditEntry,
} from '../domains/administration'
import type { HubDependencies } from './dependencies'
import { jsonError } from './errors'
import type { HubEnv } from './state'

/** The size of a body of the administration. */
export const MAX_BODY_BYTES = 65_536

/**
 * Reads the body of a call and validates it.
 *
 * A body that is too large is a `413`, a body that is not JSON or that
 * does not match the schema is a `400`: the database is not touched
 * before the body is understood.
 */
async function readBody<T>(
  context: Context<HubEnv>,
  schema: {
    safeParse: (value: unknown) => { success: boolean; data?: T; error?: { issues: unknown[] } }
  }
): Promise<T> {
  const declared = Number(context.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError()
  }
  const raw = await context.req.text()
  if (raw.length > MAX_BODY_BYTES) {
    throw new BodyTooLargeError()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AdministrationError('invalid_request', 'the body is not json')
  }
  const result = schema.safeParse(parsed)
  if (!result.success || result.data === undefined) {
    const issues = result.error?.issues ?? []
    const first = issues[0] as { path?: unknown[]; message?: string } | undefined
    const field =
      Array.isArray(first?.path) && first.path.length > 0 ? first.path.join('.') : 'body'
    throw new AdministrationError(
      'invalid_request',
      `${field}: ${first?.message ?? 'the body is not valid'}`
    )
  }
  return result.data
}

/** The refusal of a body that is too large. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('the body is too large')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Authenticates the call and answers the failure of the authentication.
 *
 * The address of the caller is the key of the limiter: it is the address
 * of the socket, not the one of a header the caller controls.
 */
function authenticate(context: Context<HubEnv>, dependencies: HubDependencies): void {
  const address = dependencies.peerAddress(context.req.raw)
  try {
    dependencies.administration.authenticate(context.req.header('authorization'), address)
  } catch (error) {
    if (error instanceof AdministrationError) {
      dependencies.logger.warn('the administrative call was refused', {
        endpoint: context.req.path,
        address,
        code: error.code,
      })
      throw error
    }
    throw error
  }
}

/** Turns a failure of the domain into the answer of the protocol. */
function failure(error: unknown): Response {
  if (error instanceof AdministrationError) {
    const headers: Record<string, string> = {}
    if (error.retryAfterMs !== undefined) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)))
    }
    return new Response(JSON.stringify({ error: error.code, message: error.message }), {
      status: error.status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }
  if (error instanceof BodyTooLargeError) {
    return jsonError(413, 'invalid_request', 'the body is too large')
  }
  throw error
}

/** The answer of a change, with the audit of the change. */
function answer(
  context: Context<HubEnv>,
  dependencies: HubDependencies,
  endpoint: string,
  status: number,
  body: unknown,
  audit?: AuditEntry
): Response {
  dependencies.logger.info('the administrative call', {
    endpoint,
    status,
    address: dependencies.peerAddress(context.req.raw),
    ...(audit?.action ? { action: audit.action } : {}),
    ...(audit?.id ? { id: audit.id } : {}),
    ...(audit?.tenant ? { tenant: audit.tenant } : {}),
  })
  return context.json(body, status as 200)
}

/** The tenant of an answer: it never carries a secret. */
function tenantBody(tenant: {
  id: string
  slug: string
  displayName: string
  issuer: string
  emailDomain: string | null
  clientId: string
  autoProvision: boolean
  sharedClient: boolean
  isDefault: boolean
  enabled: boolean
  createdAt: Date
}): Record<string, unknown> {
  return {
    id: tenant.id,
    slug: tenant.slug,
    displayName: tenant.displayName,
    issuer: tenant.issuer,
    emailDomain: tenant.emailDomain,
    clientId: tenant.clientId,
    autoProvision: tenant.autoProvision,
    sharedClient: tenant.sharedClient,
    default: tenant.isDefault,
    enabled: tenant.enabled,
    createdAt: tenant.createdAt.toISOString(),
  }
}

/** The principal of an answer. */
function principalBody(principal: {
  id: string
  tenant: string
  externalSubject: string
  email: string | null
  displayName: string | null
  status: string
  lastLoginAt: Date | null
  createdAt: Date
}): Record<string, unknown> {
  return {
    id: principal.id,
    tenant: principal.tenant,
    externalSubject: principal.externalSubject,
    email: principal.email,
    displayName: principal.displayName,
    status: principal.status,
    lastLoginAt: principal.lastLoginAt?.toISOString() ?? null,
    createdAt: principal.createdAt.toISOString(),
  }
}

/** The grant of an answer. */
function grantBody(grant: {
  id: string
  tenant: string
  userId: string
  permission: string
  workspaceId: string | null
  routeId: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}): Record<string, unknown> {
  return {
    id: grant.id,
    tenant: grant.tenant,
    userId: grant.userId,
    permission: grant.permission,
    workspaceId: grant.workspaceId,
    routeId: grant.routeId,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
  }
}

/** `POST /v1/admin/tenants`: the tenant of a slug is created or changed. */
export async function tenantHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/tenants'
  try {
    authenticate(context, dependencies)
    const body = await readBody(context, TenantBody)
    const registration = {
      slug: body.slug,
      displayName: body.displayName,
      issuer: body.issuer,
      idpClientId: body.idpClientId,
      idpClientSecret: body.idpClientSecret,
      idpRedirectUri: body.idpRedirectUri ?? `${dependencies.publicUrl}/oauth/tenant/callback`,
      idpScopes: body.idpScopes ?? ['openid', 'email', 'profile'],
      idpAlgorithms: body.idpAlgorithms ?? ['RS256'],
      emailDomain: body.emailDomain ?? null,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      autoProvision: body.autoProvision ?? false,
      sharedClient: body.sharedClient ?? false,
      isDefault: body.default ?? false,
      enabled: body.enabled ?? true,
    }
    const result = await dependencies.administration.upsertTenant(registration)
    return answer(
      context,
      dependencies,
      endpoint,
      result.created ? 201 : 200,
      tenantBody(result.tenant),
      result.audit
    )
  } catch (error) {
    return failure(error)
  }
}

/** `GET /v1/admin/tenants`: the tenants of the platform. */
export async function tenantsHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/tenants'
  try {
    authenticate(context, dependencies)
    const tenants = await dependencies.administration.listTenants()
    return answer(context, dependencies, endpoint, 200, {
      tenants: tenants.map((tenant) => ({
        ...tenantBody(tenant),
        userCount: tenant.userCount,
        grantCount: tenant.grantCount,
      })),
    })
  } catch (error) {
    return failure(error)
  }
}

/** `POST /v1/admin/users`: the principal of an external identity. */
export async function principalHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/users'
  try {
    authenticate(context, dependencies)
    const body = await readBody(context, PrincipalBody)
    const result = await dependencies.administration.upsertPrincipal({
      tenant: body.tenant,
      externalSubject: body.externalSubject,
      email: body.email,
      displayName: body.displayName,
      status: body.status,
    })
    return answer(
      context,
      dependencies,
      endpoint,
      result.created ? 201 : 200,
      principalBody(result.principal),
      result.audit
    )
  } catch (error) {
    return failure(error)
  }
}

/** `PUT /v1/admin/grants`: the grant of a scope. */
export async function grantHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/grants'
  try {
    authenticate(context, dependencies)
    const body = await readBody(context, GrantBody)
    const result = await dependencies.administration.upsertGrant({
      tenant: body.tenant,
      userId: body.userId,
      permission: body.permission,
      workspaceId: body.workspaceId ?? null,
      routeId: body.routeId ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      grantedBy: body.grantedBy ?? null,
    })
    return answer(context, dependencies, endpoint, 200, grantBody(result.grant), result.audit)
  } catch (error) {
    return failure(error)
  }
}

/** `DELETE /v1/admin/grants/{id}`: the revocation of a grant. */
export async function revokeGrantHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/grants'
  try {
    authenticate(context, dependencies)
    const id = context.req.param('id')
    // An id that is not an id names no grant: the answer is the same as
    // the one of an id that does not exist.
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new AdministrationError('not_found', 'the grant does not exist')
    }
    const audit = await dependencies.administration.revokeGrant(id)
    dependencies.logger.info('the administrative call', {
      endpoint,
      status: 204,
      address: dependencies.peerAddress(context.req.raw),
      action: audit.action,
      id: audit.id,
      ...(audit.tenant ? { tenant: audit.tenant } : {}),
    })
    return new Response(null, { status: 204 })
  } catch (error) {
    return failure(error)
  }
}
