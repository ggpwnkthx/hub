/**
 * The groups of the principals (spec §3.5).
 *
 * A group is a set of principals of a tenant. The membership is a list
 * of the principals of the group: it is written in one statement by the
 * administration, and it is read by the decision of a principal.
 */

import { withTenantScope } from './scope'
import { auditedCte } from './audited'
import type { SqlClient } from './database'
import type { ChangeAudit } from '../../domains/administration'

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

/** The filter of the list of the groups. */
export interface GroupListFilter {
  /** The id of the tenant, or null for every tenant. */
  tenantId: string | null
  /** The key of the group, or null for every key. */
  key: string | null
  /** The size of the page. */
  limit: number
  /** The number of rows that are skipped. */
  offset: number
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

  /**
   * The groups that match a filter, and their number.
   *
   * The order is the newest first (`created_at desc, id desc`), and it is
   * stable: two pages never show the same row twice and never skip one
   * (spec §9.5).
   */
  async list(filter: GroupListFilter): Promise<{ rows: GroupRow[]; total: number }> {
    const conditions: string[] = []
    const params: unknown[] = []
    if (filter.tenantId !== null) {
      params.push(filter.tenantId)
      conditions.push(`groups.tenant_id = $${params.length}`)
    }
    if (filter.key !== null) {
      params.push(filter.key)
      conditions.push(`groups.key = $${params.length}`)
    }
    const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''
    const page = await withTenantScope(this.db, filter.tenantId, async (client) => {
      const counted = await client.query<{ count: number }>(
        `select count(*)::int as count from groups ${where}`,
        params
      )
      const rows = await client.query<GroupRecord>(
        `select ${COLUMNS} from groups join tenants on tenants.id = groups.tenant_id
         ${where}
         order by groups.created_at desc, groups.id desc
         limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, filter.limit, filter.offset]
      )
      return { rows, total: counted[0]?.count ?? 0 }
    })
    return { rows: page.rows.map(toRow), total: page.total }
  }

  /**
   * Creates a group.
   *
   * The row of the audit of the creation is written by the same statement
   * as the group: a group that is not audited does not exist (spec §9.1).
   */
  async create(input: NewGroup, audit?: ChangeAudit | null): Promise<GroupRow> {
    const params: unknown[] = [input.tenantId, input.key, input.displayName ?? null, input.members]
    const audited = auditedCte('inserted', params, audit)
    const rows = await this.db.query<GroupRecord>(
      `with inserted as (
         insert into groups (tenant_id, key, display_name, members)
         values ($1, $2, $3, $4)
         returning id, tenant_id, key, display_name, members, created_at, updated_at
       )${audited}
       select inserted.*, tenants.slug as tenant_slug
       from inserted join tenants on tenants.id = inserted.tenant_id`,
      params
    )
    return toRow(rows[0]!)
  }

  /**
   * Changes a group.
   *
   * The membership is replaced: the members of the list are the members
   * of the group, and the principals that are not in the list are not in
   * the group any more.
   *
   * The row of the audit of the change is written by the same statement
   * as the group (spec §9.1).
   */
  async update(
    id: string,
    input: { displayName?: string | null; members?: string[] },
    audit?: ChangeAudit | null
  ): Promise<GroupRow | null> {
    const assignments: string[] = []
    const params: unknown[] = []
    const set = (column: string, value: unknown): void => {
      params.push(value)
      assignments.push(`${column} = $${params.length}`)
    }
    if (input.displayName !== undefined) set('display_name', input.displayName)
    if (input.members !== undefined) set('members', input.members)
    if (assignments.length === 0) {
      // The call changed nothing, but it is still a call of the
      // administration: the row is rewritten with the values it has, so
      // that the row of the audit is written by the same statement as
      // the row it names.
      assignments.push('id = id')
    } else {
      set('updated_at', new Date())
    }
    params.push(id)
    // The number of the id is read before the audit is appended: the
    // parameters of the audit are always the last five.
    const idParam = params.length
    const audited = auditedCte('updated', params, audit)
    const rows = await this.db.query<GroupRecord>(
      `with updated as (
         update groups set ${assignments.join(', ')} where id = $${idParam}
         returning id, tenant_id, key, display_name, members, created_at, updated_at
       )${audited}
       select updated.*, tenants.slug as tenant_slug
       from updated join tenants on tenants.id = updated.tenant_id`,
      params
    )
    return rows[0] ? toRow(rows[0]) : null
  }
}
