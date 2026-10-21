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

/**
 * The storage of the audit.
 *
 * The repository **reads** the audit: the rows are written by the
 * statements that make the changes, so that a change and its row of the
 * audit are committed together (spec §9.1, `audited.ts`).
 */
export class AuditRepository {
  constructor(private readonly db: SqlClient) {}

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
