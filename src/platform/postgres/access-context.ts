/**
 * The reading of the access context (spec §8bis).
 *
 * The context is one statement over the tables of the policy: the
 * principal, the tenant, the grants of the principal, the grants of the
 * groups of the principal and the permissions of the grants.
 *
 * The statement returns the facts of the rule; the domain turns them into
 * the answer of the protocol.
 */

import type {
  AccessContextFacts,
  AccessContextRequest,
  AccessContextStore,
} from '../../domains/authorization'
import type { SqlClient } from './database'

/** The row of the context, as the database holds it. */
interface AccessContextRecord {
  principal_exists: boolean
  principal_active: boolean
  tenant_enabled: boolean
  permission_keys: string[] | null
  earliest_expiry: Date | null
}

/**
 * The statement of the context.
 *
 * The grants of the principal and the grants of the groups of the
 * principal are read in one statement: a consumer that sees the keys of
 * the grants of the principal and not the keys of the grants of its
 * groups would refuse a permission that the principal holds.
 *
 * The scope of a grant is honoured: a grant of another workspace or of
 * another route does not apply, and a grant of every workspace or of
 * every route applies.
 */
const ACCESS_CONTEXT_SQL = `with principal as (
    select u.id as user_id, u.status as status, t.enabled as tenant_enabled
      from users u
      join tenants t on t.id = u.tenant_id
     where u.id = $1::uuid and u.tenant_id = $2::uuid
   ), live as (
    select p.key as key, g.expires_at as expires_at
      from grants g
      join permissions p on p.id = g.permission_id
     where g.revoked_at is null
       and p.enabled
       and (g.workspace_id is null or g.workspace_id = $3)
       and (g.route_id is null or g.route_id = $4)
       and (
         g.user_id = (select user_id from principal)
         or (
           g.group_id is not null
           and exists (
             select 1 from groups gr
              where gr.id = g.group_id
                and gr.members @> array[(select user_id from principal)]
           )
         )
       )
   )
   select
     exists (select 1 from principal) as principal_exists,
     coalesce((select status = 'active' from principal), false) as principal_active,
     coalesce((select tenant_enabled from principal), false) as tenant_enabled,
     coalesce((select jsonb_agg(distinct key) from live), '[]'::jsonb) as permission_keys,
     (select min(expires_at) from live) as earliest_expiry`

/** The storage of the context. */
export class AccessContextRepository implements AccessContextStore {
  constructor(private readonly db: SqlClient) {}

  /**
   * The facts of a context.
   *
   * A principal that does not exist, a principal of another tenant and a
   * disabled tenant are the same thing for the answer: the caller is
   * told nothing about the cause.
   */
  async context(request: AccessContextRequest): Promise<AccessContextFacts> {
    const rows = await this.db.query<AccessContextRecord>(ACCESS_CONTEXT_SQL, [
      request.subject,
      request.tenantId,
      request.workspaceId,
      request.routeId,
    ])
    const row = rows[0]
    if (!row) {
      return {
        principalExists: false,
        principalActive: false,
        tenantEnabled: false,
        permissionKeys: [],
        earliestExpiry: null,
      }
    }
    return {
      principalExists: row.principal_exists,
      principalActive: row.principal_active,
      tenantEnabled: row.tenant_enabled,
      permissionKeys: Array.isArray(row.permission_keys) ? row.permission_keys : [],
      earliestExpiry: row.earliest_expiry ? new Date(row.earliest_expiry) : null,
    }
  }
}
