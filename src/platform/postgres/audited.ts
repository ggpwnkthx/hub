/**
 * The audit of a change, written by the statement of the change.
 *
 * The row of the audit and the row that changed are written by **one**
 * statement: PostgreSQL runs the data-modifying CTEs of a statement in
 * one transaction, so the change and the audit are committed together or
 * neither is.
 *
 * This is what makes the invariant of the specification true (spec §2.1,
 * invariant 6): a change that is not audited does not exist. A call that
 * failed leaves no change behind, so the caller that repeats it performs
 * the same change and writes the same row of the audit.
 */

import type { ChangeAudit } from '../../domains/administration'

/**
 * The CTE that writes the row of the audit of a change.
 *
 * The target of the audit is the row the change wrote: the identifier is
 * taken from the statement itself, so it is the identifier of the row
 * that exists, never one that a caller named.
 *
 * The five values of the audit are appended to the parameters of the
 * statement, so they are always the last five.
 *
 * The CTE is **not** read by the statement that carries it: PostgreSQL
 * runs the data-modifying CTEs of a statement in full, whether the
 * statement reads their output or not.
 *
 * When there is no audit to write, the CTE is empty and the statement
 * writes the change alone: the callers that are not the administration
 * (the provisioning of a principal by a login) change nothing of the
 * audit.
 */
export function auditedCte(
  /** The name of the CTE of the change: `inserted` or `updated`. */
  changed: string,
  /** The parameters of the statement; the five of the audit are appended. */
  params: unknown[],
  /** The audit of the change, when the change is one of the administration. */
  audit: ChangeAudit | null | undefined
): string {
  if (!audit) return ''
  const action = params.push(audit.action)
  const tenant = params.push(audit.tenant)
  const operator = params.push(audit.operator)
  const address = params.push(audit.address)
  const requestId = params.push(audit.requestId)
  return `,
  audited as (
    insert into admin_audit (action, target_id, tenant, operator, address, request_id)
    select $${action}, ${changed}.id::text, $${tenant}, $${operator}, $${address}, $${requestId}
    from ${changed}
  )`
}
