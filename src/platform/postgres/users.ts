/**
 * The principals of Hub (spec §3.2).
 *
 * The repository is the storage of the rows: it holds no policy. The
 * mapping of an identity is the work of the identity domain, and it uses
 * the key `(tenant, subject)` and never the e-mail.
 */

import type { SqlClient } from './database'

/** The status of a principal. */
export type PrincipalStatus = 'active' | 'disabled'

/** The row of a principal. */
export interface UserRow {
  id: string
  tenantId: string
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
  external_subject: string
  email: string | null
  display_name: string | null
  status: PrincipalStatus
  last_login_at: Date | null
  created_at: Date
  updated_at: Date
}

/** The columns of a principal. */
const COLUMNS = `id, tenant_id, external_subject, email, display_name, status, last_login_at,
  created_at, updated_at`

/** Turns the row of the database into the row of the domain. */
function toRow(record: UserRecord): UserRow {
  return {
    id: record.id,
    tenantId: record.tenant_id,
    externalSubject: record.external_subject,
    email: record.email,
    displayName: record.display_name,
    status: record.status,
    lastLoginAt: record.last_login_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  }
}

/** The storage of the principals. */
export class UserRepository {
  constructor(private readonly db: SqlClient) {}

  /** The principal of an id: the id is the subject of every token. */
  async findById(id: string): Promise<UserRow | null> {
    const rows = await this.db.query<UserRecord>(`select ${COLUMNS} from users where id = $1`, [id])
    return rows[0] ? toRow(rows[0]) : null
  }

  /**
   * The principal of an external identity.
   *
   * The key is the pair `(tenant, subject)`: an e-mail is mutable and is
   * not an identity (spec §6.2).
   */
  async findByExternalSubject(tenantId: string, externalSubject: string): Promise<UserRow | null> {
    const rows = await this.db.query<UserRecord>(
      `select ${COLUMNS} from users where tenant_id = $1 and external_subject = $2`,
      [tenantId, externalSubject]
    )
    return rows[0] ? toRow(rows[0]) : null
  }

  /** The principals of a tenant. */
  async findByTenant(tenantId: string): Promise<UserRow[]> {
    const rows = await this.db.query<UserRecord>(
      `select ${COLUMNS} from users where tenant_id = $1 order by created_at`,
      [tenantId]
    )
    return rows.map(toRow)
  }

  /** Creates a principal. */
  async create(input: NewUser): Promise<UserRow> {
    const rows = await this.db.query<UserRecord>(
      `insert into users (tenant_id, external_subject, email, display_name, status)
       values ($1, $2, $3, $4, $5)
       returning ${COLUMNS}`,
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
      `update users set ${assignments.join(', ')} where id = $${params.length} returning ${COLUMNS}`,
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
