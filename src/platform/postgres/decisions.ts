/**
 * The reading of the decision (spec §8.3).
 *
 * The decision is one statement over the tables of the policy: the
 * principal, the tenant, the grants and the permissions. It is not
 * cached: the table is the truth and the query is cheap.
 *
 * The deadline of the decision is the deadline of the connection of the
 * pool: the server stops the statement that takes too long, and the
 * connection is given back to the pool at once (spec §8.3).
 *
 * The statement returns the facts of the rule; the domain turns them into
 * the answer of the protocol.
 */

import type { DecisionFacts, DecisionRequest, DecisionStore } from '../../domains/authorization'
import { withTenantScope } from './scope'
import type { SqlClient } from './database'

/** The failure of a statement that took too long. */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the statement did not answer in ${timeoutMs} ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * The grace between the deadline of the server and the deadline of the
 * process.
 *
 * The server stops the statement at its own deadline: the process waits a
 * little longer, so the failure it reports is the one of the server (the
 * statement was cancelled) and not a race between the two deadlines.
 */
export const TIMEOUT_GRACE_MS = 250

/**
 * Runs a statement with a deadline.
 *
 * A statement that does not answer in time is a failure: the decision
 * becomes a denial and the gateway fails closed.
 *
 * The deadline of the statement is the one of the server (see
 * `withStatement`): this deadline is the backstop of the process, and it
 * is longer than the one of the server by the grace.
 */
export async function withTimeout<T>(action: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs + TIMEOUT_GRACE_MS)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The row of the decision, as the database holds it. */
interface DecisionRecord {
  principal_exists: boolean
  principal_active: boolean
  tenant_enabled: boolean
  live_grant: boolean
  expired_grant: boolean
  tenant_slug: string | null
}

/**
 * The statement of the decision.
 *
 * The grants of the principal are read with the index of the
 * specification (§8.5), the live ones first: a grant that is alive is the
 * reason of the permission, a grant that has expired is the second
 * reason.
 *
 * The fourth parameter is the tenant the decision is scoped to, or null
 * for every tenant (spec §8.8): a gateway that authenticates itself with
 * the credentials of a tenant does not see the principals of the other
 * tenants.
 */
const DECISION_SQL = `select
    true as principal_exists,
    u.status = 'active' as principal_active,
    t.enabled as tenant_enabled,
    (g.id is not null and (g.expires_at is null or g.expires_at > now())) as live_grant,
    (g.id is not null and g.expires_at is not null and g.expires_at <= now()) as expired_grant,
    t.slug as tenant_slug
  from users u
  join tenants t on t.id = u.tenant_id
  left join lateral (
    select candidate.id, candidate.expires_at
    from (
      (select g.id, g.expires_at
       from grants g
       join permissions p on p.id = g.permission_id
       where g.user_id = u.id
         and g.revoked_at is null
         and p.enabled
         and (g.workspace_id is null or g.workspace_id = $2)
         and (g.route_id is null or g.route_id = $3)
       order by (g.expires_at is null or g.expires_at > now()) desc
       limit 1)
      union all
      (select g.id, g.expires_at
       from grants g
       join permissions p on p.id = g.permission_id
       join groups gr on gr.id = g.group_id
       where gr.members @> array[u.id]
         and g.revoked_at is null
         and p.enabled
         and (g.workspace_id is null or g.workspace_id = $2)
         and (g.route_id is null or g.route_id = $3)
       order by (g.expires_at is null or g.expires_at > now()) desc
       limit 1)
    ) candidate
    -- The two branches are candidates: the live one wins, and the expired
    -- one is the reason of the refusal when there is no live one.
    order by (candidate.expires_at is null or candidate.expires_at > now()) desc
    limit 1
  ) g on true
  where u.id = $1
    and ($4::uuid is null or u.tenant_id = $4)`

/** The storage of the decision. */
export class DecisionRepository implements DecisionStore {
  constructor(
    private readonly db: SqlClient,
    /** How long a decision may take before it is a denial. */
    private readonly timeoutMs: number
  ) {}

  /**
   * The facts of a decision.
   *
   * A subject that resolves to no row is a denial: the principal does not
   * exist.
   */
  async decide(request: DecisionRequest): Promise<DecisionFacts> {
    const rows = await withTimeout(
      withTenantScope(
        this.db,
        request.tenantId ?? null,
        async (client) =>
          await client.query<DecisionRecord>(DECISION_SQL, [
            request.subject,
            request.workspaceId,
            request.routeId,
            request.tenantId ?? null,
          ])
      ),
      this.timeoutMs
    )
    const row = rows[0]
    if (!row) {
      return {
        principalExists: false,
        tenantSlug: null,
        principalActive: false,
        tenantEnabled: false,
        liveGrant: false,
        expiredGrant: false,
      }
    }
    return {
      principalExists: row.principal_exists,
      tenantSlug: row.tenant_slug,
      principalActive: row.principal_active,
      tenantEnabled: row.tenant_enabled,
      liveGrant: row.live_grant,
      expiredGrant: row.expired_grant,
    }
  }
}
