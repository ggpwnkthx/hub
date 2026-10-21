/**
 * The principals of Hub (spec §3.2).
 *
 * The repository is the storage of the rows: it holds no policy. The
 * mapping of an identity is the work of the identity domain, and it uses
 * the key `(tenant, subject)` and never the e-mail.
 */

import { withTenantScope } from './scope'
import type { SqlClient } from './database'

/** The status of a principal. */
export type PrincipalStatus = 'active' | 'disabled'

/** The row of a principal. */
export interface UserRow {
  id: string
  tenantId: string
  /** The slug of the tenant of the principal. */
  tenantSlug: string
  /** The `sub` of the provider of the tenant. */
  externalSubject: string
  /** The last e-mail seen at the provider: a display value, never a key. */
  email: string | null
  displayName: string | null
  status: PrincipalStatus
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** The fields of the creation of a principal. */
export interface NewUser {
  tenantId: string
  externalSubject: string
  email?: string | null
  displayName?: string | null
  status?: PrincipalStatus
}

/** The fields of the change of a principal. Every field is optional. */
export interface UserUpdate {
  email?: string | null
  displayName?: string | null
  status?: PrincipalStatus
}

/** The row of a principal, as the database holds it. */
interface UserRecord {
  id: string
  tenant_id: string
  tenant_slug: string
  external_subject: string
  email: string | null
  display_name: string | null
  status: PrincipalStatus
  last_login_at: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * The columns of a principal.
 *
 * The slug of the tenant comes with them: the answer of the
 * administration names the tenant and not its id.
 */
const COLUMNS = `users.id, users.tenant_id, users.external_subject, users.email,
  users.display_name, users.status, users.last_login_at, users.created_at, users.updated_at,
  tenants.slug as tenant_slug`

/** Turns the row of the database into the row of the domain. */
function toRow(record: UserRecord): UserRow {
  return {
    id: record.id,
    tenantId: record.tenant_id,
    tenantSlug: record.tenant_slug,
    externalSubject: record.external_subject,
    email: record.email,
    displayName: record.display_name,
    status: record.status,
    lastLoginAt: record.last_login_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

/** The filter of the list of the principals. */
export interface UserListFilter {
  /** The id of the tenant, or null for every tenant. */
  tenantId: string | null
  /** The status of the principals, or null for every status. */
  status: PrincipalStatus | null
  /** The exact e-mail of the principals, or null for every one. */
  email: string | null
  /** The size of the page. */
  limit: number
  /** The number of rows that are skipped. */
  offset: number
}

/**
 * The conditions of a list of principals.
 *
 * Every value of a caller is a parameter: the statement is never built
 * with text (spec §9.1).
 */
function listConditions(filter: UserListFilter): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter.tenantId !== null) {
    params.push(filter.tenantId)
    conditions.push(`users.tenant_id = $${params.length}`)
  }
  if (filter.status !== null) {
    params.push(filter.status)
    conditions.push(`users.status = $${params.length}`)
  }
  if (filter.email !== null) {
    params.push(filter.email)
    conditions.push(`users.email = $${params.length}`)
  }
  return { where: conditions.length > 0 ? `where ${conditions.join(' and ')}` : '', params }
}

/** The storage of the principals. */
export class UserRepository {
  constructor(private readonly db: SqlClient) {}

  /** The principal of an id: the id is the subject of every token. */
  async findById(id: string): Promise<UserRow | null> {
    const rows = await this.db.query<UserRecord>(
      `select ${COLUMNS} from users join tenants on tenants.id = users.tenant_id where users.id = $1`,
      [id]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /**
   * The principal of an external identity.
   *
   * The key is the pair `(tenant, subject)`: an e-mail is mutable and is
   * not an identity (spec §6.2).
   */
  async findByExternalSubject(tenantId: string, externalSubject: string): Promise<UserRow | null> {
    const rows = await withTenantScope(
      this.db,
      tenantId,
      async (client) =>
        await client.query<UserRecord>(
          `select ${COLUMNS} from users join tenants on tenants.id = users.tenant_id
       where users.tenant_id = $1 and users.external_subject = $2`,
          [tenantId, externalSubject]
        )
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The principals of a tenant. */
  async findByTenant(tenantId: string): Promise<UserRow[]> {
    const rows = await withTenantScope(
      this.db,
      tenantId,
      async (client) =>
        await client.query<UserRecord>(
          `select ${COLUMNS} from users join tenants on tenants.id = users.tenant_id
       where users.tenant_id = $1 order by users.created_at`,
          [tenantId]
        )
    )
    return rows.map(toRow)
  }

  /**
   * The principals that match a filter, and their number.
   *
   * The order is the newest first and it is stable: two pages never show
   * the same row twice and never skip one (spec §9.5).
   */
  async list(filter: UserListFilter): Promise<{ rows: UserRow[]; total: number }> {
    const { where, params } = listConditions(filter)
    const page = await withTenantScope(this.db, filter.tenantId, async (client) => {
      const counted = await client.query<{ count: number }>(
        `select count(*)::int as count from users ${where}`,
        params
      )
      const rows = await client.query<UserRecord>(
        `select ${COLUMNS} from users join tenants on tenants.id = users.tenant_id
       ${where}
       order by users.created_at desc, users.id desc
       limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, filter.limit, filter.offset]
      )
      return { rows, total: counted[0]?.count ?? 0 }
    })
    return { rows: page.rows.map(toRow), total: page.total }
  }

  /**
   * The external subjects of a list of principals.
   *
   * The membership of a group is stored as the ids of the principals and
   * it is published as the external identities: the translation is the
   * work of the adapter.
   */
  async findExternalSubjectsByIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const rows = await this.db.query<{ external_subject: string }>(
      `select external_subject from users where id = any($1::uuid[])`,
      [ids]
    )
    return rows.map((row) => row.external_subject)
  }

  /** Creates a principal. */
  async create(input: NewUser): Promise<UserRow> {
    const rows = await this.db.query<UserRecord>(
      `with inserted as (
         insert into users (tenant_id, external_subject, email, display_name, status)
         values ($1, $2, $3, $4, $5)
         returning id, tenant_id, external_subject, email, display_name, status, last_login_at,
           created_at, updated_at
       )
       select inserted.*, tenants.slug as tenant_slug
       from inserted join tenants on tenants.id = inserted.tenant_id`,
      [
        input.tenantId,
        input.externalSubject,
        input.email ?? null,
        input.displayName ?? null,
        input.status ?? 'active',
      ]
    )
    return toRow(rows[0]!)
  }

  /** Changes a principal. */
  async update(id: string, input: UserUpdate): Promise<UserRow | null> {
    const assignments: string[] = []
    const params: unknown[] = []
    const set = (column: string, value: unknown): void => {
      params.push(value)
      assignments.push(`${column} = $${params.length}`)
    }
    if (input.email !== undefined) set('email', input.email)
    if (input.displayName !== undefined) set('display_name', input.displayName)
    if (input.status !== undefined) set('status', input.status)
    if (assignments.length === 0) return await this.findById(id)
    set('updated_at', new Date())
    params.push(id)
    const rows = await this.db.query<UserRecord>(
      `with updated as (
         update users set ${assignments.join(', ')} where id = $${params.length}
         returning id, tenant_id, external_subject, email, display_name, status, last_login_at,
           created_at, updated_at
       )
       select updated.*, tenants.slug as tenant_slug
       from updated join tenants on tenants.id = updated.tenant_id`,
      params
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** Stamps the last successful login of a principal. */
  async touchLogin(id: string): Promise<void> {
    await this.db.query(
      `update users set last_login_at = now(), updated_at = now() where id = $1`,
      [id]
    )
  }
}
