/**
 * The credentials of the administration (spec §10.1).
 *
 * The administration is guarded by bearer tokens. A token of the platform
 * is the credential of the operator of the platform, and a token of a
 * tenant is the credential of the operator of that tenant: the calls it
 * makes are the calls of that tenant and nothing else.
 *
 * A credential of a tenant carries the **name** of its operator: the
 * audit of a change names the operator, and a name is what an operator
 * of a platform can answer for. The credential itself is never written
 * anywhere.
 */

/** A credential of the administration. */
export interface AdminCredential {
  /** The bearer token of the credential. */
  token: string
  /**
   * The slug of the tenant the credential may act for, or null when it
   * may act for every tenant.
   */
  tenant: string | null
  /**
   * The name of the operator of the credential, or null when the
   * credential carries none.
   */
  operator: string | null
}

/**
 * The scope of a call of the administration.
 *
 * The scope is what the credential of the call allows: the tenant it may
 * act for, and the operator it is.
 */
export interface AdminScope {
  /**
   * The slug of the tenant the call may act for, or null when the call
   * may act for every tenant.
   */
  tenant: string | null
  /**
   * The name of the operator of the call, or null when the credential
   * carries none.
   */
  operator: string | null
}

/** The scope of the platform: every tenant, no named operator. */
export const PLATFORM_SCOPE: AdminScope = { tenant: null, operator: null }
