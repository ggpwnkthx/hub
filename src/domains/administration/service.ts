/**
 * The administration of Hub (spec §10).
 *
 * Five endpoints, and they are the whole surface of the administration:
 * a tenant, a principal and a grant are created and revoked with them and
 * with nothing else. The service owns the rules; the storage is a port
 * that the composition root fulfils.
 */

import { sameSecret } from '../../observability'
import { AdministrationError } from './errors'
import type { AdminCredential, AdminScope } from './credentials'
import type { FailedAuthenticationLimiter } from './limiter'
import type {
  AuditContext,
  AuditFormat,
  AuditPage,
  AuditStore,
  ChangeAudit,
  Grant,
  GrantFilter,
  Group,
  GroupFilter,
  GroupPage,
  GroupRegistration,
  GroupStore,
  GrantPage,
  GrantRegistration,
  GrantStore,
  Permission,
  PermissionStore,
  Principal,
  PrincipalFilter,
  PrincipalPage,
  PrincipalRegistration,
  PrincipalStatus,
  PrincipalStore,
  Tenant,
  TenantRegistration,
  TenantStore,
  TenantSummary,
} from './ports'

export interface AdministrationOptions {
  /** The storage of the tenants. */
  tenants: TenantStore
  /** The storage of the principals. */
  principals: PrincipalStore
  /** The storage of the groups. */
  groups?: GroupStore
  /** The storage of the permissions. */
  permissions: PermissionStore
  /** The storage of the grants. */
  grants: GrantStore
  /** The bearer token of the administration. */
  token?: string
  /**
   * The credentials of the tenants (spec §10.1).
   *
   * A credential of a tenant may only act for that tenant, and it may
   * carry the name of its operator: the audit of a change names the
   * operator and not the secret it used.
   */
  credentials?: AdminCredential[]
  /**
   * The token that the current one replaced.
   *
   * It is accepted until the deployment removes it: a rotation of the
   * token of the administration is then a rolling change and not a
   * simultaneous one (spec §4.3).
   */
  previousToken?: string
  /** The public url of Hub, for the default callback of a tenant. */
  publicUrl: string
  /**
   * The limiter of the failed authentications.
   *
   * It is required: the composition root holds the count of the failures
   * (the shared store of the deployment, or the memory of the process of
   * a single node), and the domain never chooses where the count lives.
   */
  limiter: FailedAuthenticationLimiter
  /** The storage of the audit of the administration. */
  audit?: AuditStore
}

/**
 * The entry of the audit of a change (spec §10.1).
 *
 * The audit names what changed and the thing that changed: the secrets are
 * never in it. The row of the table is written by the statement that
 * changed the thing, so this entry is what the log of the service says
 * about it.
 */
export interface AuditEntry {
  /** What happened: `tenant.created`, `grant.revoked`, and so on. */
  action: string
  /** The identifier of the thing that changed. */
  id: string
  /** The slug of the tenant, when the change belongs to one. */
  tenant?: string
}

/**
 * The outcome of one principal of a batch.
 *
 * The answer of a batch names every item: the one that was written and
 * the one that was refused, with the code of the refusal.
 */
export interface PrincipalOutcome {
  /** The tenant of the principal. */
  tenant: string
  /** The external identity of the principal. */
  externalSubject: string
  /** The id of the principal, or null when the item failed. */
  id: string | null
  /** True when the principal was created, false when it was updated. */
  created: boolean
  /** The code of the refusal, when the item failed. */
  error?: string
  /** The message of the refusal, when the item failed. */
  message?: string
}

/**
 * The outcome of one grant of a batch.
 *
 * The rules are the ones of the outcome of a principal.
 */
export interface GrantOutcome {
  /** The tenant of the grant. */
  tenant: string
  /** The id of the grant, or null when the item failed. */
  id: string | null
  /** True when the grant was created, false when it was updated. */
  created: boolean
  /** The code of the refusal, when the item failed. */
  error?: string
  /** The message of the refusal, when the item failed. */
  message?: string
}

/** The default size of a page of the administration. */
const DEFAULT_PAGE_SIZE = 50

/** The maximum size of a page of the administration. */
const MAX_PAGE_SIZE = 200

/**
 * Reads a whole number of the query of a list.
 *
 * A value that is not a whole number, a value that is below the minimum
 * and a value that is above the maximum are refused: the page is never
 * read from a value that was not understood.
 */
function wholeNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string
): number {
  if (value === undefined || value.trim() === '') return fallback
  const text = value.trim()
  if (!/^\d+$/.test(text)) {
    throw new AdministrationError('invalid_request', `${name} must be a whole number`)
  }
  const parsed = Number(text)
  if (parsed < min || parsed > max) {
    throw new AdministrationError('invalid_request', `${name} must be between ${min} and ${max}`)
  }
  return parsed
}

/**
 * The maximum number of rows of an export of the audit.
 *
 * The export leaves the platform: it is a file that an operator keeps. The
 * number is a ceiling, not a promise: an audit that holds more rows is
 * exported page by page.
 */
const MAX_EXPORT_ROWS = 10_000

/**
 * Reads the format of the answer of the audit.
 *
 * A format that is not one of the three is refused: an export that is
 * asked for in a format the service does not know is not an export.
 */
function auditFormat(value: string | null): AuditFormat {
  const text = (value ?? '').trim().toLowerCase()
  if (text === '' || text === 'json') return 'json'
  if (text === 'csv') return 'csv'
  if (text === 'jsonl') return 'jsonl'
  throw new AdministrationError('invalid_request', 'the format must be json, csv or jsonl')
}

/**
 * Reads the status of a principal of the query of a list.
 *
 * A status that is not one of the two of the schema is refused.
 */
function statusOf(value: string | undefined): PrincipalStatus | null {
  if (value === undefined || value.trim() === '') return null
  const text = value.trim()
  if (text !== 'active' && text !== 'disabled') {
    throw new AdministrationError('invalid_request', 'status must be active or disabled')
  }
  return text
}

/**
 * Reads the "live" filter of the list of the grants.
 *
 * A value that is not `true` and not `false` is refused: the operator
 * does not get a list of something he did not ask for.
 */
function liveOf(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === '') return null
  const text = value.trim().toLowerCase()
  if (text === 'true') return true
  if (text === 'false') return false
  throw new AdministrationError('invalid_request', 'live must be true or false')
}

/** The administration of Hub. */
export class AdministrationService {
  private readonly limiter: FailedAuthenticationLimiter

  constructor(private readonly options: AdministrationOptions) {
    this.limiter = options.limiter
  }

  /**
   * Authenticates a call of the administration.
   *
   * The token is compared in constant time. A failure is counted: a burst
   * of them is refused with `429`, so the token cannot be guessed by
   * hammering the endpoint.
   *
   * The budget of an address is spent by the calls that **fail**. A call
   * that authenticates itself is answered, whatever the address presented
   * before: an address that used up its budget cannot lock out the
   * operator that holds the token.
   *
   * Two tokens are accepted during a rotation: the one of the deployment
   * and the one it replaced.
   *
   * The call answers the **scope** of the credential it presented: the
   * tenant it may act for and the operator it is. The token of the
   * platform is the scope of the platform (spec §10.1).
   */
  async authenticate(header: string | undefined, address: string): Promise<AdminScope> {
    const expected = this.options.token
    const previous = this.options.previousToken
    const credentials = this.options.credentials ?? []
    const match = /^Bearer\s+(.+)$/i.exec((header ?? '').trim())
    const presented = match?.[1]?.trim() ?? ''

    // Every candidate is compared, and the comparison does not stop at
    // the first one: the time of the answer may not tell which of the
    // credentials was presented.
    const comparisons: boolean[] = []
    if (expected !== undefined) comparisons.push(sameSecret(presented, expected))
    if (previous !== undefined) comparisons.push(sameSecret(presented, previous))
    for (const credential of credentials) {
      comparisons.push(sameSecret(presented, credential.token))
    }
    const accepted = presented !== '' && comparisons.some(Boolean)

    if (!accepted) {
      // The address that used up its budget is refused, and it is refused
      // here: the budget is the one of the calls that fail.
      const blocked = await this.limiter.blocked(address)
      if (blocked.blocked) {
        throw new AdministrationError(
          'too_many_requests',
          'too many failed authentications from this address',
          blocked.retryAfterMs
        )
      }
      const failure = await this.limiter.fail(address)
      if (!failure.allowed) {
        throw new AdministrationError(
          'too_many_requests',
          'too many failed authentications from this address',
          failure.retryAfterMs
        )
      }
      throw new AdministrationError('unauthorized', 'a valid administration token is required')
    }
    await this.limiter.succeed(address)

    // The scope of the call: the credential of a tenant is scoped to it,
    // and the token of the platform is the scope of the platform.
    const credential = credentials.find((candidate) => sameSecret(presented, candidate.token))
    if (credential) {
      return { tenant: credential.tenant, operator: credential.operator }
    }
    return { tenant: null, operator: null }
  }

  /**
   * Refuses a call that acts for a tenant the credential may not act for.
   *
   * A credential of a tenant may only act for that tenant: a call that
   * names another one is a `403 forbidden`, and it names nothing that
   * would tell the caller whether that tenant exists (spec §10.1).
   */
  private refuseOutsideScope(scope: AdminScope, tenant: string | null | undefined): void {
    if (scope.tenant === null) return
    if (tenant !== undefined && tenant !== null && tenant.trim() === scope.tenant) return
    throw new AdministrationError('forbidden', 'the credential may not act for this tenant')
  }

  /**
   * Creates a tenant, or updates the tenant of that slug.
   *
   * The slug is the key of the row: the call is an upsert. A client id
   * belongs to one tenant and a default belongs to one tenant: both are
   * a conflict.
   *
   * The context carries the facts of the call that the domain cannot
   * know: the operator, the address and the request. The row of the audit
   * is written by the statement that writes the tenant (spec §10.1).
   */
  async upsertTenant(
    scope: AdminScope,
    registration: TenantRegistration,
    context: AuditContext
  ): Promise<{ tenant: Tenant; created: boolean; audit: AuditEntry }> {
    this.refuseOutsideScope(scope, registration.slug)
    const existing = await this.options.tenants.findBySlug(registration.slug)
    // A credential of a tenant changes that tenant: it does not create
    // it. The creation of a tenant is the work of the operator of the
    // platform.
    if (scope.tenant !== null && !existing) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }

    // The flags that change the scope of the platform belong to the
    // operator of the platform: the shared client of a tenant moves the
    // logins of the platform and lifts the scope of the decisions of its
    // gateway, and the default tenant of the platform routes the logins
    // of the shared clients. A credential of a tenant may not change
    // them.
    if (scope.tenant !== null && existing) {
      if (registration.sharedClient !== existing.sharedClient) {
        throw new AdministrationError(
          'forbidden',
          'the credential may not change the shared client of the tenant'
        )
      }
      if (registration.isDefault !== existing.isDefault) {
        throw new AdministrationError(
          'forbidden',
          'the credential may not change the default tenant of the platform'
        )
      }
    }

    // A client id belongs to one tenant.
    const owner = await this.options.tenants.findByClientId(registration.clientId)
    if (owner && owner.id !== existing?.id) {
      throw new AdministrationError(
        'conflict',
        'the client id of the gateway belongs to another tenant'
      )
    }

    // At most one tenant is the default.
    if (registration.isDefault) {
      const current = (await this.options.tenants.list()).find((tenant) => tenant.isDefault)
      if (current && current.id !== existing?.id) {
        throw new AdministrationError('conflict', 'another tenant is already the default')
      }
    }

    if (!existing) {
      const tenant = await this.options.tenants.create(
        registration,
        this.change('tenant.created', registration.slug, context)
      )
      return {
        tenant,
        created: true,
        audit: { action: 'tenant.created', id: tenant.id, tenant: tenant.slug },
      }
    }

    const tenant = await this.options.tenants.update(
      existing.id,
      registration,
      this.change('tenant.updated', existing.slug, context)
    )
    if (!tenant) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }
    return {
      tenant,
      created: false,
      audit: { action: 'tenant.updated', id: tenant.id, tenant: tenant.slug },
    }
  }

  /** The tenants of the platform, with their numbers. */
  async listTenants(scope: AdminScope): Promise<TenantSummary[]> {
    const tenants = await this.options.tenants.list()
    // A credential of a tenant sees its own tenant and nothing else.
    if (scope.tenant === null) return tenants
    return tenants.filter((tenant) => tenant.slug === scope.tenant)
  }

  /**
   * The principals that match a filter, and their number.
   *
   * The page is read from the table of the principals: the filter of the
   * tenant is optional, and a tenant that does not exist is a
   * `404 not_found`.
   */
  async listPrincipals(
    scope: AdminScope,
    query: {
      tenant?: string | null
      status?: string | null
      email?: string | null
      limit?: string | null
      offset?: string | null
    }
  ): Promise<PrincipalPage> {
    const limit = wholeNumber(
      query.limit ?? undefined,
      DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
      'limit'
    )
    const offset = wholeNumber(query.offset ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
    const status = statusOf(query.status ?? undefined)

    let tenantId: string | null = null
    // The filter of the tenant of a credential that is scoped to a
    // tenant is the tenant of the credential: the filter of the query
    // cannot widen it.
    const slug = scope.tenant ?? query.tenant?.trim()
    if (slug) {
      const tenant = await this.options.tenants.findBySlug(slug)
      if (!tenant) {
        throw new AdministrationError('not_found', 'the tenant does not exist')
      }
      tenantId = tenant.id
    }

    const filter: PrincipalFilter = {
      tenantId,
      status,
      email: query.email?.trim() || null,
      limit,
      offset,
    }
    const page = await this.options.principals.list(filter)
    return { principals: page.principals, total: page.total, limit, offset }
  }

  /**
   * The groups that match a filter, and their number.
   *
   * A tenant that does not exist is a `404 not_found`, like everywhere
   * else. The groups are paginated like the other lists (spec §10.1).
   */
  async listGroups(
    scope: AdminScope,
    query: {
      tenant?: string | null
      key?: string | null
      limit?: string | null
      offset?: string | null
    }
  ): Promise<GroupPage> {
    const groups = this.options.groups
    if (!groups) {
      throw new AdministrationError('forbidden', 'the groups are not enabled in this deployment')
    }
    const limit = wholeNumber(
      query.limit ?? undefined,
      DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
      'limit'
    )
    const offset = wholeNumber(query.offset ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')

    let tenantId: string | null = null
    const slug = scope.tenant ?? query.tenant?.trim()
    if (slug) {
      const tenant = await this.options.tenants.findBySlug(slug)
      if (!tenant) {
        throw new AdministrationError('not_found', 'the tenant does not exist')
      }
      tenantId = tenant.id
    }

    const filter: GroupFilter = {
      tenantId,
      key: query.key?.trim() || null,
      limit,
      offset,
    }
    const page = await groups.list(filter)
    return { groups: page.groups, total: page.total, limit, offset }
  }

  /**
   * The grants that match a filter, and their number.
   *
   * A tenant that does not exist is a `404 not_found`, and a principal
   * that does not exist is an empty list: the id of a principal of
   * another tenant is not a way to read the grants of this one.
   */
  async listGrants(
    scope: AdminScope,
    query: {
      tenant?: string | null
      userId?: string | null
      live?: string | null
      limit?: string | null
      offset?: string | null
    }
  ): Promise<GrantPage> {
    const limit = wholeNumber(
      query.limit ?? undefined,
      DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
      'limit'
    )
    const offset = wholeNumber(query.offset ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
    const live = liveOf(query.live ?? undefined)

    let tenantId: string | null = null
    const slug = scope.tenant ?? query.tenant?.trim()
    if (slug) {
      const tenant = await this.options.tenants.findBySlug(slug)
      if (!tenant) {
        throw new AdministrationError('not_found', 'the tenant does not exist')
      }
      tenantId = tenant.id
    }

    const userId = query.userId?.trim() || null
    const filter: GrantFilter = { tenantId, userId, live, limit, offset }
    const page = await this.options.grants.list(filter)
    return { grants: page.grants, total: page.total, limit, offset }
  }

  /**
   * Creates a principal, or updates the principal of that
   * `(tenant, externalSubject)` pair.
   *
   * The row of the audit is written by the statement that writes the
   * principal (spec §10.1).
   */
  async upsertPrincipal(
    scope: AdminScope,
    registration: PrincipalRegistration,
    context: AuditContext
  ): Promise<{ principal: Principal; created: boolean; audit: AuditEntry }> {
    this.refuseOutsideScope(scope, registration.tenant)
    const tenant = await this.options.tenants.findBySlug(registration.tenant)
    if (!tenant) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }

    const existing = await this.options.principals.findByExternalSubject(
      tenant.id,
      registration.externalSubject
    )
    if (!existing) {
      const principal = await this.options.principals.create(
        {
          tenantId: tenant.id,
          externalSubject: registration.externalSubject,
          email: registration.email ?? null,
          displayName: registration.displayName ?? null,
          status: registration.status ?? 'active',
        },
        this.change('principal.created', tenant.slug, context)
      )
      return {
        principal,
        created: true,
        audit: { action: 'principal.created', id: principal.id, tenant: tenant.slug },
      }
    }

    const principal = await this.options.principals.update(
      existing.id,
      {
        email: registration.email,
        displayName: registration.displayName,
        status: registration.status,
      },
      this.change('principal.updated', tenant.slug, context)
    )
    if (!principal) {
      throw new AdministrationError('not_found', 'the principal does not exist')
    }
    return {
      principal,
      created: false,
      audit: { action: 'principal.updated', id: principal.id, tenant: tenant.slug },
    }
  }

  /**
   * Writes a batch of principals.
   *
   * A batch is the call that onboards a tenant: one call writes a
   * hundred principals instead of a hundred calls.
   *
   * **Every item is written on its own.** The change of an item and the
   * row of its audit are one statement, so an item that is written is
   * audited, and an item that fails leaves nothing behind. The answer
   * names the outcome of every item: an item that failed does not stop
   * the others, because an operator that onboards a tenant wants to know
   * *which* identities were refused.
   *
   * The call is **idempotent**: the same batch again writes the same
   * principals, and the ones that exist are updated instead of created.
   */
  async upsertPrincipals(
    scope: AdminScope,
    registrations: PrincipalRegistration[],
    context: AuditContext
  ): Promise<PrincipalOutcome[]> {
    const outcomes: PrincipalOutcome[] = []
    for (const registration of registrations) {
      try {
        const result = await this.upsertPrincipal(scope, registration, context)
        outcomes.push({
          tenant: result.principal.tenant,
          externalSubject: result.principal.externalSubject,
          id: result.principal.id,
          created: result.created,
        })
      } catch (error) {
        if (error instanceof AdministrationError) {
          outcomes.push({
            tenant: registration.tenant,
            externalSubject: registration.externalSubject,
            id: null,
            created: false,
            error: error.code,
            message: error.message,
          })
          continue
        }
        throw error
      }
    }
    return outcomes
  }

  /**
   * Writes a batch of grants.
   *
   * The rules are the ones of the batch of the principals (above): every
   * grant is written on its own, and the answer names the outcome of
   * every one of them.
   */
  async upsertGrants(
    scope: AdminScope,
    registrations: GrantRegistration[],
    context: AuditContext
  ): Promise<GrantOutcome[]> {
    const outcomes: GrantOutcome[] = []
    for (const registration of registrations) {
      try {
        const result = await this.upsertGrant(scope, registration, context)
        outcomes.push({
          tenant: result.grant.tenant,
          id: result.grant.id,
          created: result.audit.action === 'grant.created',
        })
      } catch (error) {
        if (error instanceof AdministrationError) {
          outcomes.push({
            tenant: registration.tenant,
            id: null,
            created: false,
            error: error.code,
            message: error.message,
          })
          continue
        }
        throw error
      }
    }
    return outcomes
  }

  /**
   * Creates a group, or updates the group of that key.
   *
   * The membership is **replaced**: the principals of the list are the
   * members of the group, and the principals that are not in the list are
   * not in the group any more. The members are the external identities of
   * the principals: a member that is not a principal of the tenant is a
   * `404 not_found`.
   *
   * The row of the audit is written by the statement that writes the
   * group (spec §10.1).
   */
  async upsertGroup(
    scope: AdminScope,
    registration: GroupRegistration,
    context: AuditContext
  ): Promise<{ group: Group; created: boolean; audit: AuditEntry }> {
    this.refuseOutsideScope(scope, registration.tenant)
    const tenant = await this.options.tenants.findBySlug(registration.tenant)
    if (!tenant) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }
    const groups = this.options.groups
    if (!groups) {
      throw new AdministrationError('forbidden', 'the groups are not enabled in this deployment')
    }

    // Every member is a principal of the tenant: the group cannot name a
    // principal that does not exist.
    const members: string[] = []
    for (const subject of registration.members) {
      const principal = await this.options.principals.findByExternalSubject(tenant.id, subject)
      if (!principal) {
        throw new AdministrationError(
          'not_found',
          `the principal "${subject}" does not exist in the tenant`
        )
      }
      members.push(principal.id)
    }

    const existing = await groups.findByKey(tenant.id, registration.key)
    if (!existing) {
      const group = await groups.create(
        {
          tenantId: tenant.id,
          key: registration.key,
          displayName: registration.displayName ?? null,
          memberIds: members,
        },
        this.change('group.created', tenant.slug, context)
      )
      return {
        group,
        created: true,
        audit: { action: 'group.created', id: group.id, tenant: tenant.slug },
      }
    }

    const group = await groups.update(
      existing.id,
      {
        displayName: registration.displayName,
        memberIds: members,
      },
      this.change('group.updated', tenant.slug, context)
    )
    if (!group) {
      throw new AdministrationError('not_found', 'the group does not exist')
    }
    return {
      group,
      created: false,
      audit: { action: 'group.updated', id: group.id, tenant: tenant.slug },
    }
  }

  /**
   * Creates a grant, or updates the grant of that
   * `(tenant, subject, permission, workspace, route)` tuple.
   *
   * The permission is created on demand in the scope of the tenant. A
   * permission of the catalogue of the platform is reused, and a
   * permission of another tenant is refused.
   *
   * The row of the audit is written by the statement that writes the
   * grant (spec §10.1).
   */
  async upsertGrant(
    scope: AdminScope,
    registration: GrantRegistration,
    context: AuditContext
  ): Promise<{ grant: Grant; audit: AuditEntry }> {
    this.refuseOutsideScope(scope, registration.tenant)
    const tenant = await this.options.tenants.findBySlug(registration.tenant)
    if (!tenant) {
      throw new AdministrationError('not_found', 'the tenant does not exist')
    }

    // A grant names exactly one subject: a principal or a group.
    const userId = registration.userId ?? null
    const groupKey = registration.group ?? null
    if ((userId === null) === (groupKey === null)) {
      throw new AdministrationError(
        'invalid_request',
        'the grant names a principal or a group, and not both'
      )
    }

    let subjectId: string
    if (userId !== null) {
      const principal = await this.options.principals.findById(userId)
      if (!principal) {
        throw new AdministrationError('not_found', 'the principal does not exist')
      }
      if (principal.tenant !== tenant.slug) {
        throw new AdministrationError('forbidden', 'the principal belongs to another tenant')
      }
      subjectId = principal.id
    } else {
      const groups = this.options.groups
      if (!groups) {
        throw new AdministrationError('forbidden', 'the groups are not enabled in this deployment')
      }
      const group = await groups.findByKey(tenant.id, groupKey!)
      if (!group) {
        throw new AdministrationError('not_found', 'the group does not exist')
      }
      subjectId = group.id
    }

    const permission = await this.resolvePermission(tenant.id, registration.permission)

    const workspaceId = registration.workspaceId ?? null
    const routeId = registration.routeId ?? null
    const existing = await this.options.grants.findLive(
      tenant.id,
      { userId: userId, groupId: userId === null ? subjectId : null },
      permission.id,
      workspaceId,
      routeId
    )
    if (!existing) {
      const grant = await this.options.grants.create(
        {
          tenantId: tenant.id,
          userId: userId,
          groupId: userId === null ? subjectId : null,
          permissionId: permission.id,
          workspaceId,
          routeId,
          expiresAt: registration.expiresAt ?? null,
          grantedBy: registration.grantedBy ?? null,
        },
        this.change('grant.created', tenant.slug, context)
      )
      return {
        grant,
        audit: { action: 'grant.created', id: grant.id, tenant: tenant.slug },
      }
    }

    const grant = await this.options.grants.update(
      existing.id,
      {
        expiresAt: registration.expiresAt,
        grantedBy: registration.grantedBy,
      },
      this.change('grant.updated', tenant.slug, context)
    )
    if (!grant) {
      throw new AdministrationError('not_found', 'the grant does not exist')
    }
    return {
      grant,
      audit: { action: 'grant.updated', id: grant.id, tenant: tenant.slug },
    }
  }

  /**
   * Revokes a grant.
   *
   * The call is idempotent: a grant that is already revoked answers the
   * same way. A grant that does not exist is a `404`.
   */
  async revokeGrant(scope: AdminScope, id: string, context: AuditContext): Promise<AuditEntry> {
    const existing = await this.options.grants.findById(id)
    if (!existing) {
      throw new AdministrationError('not_found', 'the grant does not exist')
    }
    // A credential of a tenant revokes the grants of that tenant and
    // nothing else.
    this.refuseOutsideScope(scope, existing.tenant)
    await this.options.grants.revoke(id, this.change('grant.revoked', existing.tenant, context))
    return { action: 'grant.revoked', id, tenant: existing.tenant }
  }

  /**
   * The audit of a change, with the facts of the call.
   *
   * The domain knows what happened and to whom; the application knows who
   * made the call, from which address and in which request. The two
   * together are the row of the audit.
   */
  private change(action: string, tenant: string | null, context: AuditContext): ChangeAudit {
    return {
      action,
      tenant,
      operator: context.operator,
      address: context.address,
      requestId: context.requestId,
    }
  }

  /**
   * The rows of the audit that match a filter, and their number.
   *
   * The filter is the tenant, the action and the page. A tenant that
   * does not exist is a `404 not_found`, like everywhere else.
   */
  async listAudit(
    scope: AdminScope,
    query: {
      tenant?: string | null
      action?: string | null
      limit?: string | null
      offset?: string | null
      format?: string | null
    }
  ): Promise<AuditPage> {
    const format = auditFormat(query.format ?? null)
    // An export leaves the platform: it carries the rows in a file, and
    // the file is bigger than a page of the list.
    const maximum = format === 'json' ? MAX_PAGE_SIZE : MAX_EXPORT_ROWS
    const limit = wholeNumber(
      query.limit ?? undefined,
      format === 'json' ? DEFAULT_PAGE_SIZE : MAX_EXPORT_ROWS,
      1,
      maximum,
      'limit'
    )
    const offset = wholeNumber(query.offset ?? undefined, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')

    let tenant: string | null = null
    // The audit of a credential that is scoped to a tenant is the audit
    // of that tenant: the filter of the query cannot widen it.
    const slug = scope.tenant ?? query.tenant?.trim()
    if (slug) {
      const found = await this.options.tenants.findBySlug(slug)
      if (!found) {
        throw new AdministrationError('not_found', 'the tenant does not exist')
      }
      tenant = found.slug
    }

    const action = query.action?.trim() || null
    const page = await this.options.audit?.list({ tenant, action, limit, offset })
    return {
      records: page?.records ?? [],
      total: page?.total ?? 0,
      limit,
      offset,
      format,
    }
  }

  /**
   * The permission of a grant.
   *
   * A key is a name **inside** a tenant: the catalogue of the platform
   * is shared and is reused, the permission of the tenant is reused, and
   * the permission that does not exist is created in the scope of the
   * tenant. Two tenants may hold a permission of the same key: the
   * unique index is on `(tenant, key)`, and a key that another tenant
   * owns never becomes a permission of this one — the tenant creates
   * its own row, and the grant names that row.
   */ private async resolvePermission(tenantId: string, key: string): Promise<Permission> {
    const catalogue = await this.options.permissions.findCataloguePermission(key)
    if (catalogue) return catalogue

    const own = await this.options.permissions.findByTenantAndKey(tenantId, key)
    if (own) return own

    return await this.options.permissions.createOrFind({ tenantId, key })
  }
}
