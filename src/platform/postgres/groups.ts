/**
 * The groups of the principals (spec §3.5).
 *
 * A group is a set of principals of a tenant. The membership is a list
 * of the principals of the group: it is written in one statement by the
 * administration, and it is read by the decision of a principal.
 */

import { withTenantScope } from './scope'
import type { SqlClient } from './database'

/** The row of a group. */
export interface GroupRow {
  id: string
  tenantId: string
  /** The slug of the tenant of the group. */
  tenantSlug: string
  /** The name of the group. */
  key: string
  displayName: string | null
  /** The principals of the group. */
  members: string[]
  createdAt: Date
  updatedAt: Date
}

/** The fields of the creation of a group. */
export interface NewGroup {
  tenantId: string
  key: string
  displayName?: string | null
  /** The principals of the group. */
  members: string[]
}

/** The row of a group, as the database holds it. */
interface GroupRecord {
  id: string
  tenant_id: string
  tenant_slug: string
  key: string
  display_name: string | null
  members: string[]
  created_at: Date
  updated_at: Date
}

const COLUMNS = `groups.id, groups.tenant_id, groups.key, groups.display_name, groups.members,
  groups.created_at, groups.updated_at, tenants.slug as tenant_slug`

/** Turns the row of the database into the row of the domain. */
function toRow(record: GroupRecord): GroupRow {
  return {
    id: record.id,
    tenantId: record.tenant_id,
    tenantSlug: record.tenant_slug,
    key: record.key,
    displayName: record.display_name,
    members: record.members ?? [],
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

/** The storage of the groups. */
export class GroupRepository {
  constructor(private readonly db: SqlClient) {}

  /** The group of a key, in the scope of a tenant. */
  async findByKey(tenantId: string, key: string): Promise<GroupRow | null> {
    const rows = await withTenantScope(
      this.db,
      tenantId,
      async (client) =>
        await client.query<GroupRecord>(
          `select ${COLUMNS} from groups join tenants on tenants.id = groups.tenant_id
         where groups.tenant_id = $1 and groups.key = $2`,
          [tenantId, key]
        )
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The group of an id. */
  async findById(id: string): Promise<GroupRow | null> {
    const rows = await this.db.query<GroupRecord>(
      `select ${COLUMNS} from groups join tenants on tenants.id = groups.tenant_id
       where groups.id = $1`,
      [id]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The groups of a tenant. */
  async findByTenant(tenantId: string): Promise<GroupRow[]> {
    const rows = await withTenantScope(
      this.db,
      tenantId,
      async (client) =>
        await client.query<GroupRecord>(
          `select ${COLUMNS} from groups join tenants on tenants.id = groups.tenant_id
         where groups.tenant_id = $1 order by groups.created_at`,
          [tenantId]
        )
    )
    return rows.map(toRow)
  }

  /** Creates a group. */
  async create(input: NewGroup): Promise<GroupRow> {
    const rows = await this.db.query<GroupRecord>(
      `with inserted as (
         insert into groups (tenant_id, key, display_name, members)
         values ($1, $2, $3, $4)
         returning id, tenant_id, key, display_name, members, created_at, updated_at
       )
       select inserted.*, tenants.slug as tenant_slug
       from inserted join tenants on tenants.id = inserted.tenant_id`,
      [input.tenantId, input.key, input.displayName ?? null, input.members]
    )
    return toRow(rows[0]!)
  }

  /**
   * Changes a group.
   *
   * The membership is replaced: the members of the list are the members
   * of the group, and the principals that are not in the list are not in
   * the group any more.
   */
  async update(
    id: string,
    input: { displayName?: string | null; members?: string[] }
  ): Promise<GroupRow | null> {
    const assignments: string[] = []
    const params: unknown[] = []
    const set = (column: string, value: unknown): void => {
      params.push(value)
      assignments.push(`${column} = $${params.length}`)
    }
    if (input.displayName !== undefined) set('display_name', input.displayName)
    if (input.members !== undefined) set('members', input.members)
    if (assignments.length === 0) return await this.findById(id)
    set('updated_at', new Date())
    params.push(id)
    const rows = await this.db.query<GroupRecord>(
      `with updated as (
         update groups set ${assignments.join(', ')} where id = $${params.length}
         returning id, tenant_id, key, display_name, members, created_at, updated_at
       )
       select updated.*, tenants.slug as tenant_slug
       from updated join tenants on tenants.id = updated.tenant_id`,
      params
    )
    return rows[0] ? toRow(rows[0]) : null
  }
}
