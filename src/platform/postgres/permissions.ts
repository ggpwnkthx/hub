/**
 * The permissions of Hub (spec §3.3).
 *
 * A permission is a role of the platform: it travels in the `roles` claim
 * and it is what a grant gives. A permission of the catalogue belongs to
 * every tenant; a permission of a tenant belongs to that tenant only.
 */

import type { SqlClient } from './database'

/** The row of a permission. */
export interface PermissionRow {
  id: string
  /** The tenant that owns the permission, or null for the catalogue. */
  tenantId: string | null
  key: string
  description: string | null
  enabled: boolean
}

/** The fields of the creation of a permission. */
export interface NewPermission {
  /** The tenant that owns the permission, or null for the catalogue. */
  tenantId?: string | null
  key: string
  description?: string | null
}

/** The row of a permission, as the database holds it. */
interface PermissionRecord {
  id: string
  tenant_id: string | null
  key: string
  description: string | null
  enabled: boolean
}

/** The columns of a permission. */
const COLUMNS = 'id, tenant_id, key, description, enabled'

/** Turns the row of the database into the row of the domain. */
function toRow(record: PermissionRecord): PermissionRow {
  return {
    id: record.id,
    tenantId: record.tenant_id,
    key: record.key,
    description: record.description,
    enabled: record.enabled,
  }
}

/** The storage of the permissions. */
export class PermissionRepository {
  constructor(private readonly db: SqlClient) {}

  /** The permission of an id. */
  async findById(id: string): Promise<PermissionRow | null> {
    const rows = await this.db.query<PermissionRecord>(
      `select ${COLUMNS} from permissions where id = $1`,
      [id]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The permission of the catalogue of the platform. */
  async findCataloguePermission(key: string): Promise<PermissionRow | null> {
    const rows = await this.db.query<PermissionRecord>(
      `select ${COLUMNS} from permissions where tenant_id is null and key = $1`,
      [key]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The permission of a tenant. */
  async findByTenantAndKey(tenantId: string, key: string): Promise<PermissionRow | null> {
    const rows = await this.db.query<PermissionRecord>(
      `select ${COLUMNS} from permissions where tenant_id = $1 and key = $2`,
      [tenantId, key]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The permission of a key, whatever the tenant that owns it. */
  async findByKey(key: string): Promise<PermissionRow | null> {
    const rows = await this.db.query<PermissionRecord>(
      `select ${COLUMNS} from permissions where key = $1 order by tenant_id nulls first limit 1`,
      [key]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The permissions of a tenant, and the ones of the catalogue. */
  async findByTenant(tenantId: string): Promise<PermissionRow[]> {
    const rows = await this.db.query<PermissionRecord>(
      `select ${COLUMNS} from permissions where tenant_id = $1 or tenant_id is null order by key`,
      [tenantId]
    )
    return rows.map(toRow)
  }

  /** Creates a permission. */
  async create(input: NewPermission): Promise<PermissionRow> {
    const rows = await this.db.query<PermissionRecord>(
      `insert into permissions (tenant_id, key, description) values ($1, $2, $3) returning ${COLUMNS}`,
      [input.tenantId ?? null, input.key, input.description ?? null]
    )
    return toRow(rows[0]!)
  }

  /** Enables or disables a permission: a disabled permission is never given. */
  async setEnabled(id: string, enabled: boolean): Promise<PermissionRow | null> {
    const rows = await this.db.query<PermissionRecord>(
      `update permissions set enabled = $1 where id = $2 returning ${COLUMNS}`,
      [enabled, id]
    )
    return rows[0] ? toRow(rows[0]) : null
  }
}
