/**
 * The audit of the administration (spec §9.1).
 *
 * The audit is a table of the infrastructure, like the table of the
 * migrations: it holds no tenant, no principal and no grant, and it is
 * not scoped by the isolation of the tenants, because the administration
 * of the platform is not the administration of a tenant.
 *
 * The row of an audit never carries a secret: it carries the name of the
 * action, the identifier of the thing that changed, the tenant, the
 * fingerprint of the credential of the operator, the address of the call
 * and the identifier of the request.
 */

import type { SqlClient } from './database'

/** A row of the audit. */
export interface AuditRow {
  id: string
  /** The moment of the change. */
  at: Date
  /** What happened: `tenant.created`, `grant.revoked`, and so on. */
  action: string
  /** The identifier of the thing that changed. */
  targetId: string | null
  /** The slug of the tenant, when the change belongs to one. */
  tenant: string | null
  /** The fingerprint of the credential of the operator. */
  operator: string | null
  /** The address of the socket of the call. */
  address: string | null
  /** The identifier of the request. */
  requestId: string | null
}

/** The entry of the audit: what is written. */
export interface AuditEntry {
  action: string
  targetId?: string | null
  tenant?: string | null
  operator?: string | null
  address?: string | null
  requestId?: string | null
}

/** The filter of the list of the audit. */
export interface AuditFilter {
  /** The slug of the tenant, or null for every tenant. */
  tenant: string | null
  /** The action, or null for every action. */
  action: string | null
  /** The size of the page. */
  limit: number
  /** The number of rows that are skipped. */
  offset: number
}

/** A page of the audit and the number of the rows that match the filter. */
export interface AuditPage {
  rows: AuditRow[]
  /** The number of rows that match the filter, the page included. */
  total: number
}

/** The row of the database. */
interface AuditRecord {
  id: string
  at: Date
  action: string
  target_id: string | null
  tenant: string | null
  operator: string | null
  address: string | null
  request_id: string | null
}

const COLUMNS = `id, at, action, target_id, tenant, operator, address, request_id`

/** Turns the row of the database into the row of the domain. */
function toRow(record: AuditRecord): AuditRow {
  return {
    id: record.id,
    at: record.at,
    action: record.action,
    targetId: record.target_id,
    tenant: record.tenant,
    operator: record.operator,
    address: record.address,
    requestId: record.request_id,
  }
}

/** The storage of the audit. */
export class AuditRepository {
  constructor(private readonly db: SqlClient) {}

  /**
   * Writes a row of the audit.
   *
   * The row is written in the request that changed the thing. A write
   * that fails is a failure of the request: the caller repeats the call,
   * and a call of the administration is idempotent.
   */
  async append(entry: AuditEntry): Promise<AuditRow> {
    const rows = await this.db.query<AuditRecord>(
      `insert into admin_audit (action, target_id, tenant, operator, address, request_id)
       values ($1, $2, $3, $4, $5, $6)
       returning ${COLUMNS}`,
      [
        entry.action,
        entry.targetId ?? null,
        entry.tenant ?? null,
        entry.operator ?? null,
        entry.address ?? null,
        entry.requestId ?? null,
      ]
    )
    return toRow(rows[0]!)
  }

  /** The rows of the audit that match a filter, and their number. */
  async list(filter: AuditFilter): Promise<AuditPage> {
    const rows = await this.db.query<AuditRecord & { total: number }>(
      `select ${COLUMNS},
         count(*) over()::int as total
       from admin_audit
       where ($1::text is null or tenant = $1)
         and ($2::text is null or action = $2)
       order by at desc, id desc
       limit $3 offset $4`,
      [filter.tenant, filter.action, filter.limit, filter.offset]
    )
    return {
      rows: rows.map(toRow),
      total: rows[0]?.total ?? 0,
    }
  }
}
