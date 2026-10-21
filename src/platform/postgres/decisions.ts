/**
 * The reading of the decision (spec §8.3).
 *
 * The decision is one statement over the tables of the policy: the
 * principal, the tenant, the grants and the permissions. It is not
 * cached: the table is the truth and the query is cheap.
 *
 * The statement returns the facts of the rule; the domain turns them into
 * the answer of the protocol.
 */

import type { DecisionFacts, DecisionRequest, DecisionStore } from '../../domains/authorization'
import type { SqlClient } from './database'

/** The failure of a statement that took too long. */
export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the statement did not answer in ${timeoutMs} ms`)
    this.name = 'TimeoutError'
  }
}

/**
 * Runs a statement with a deadline.
 *
 * A statement that does not answer in time is a failure: the decision
 * becomes a denial and the gateway fails closed.
 */
export async function withTimeout<T>(action: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs)
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
    select g.id, g.expires_at
    from grants g
    join permissions p on p.id = g.permission_id
    where g.user_id = u.id
      and g.revoked_at is null
      and p.enabled
      and (g.workspace_id is null or g.workspace_id = $2)
      and (g.route_id is null or g.route_id = $3)
    order by (g.expires_at is null or g.expires_at > now()) desc
    limit 1
  ) g on true
  where u.id = $1`

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
      this.db.query<DecisionRecord>(DECISION_SQL, [
        request.subject,
        request.workspaceId,
        request.routeId,
      ]),
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
