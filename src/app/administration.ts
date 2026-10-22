/**
 * The administrative endpoints of Hub (spec §10).
 *
 * The handlers are thin: they authenticate the call, they validate the
 * body, they ask the administration domain and they write the answer. The
 * rules live in the domain.
 */

import type { Context } from 'hono'
import { fingerprint } from '../observability'
import {
  AdministrationError,
  GrantBody,
  GroupBody,
  PrincipalBody,
  TenantBody,
  type AuditContext,
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
async function authenticate(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<void> {
  const address = dependencies.peerAddress(context.req.raw)
  try {
    await dependencies.administration.authenticate(context.req.header('authorization'), address)
  } catch (error) {
    if (error instanceof AdministrationError) {
      dependencies.logger.warn('the administrative call was refused', {
        endpoint: context.req.path,
        address,
        code: error.code,
      })
      throw error
    }
    // The count of the failed authentications is held by the shared store
    // of the deployment: a store that is down is a call that cannot be
    // authenticated, and the answer says so (spec §10.1).
    dependencies.logger.error('the administrative call could not be authenticated', {
      endpoint: context.req.path,
      address,
      error,
    })
    throw new AdministrationError(
      'service_unavailable',
      'the count of the failed authentications could not be read'
    )
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

/**
 * The facts of the call that the domain cannot know.
 *
 * The operator is the fingerprint of the credential that made the call:
 * two operators that hold two tokens are two operators in the audit,
 * and the token itself is never written.
 */
function auditContext(context: Context<HubEnv>, dependencies: HubDependencies): AuditContext {
  return {
    operator: operatorOf(context),
    address: dependencies.peerAddress(context.req.raw),
    requestId: context.get('requestId'),
  }
}

/**
 * The answer of a change, with the audit of the change.
 *
 * The row of the audit is written by the statement that changed the
 * thing: the change and its audit are committed together, or neither is
 * (spec §10.1). What is left to the application is the log of the call.
 */
async function answer(
  context: Context<HubEnv>,
  dependencies: HubDependencies,
  endpoint: string,
  status: number,
  body: unknown,
  audit?: AuditEntry
): Promise<Response> {
  const address = dependencies.peerAddress(context.req.raw)
  dependencies.logger.info('the administrative call', {
    endpoint,
    status,
    address,
    ...(audit?.action ? { action: audit.action } : {}),
    ...(audit?.id ? { id: audit.id } : {}),
    ...(audit?.tenant ? { tenant: audit.tenant } : {}),
  })
  return context.json(body, status as 200)
}

/**
 * The fingerprint of the credential of the operator.
 *
 * The audit names the operator by the fingerprint of the token that made
 * the call: two operators that hold two tokens are two operators in the
 * audit, and the token itself is never written.
 */
function operatorOf(context: Context<HubEnv>): string | null {
  const header = context.req.header('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const presented = match?.[1]?.trim()
  return presented ? fingerprint(presented) : null
}

/** The tenant of an answer: it never carries a secret. */
function tenantBody(tenant: {
  id: string
  slug: string
  displayName: string
  issuer: string
  emailDomain: string | null
  clientId: string
  clientRedirectUris: string[]
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
    clientRedirectUris: tenant.clientRedirectUris,
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
  userId: string | null
  group: string | null
  permission: string
  workspaceId: string | null
  routeId: string | null
  expiresAt: Date | null
  revokedAt: Date | null
  grantedBy: string | null
  createdAt: Date
}): Record<string, unknown> {
  return {
    id: grant.id,
    tenant: grant.tenant,
    userId: grant.userId,
    group: grant.group,
    permission: grant.permission,
    workspaceId: grant.workspaceId,
    routeId: grant.routeId,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    grantedBy: grant.grantedBy,
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
    await authenticate(context, dependencies)
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
      clientRedirectUris: body.clientRedirectUris,
      autoProvision: body.autoProvision ?? false,
      sharedClient: body.sharedClient ?? false,
      isDefault: body.default ?? false,
      enabled: body.enabled ?? true,
    }
    const result = await dependencies.administration.upsertTenant(
      registration,
      auditContext(context, dependencies)
    )
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
    await authenticate(context, dependencies)
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
    await authenticate(context, dependencies)
    const body = await readBody(context, PrincipalBody)
    const result = await dependencies.administration.upsertPrincipal(
      {
        tenant: body.tenant,
        externalSubject: body.externalSubject,
        email: body.email,
        displayName: body.displayName,
        status: body.status,
      },
      auditContext(context, dependencies)
    )
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

/** The group of an answer. */
function groupBody(group: {
  id: string
  tenant: string
  key: string
  displayName: string | null
  members: string[]
  createdAt: Date
}): Record<string, unknown> {
  return {
    id: group.id,
    tenant: group.tenant,
    key: group.key,
    displayName: group.displayName,
    members: group.members,
    createdAt: group.createdAt.toISOString(),
  }
}

/** `GET /v1/admin/groups`: the list of the groups. */
export async function groupsHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/groups'
  try {
    await authenticate(context, dependencies)
    const query = context.req.query()
    const page = await dependencies.administration.listGroups({
      tenant: query.tenant ?? null,
      key: query.key ?? null,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
    })
    return answer(context, dependencies, endpoint, 200, {
      groups: page.groups.map(groupBody),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    })
  } catch (error) {
    return failure(error)
  }
}

/** `GET /v1/admin/users`: the list of the principals. */
export async function principalsHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/users'
  try {
    await authenticate(context, dependencies)
    const query = context.req.query()
    const page = await dependencies.administration.listPrincipals({
      tenant: query.tenant ?? null,
      status: query.status ?? null,
      email: query.email ?? null,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
    })
    return answer(context, dependencies, endpoint, 200, {
      principals: page.principals.map(principalBody),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    })
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
    await authenticate(context, dependencies)
    const body = await readBody(context, GrantBody)
    const result = await dependencies.administration.upsertGrant(
      {
        tenant: body.tenant,
        userId: body.userId ?? null,
        group: body.group ?? null,
        permission: body.permission,
        workspaceId: body.workspaceId ?? null,
        routeId: body.routeId ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        grantedBy: body.grantedBy ?? null,
      },
      auditContext(context, dependencies)
    )
    return answer(context, dependencies, endpoint, 200, grantBody(result.grant), result.audit)
  } catch (error) {
    return failure(error)
  }
}

/** `POST /v1/admin/groups`: the group and its membership. */
export async function groupHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/groups'
  try {
    await authenticate(context, dependencies)
    const body = await readBody(context, GroupBody)
    const result = await dependencies.administration.upsertGroup(
      {
        tenant: body.tenant,
        key: body.key,
        displayName: body.displayName,
        members: body.members ?? [],
      },
      auditContext(context, dependencies)
    )
    return answer(
      context,
      dependencies,
      endpoint,
      result.created ? 201 : 200,
      groupBody(result.group),
      result.audit
    )
  } catch (error) {
    return failure(error)
  }
}

/** `GET /v1/admin/grants`: the list of the grants. */
export async function grantsHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/grants'
  try {
    await authenticate(context, dependencies)
    const query = context.req.query()
    const page = await dependencies.administration.listGrants({
      tenant: query.tenant ?? null,
      userId: query.userId ?? null,
      live: query.live ?? null,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
    })
    return answer(context, dependencies, endpoint, 200, {
      grants: page.grants.map(grantBody),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    })
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
    await authenticate(context, dependencies)
    const id = context.req.param('id')
    // An id that is not an id names no grant: the answer is the same as
    // the one of an id that does not exist.
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new AdministrationError('not_found', 'the grant does not exist')
    }
    const audit = await dependencies.administration.revokeGrant(
      id,
      auditContext(context, dependencies)
    )
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

/** The row of the audit, as it is published. */
function auditBody(record: {
  id: string
  at: Date
  action: string
  targetId: string | null
  tenant: string | null
  operator: string | null
  address: string | null
  requestId: string | null
}): Record<string, unknown> {
  return {
    id: record.id,
    at: record.at.toISOString(),
    action: record.action,
    targetId: record.targetId,
    tenant: record.tenant,
    operator: record.operator,
    address: record.address,
    requestId: record.requestId,
  }
}

/** The columns of the export of the audit, in the order of the file. */
const AUDIT_COLUMNS = [
  'id',
  'at',
  'action',
  'targetId',
  'tenant',
  'operator',
  'address',
  'requestId',
]

/**
 * Escapes a value of a cell of the export.
 *
 * A value that carries a comma, a quote or a line break is quoted, and
 * the quotes of the value are doubled: the file is read by a
 * spreadsheet, and a value that breaks it is a value that is lost.
 */
function csvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * The export of the audit, in CSV.
 *
 * The header is the name of the columns, and every row is a line: the
 * file is read by a spreadsheet and by a script.
 */
function auditCsv(records: ReturnType<typeof auditBody>[]): string {
  const lines = [AUDIT_COLUMNS.join(',')]
  for (const record of records) {
    lines.push(
      AUDIT_COLUMNS.map((column) => {
        const value = record[column]
        return csvCell(value === null || value === undefined ? '' : String(value))
      }).join(',')
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * The export of the audit, in JSON Lines.
 *
 * One object per line: the format that a script reads line by line,
 * without holding the whole file in the memory.
 */
function auditJsonl(records: ReturnType<typeof auditBody>[]): string {
  return (
    records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
  )
}

/** The name of the file of an export of the audit. */
function auditFilename(format: string): string {
  return `hub-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`
}

/**
 * `GET /v1/admin/audit`: the audit of the administration.
 *
 * It is the one endpoint of the administration that reads and that does
 * not change: it is the trail of the changes, and it is read only.
 */
export async function auditHandler(
  context: Context<HubEnv>,
  dependencies: HubDependencies
): Promise<Response> {
  const endpoint = '/v1/admin/audit'
  try {
    await authenticate(context, dependencies)
    const query = context.req.query()
    const page = await dependencies.administration.listAudit({
      tenant: query.tenant ?? null,
      action: query.action ?? null,
      limit: query.limit ?? null,
      offset: query.offset ?? null,
      format: query.format ?? null,
    })

    // The exports leave the platform: the rows are in a file that a
    // spreadsheet or a script reads (spec §10.12).
    if (page.format !== 'json') {
      const records = page.records.map(auditBody)
      const body = page.format === 'csv' ? auditCsv(records) : auditJsonl(records)
      return new Response(body, {
        headers: {
          'content-type':
            page.format === 'csv'
              ? 'text/csv; charset=utf-8'
              : 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${auditFilename(page.format)}"`,
        },
      })
    }

    return answer(context, dependencies, endpoint, 200, {
      records: page.records.map(auditBody),
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    })
  } catch (error) {
    return failure(error)
  }
}
