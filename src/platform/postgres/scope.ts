/**
 * The scope of a tenant (spec §3.7).
 *
 * The isolation of the tenants is enforced by the application: the keys
 * of the five tables carry the tenant and every statement that reads a
 * tenant reads it by its id. The scope of this module is the **backstop**
 * of the database: a statement that runs in the scope of a tenant sees
 * the rows of that tenant and nothing else, even when it forgets the
 * condition in its text.
 *
 * The scope is the setting `hub.tenant_id`. It is set with
 * `set_config(..., true)`, which is local to the transaction: a pooled
 * connection never carries the scope of another request.
 */

import type { SqlClient } from './database'

/** The setting that carries the scope of a statement. */
export const TENANT_SCOPE_SETTING = 'hub.tenant_id'

/**
 * Runs a statement in the scope of a tenant.
 *
 * A scope that is null runs the statement without one: the statement sees
 * the whole platform, and that is what the administration and the
 * decision of the bearer token of the deployment need.
 */
export async function withTenantScope<T>(
  db: SqlClient,
  tenantId: string | null,
  action: (client: SqlClient) => Promise<T>
): Promise<T> {
  if (tenantId === null) {
    return await action(db)
  }
  return await db.transaction(async (client) => {
    await client.query(`select set_config($1, $2, true)`, [TENANT_SCOPE_SETTING, tenantId])
    return await action(client)
  })
}

/**
 * The role of the connection and what it does with the isolation.
 *
 * A superuser and a role with `BYPASSRLS` are not subject to the
 * policies of the tables: for them the isolation of the tenants is a
 * promise and not a rule. A production deployment refuses to start with
 * such a role (spec §3.8).
 */
export interface DatabaseRole {
  /** The name of the role of the connection. */
  name: string
  /** True when the role is a superuser. */
  superuser: boolean
  /** True when the role bypasses the row level security. */
  bypassesRowLevelSecurity: boolean
}

/** Reads the role of the connection. */
export async function roleOf(db: SqlClient): Promise<DatabaseRole> {
  const rows = await db.query<{ name: string; superuser: boolean; bypasses: boolean }>(
    `select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypasses
     from pg_roles r where r.rolname = current_user`
  )
  const row = rows[0]
  return {
    name: row?.name ?? 'unknown',
    superuser: row?.superuser ?? true,
    bypassesRowLevelSecurity: row?.bypasses ?? true,
  }
}

/**
 * Tells whether the role of the connection bypasses the isolation.
 *
 * A superuser and a role with `BYPASSRLS` are not subject to the
 * policies of the tables: for them the isolation of the tenants is a
 * promise and not a rule. A production deployment refuses to start with
 * such a role (spec §3.8).
 */
export async function bypassesRowLevelSecurity(db: SqlClient): Promise<boolean> {
  const role = await roleOf(db)
  return role.superuser || role.bypassesRowLevelSecurity
}
