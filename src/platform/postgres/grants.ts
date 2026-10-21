/**
 * The grants of Hub (spec §3.4).
 *
 * A grant says: this principal holds this permission, on this workspace,
 * on this route, until this date. A revoked grant is kept: the history of
 * the policy is worth more than the bytes.
 */

import type { SqlClient } from './database'

/** The row of a grant. */
export interface GrantRow {
  id: string
  tenantId: string
  /** The slug of the tenant of the grant. */
  tenantSlug: string
  userId: string
  permissionId: string
  /** The key of the permission of the grant. */
  permissionKey: string
  /** The workspace of the grant, or null for every workspace of the tenant. */
  workspaceId: string | null
  /** The route of the grant, or null for every route. */
  routeId: string | null
  expiresAt: Date | null
  /** Null while the grant is alive. */
  revokedAt: Date | null
  grantedBy: string | null
  createdAt: Date
}

/** The fields of the creation of a grant. */
export interface NewGrant {
  tenantId: string
  userId: string
  permissionId: string
  workspaceId?: string | null
  routeId?: string | null
  expiresAt?: Date | null
  grantedBy?: string | null
}

/** The row of a grant, as the database holds it. */
interface GrantRecord {
  id: string
  tenant_id: string
  tenant_slug: string
  user_id: string
  permission_id: string
  permission_key: string
  workspace_id: string | null
  route_id: string | null
  expires_at: Date | null
  revoked_at: Date | null
  granted_by: string | null
  created_at: Date
}

/**
 * The columns of a grant.
 *
 * The slug of the tenant comes with them: the answer of the
 * administration names the tenant and not its id.
 */
const COLUMNS = `grants.id, grants.tenant_id, grants.user_id, grants.permission_id,
  grants.workspace_id, grants.route_id, grants.expires_at, grants.revoked_at, grants.granted_by,
  grants.created_at, tenants.slug as tenant_slug, permissions.key as permission_key`

/** Turns the row of the database into the row of the domain. */
function toRow(record: GrantRecord): GrantRow {
  return {
    id: record.id,
    tenantId: record.tenant_id,
    tenantSlug: record.tenant_slug,
    userId: record.user_id,
    permissionId: record.permission_id,
    permissionKey: record.permission_key,
    workspaceId: record.workspace_id,
    routeId: record.route_id,
    expiresAt: record.expires_at,
    revokedAt: record.revoked_at,
    grantedBy: record.granted_by,
    createdAt: record.created_at,
  }
}

/** The storage of the grants. */
export class GrantRepository {
  constructor(private readonly db: SqlClient) {}

  /** The grant of an id. */
  async findById(id: string): Promise<GrantRow | null> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants join tenants on tenants.id = grants.tenant_id
       join permissions on permissions.id = grants.permission_id
       where grants.id = $1`,
      [id]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /**
   * The live grant of a scope.
   *
   * A revoked grant does not hold the scope: the unique index of the live
   * grants is what makes the second call of the administration an update
   * and not a conflict.
   */
  async findLive(
    tenantId: string,
    userId: string,
    permissionId: string,
    workspaceId: string | null,
    routeId: string | null
  ): Promise<GrantRow | null> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants join tenants on tenants.id = grants.tenant_id
       join permissions on permissions.id = grants.permission_id
       where grants.tenant_id = $1 and grants.user_id = $2 and grants.permission_id = $3
         and coalesce(grants.workspace_id, '') = coalesce($4, '')
         and coalesce(grants.route_id, '') = coalesce($5, '')
         and grants.revoked_at is null`,
      [tenantId, userId, permissionId, workspaceId, routeId]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The live grants of a principal: the roles of the token (spec §7.3). */
  async findLiveByUser(userId: string): Promise<GrantRow[]> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants join tenants on tenants.id = grants.tenant_id
       join permissions on permissions.id = grants.permission_id
       where grants.user_id = $1 and grants.revoked_at is null
         and (grants.expires_at is null or grants.expires_at > now())
       order by grants.created_at`,
      [userId]
    )
    return rows.map(toRow)
  }

  /**
   * The keys of the permissions of the live grants of a principal.
   *
   * They are the roles of the token (spec §7.3): not revoked, not
   * expired, with an enabled permission.
   */
  async findLivePermissionKeys(userId: string): Promise<string[]> {
    const rows = await this.db.query<{ key: string }>(
      `select distinct permissions.key
       from grants join permissions on permissions.id = grants.permission_id
       where grants.user_id = $1
         and grants.revoked_at is null
         and (grants.expires_at is null or grants.expires_at > now())
         and permissions.enabled
       order by permissions.key`,
      [userId]
    )
    return rows.map((row) => row.key)
  }

  /** The grants of a tenant, the revoked ones included. */
  async findByTenant(tenantId: string): Promise<GrantRow[]> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants join tenants on tenants.id = grants.tenant_id
       join permissions on permissions.id = grants.permission_id
       where grants.tenant_id = $1 order by grants.created_at`,
      [tenantId]
    )
    return rows.map(toRow)
  }

  /** The grants of a principal, the revoked ones included. */
  async findByUser(userId: string): Promise<GrantRow[]> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants join tenants on tenants.id = grants.tenant_id
       join permissions on permissions.id = grants.permission_id
       where grants.user_id = $1 order by grants.created_at`,
      [userId]
    )
    return rows.map(toRow)
  }

  /** Creates a grant. */
  async create(input: NewGrant): Promise<GrantRow> {
    const rows = await this.db.query<GrantRecord>(
      `with inserted as (
         insert into grants (tenant_id, user_id, permission_id, workspace_id, route_id, expires_at,
           granted_by)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, tenant_id, user_id, permission_id, workspace_id, route_id, expires_at,
           revoked_at, granted_by, created_at
       )
       select inserted.*, tenants.slug as tenant_slug, permissions.key as permission_key
       from inserted join tenants on tenants.id = inserted.tenant_id
       join permissions on permissions.id = inserted.permission_id`,
      [
        input.tenantId,
        input.userId,
        input.permissionId,
        input.workspaceId ?? null,
        input.routeId ?? null,
        input.expiresAt ?? null,
        input.grantedBy ?? null,
      ]
    )
    return toRow(rows[0]!)
  }

  /** Changes the scope of a grant: its expiry and the one who granted it. */
  async update(
    id: string,
    input: { expiresAt?: Date | null; grantedBy?: string | null }
  ): Promise<GrantRow | null> {
    const assignments: string[] = []
    const params: unknown[] = []
    const set = (column: string, value: unknown): void => {
      params.push(value)
      assignments.push(`${column} = $${params.length}`)
    }
    if (input.expiresAt !== undefined) set('expires_at', input.expiresAt)
    if (input.grantedBy !== undefined) set('granted_by', input.grantedBy)
    if (assignments.length === 0) return await this.findById(id)
    params.push(id)
    const rows = await this.db.query<GrantRecord>(
      `with updated as (
         update grants set ${assignments.join(', ')} where id = $${params.length}
         returning id, tenant_id, user_id, permission_id, workspace_id, route_id, expires_at,
           revoked_at, granted_by, created_at
       )
       select updated.*, tenants.slug as tenant_slug, permissions.key as permission_key
       from updated join tenants on tenants.id = updated.tenant_id
       join permissions on permissions.id = updated.permission_id`,
      params
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /**
   * Revokes a grant.
   *
   * The row is kept and stamped: a revoked grant is not a grant that never
   * existed. The call is idempotent: a grant that is already revoked keeps
   * the moment of its first revocation.
   */
  async revoke(id: string): Promise<GrantRow | null> {
    const rows = await this.db.query<GrantRecord>(
      `with updated as (
         update grants set revoked_at = coalesce(revoked_at, now()) where id = $1
         returning id, tenant_id, user_id, permission_id, workspace_id, route_id, expires_at,
           revoked_at, granted_by, created_at
       )
       select updated.*, tenants.slug as tenant_slug, permissions.key as permission_key
       from updated join tenants on tenants.id = updated.tenant_id
       join permissions on permissions.id = updated.permission_id`,
      [id]
    )
    return rows[0] ? toRow(rows[0]) : null
  }
}
