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
  userId: string
  permissionId: string
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
  user_id: string
  permission_id: string
  workspace_id: string | null
  route_id: string | null
  expires_at: Date | null
  revoked_at: Date | null
  granted_by: string | null
  created_at: Date
}

/** The columns of a grant. */
const COLUMNS = `id, tenant_id, user_id, permission_id, workspace_id, route_id, expires_at,
  revoked_at, granted_by, created_at`

/** Turns the row of the database into the row of the domain. */
function toRow(record: GrantRecord): GrantRow {
  return {
    id: record.id,
    tenantId: record.tenant_id,
    userId: record.user_id,
    permissionId: record.permission_id,
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
    const rows = await this.db.query<GrantRecord>(`select ${COLUMNS} from grants where id = $1`, [
      id,
    ])
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
      `select ${COLUMNS} from grants
       where tenant_id = $1 and user_id = $2 and permission_id = $3
         and coalesce(workspace_id, '') = coalesce($4, '')
         and coalesce(route_id, '') = coalesce($5, '')
         and revoked_at is null`,
      [tenantId, userId, permissionId, workspaceId, routeId]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The live grants of a principal: the roles of the token (spec §7.3). */
  async findLiveByUser(userId: string): Promise<GrantRow[]> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants
       where user_id = $1 and revoked_at is null and (expires_at is null or expires_at > now())
       order by created_at`,
      [userId]
    )
    return rows.map(toRow)
  }

  /** The grants of a tenant, the revoked ones included. */
  async findByTenant(tenantId: string): Promise<GrantRow[]> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants where tenant_id = $1 order by created_at`,
      [tenantId]
    )
    return rows.map(toRow)
  }

  /** The grants of a principal, the revoked ones included. */
  async findByUser(userId: string): Promise<GrantRow[]> {
    const rows = await this.db.query<GrantRecord>(
      `select ${COLUMNS} from grants where user_id = $1 order by created_at`,
      [userId]
    )
    return rows.map(toRow)
  }

  /** Creates a grant. */
  async create(input: NewGrant): Promise<GrantRow> {
    const rows = await this.db.query<GrantRecord>(
      `insert into grants (tenant_id, user_id, permission_id, workspace_id, route_id, expires_at,
         granted_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning ${COLUMNS}`,
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
      `update grants set ${assignments.join(', ')} where id = $${params.length} returning ${COLUMNS}`,
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
      `update grants set revoked_at = coalesce(revoked_at, now()) where id = $1 returning ${COLUMNS}`,
      [id]
    )
    return rows[0] ? toRow(rows[0]) : null
  }
}
