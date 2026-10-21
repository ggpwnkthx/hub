/**
 * The access context of a principal (spec §8bis).
 *
 * The gateway asks Hub whether a principal may use a workspace, and the
 * answer is a boolean. A service that owns data needs more than a
 * boolean: it needs the complete set of the capabilities of the
 * principal, so that it can decide what the principal may read and what
 * it may write.
 *
 * The access context is the contract that answers that question. It is
 * evaluated on every request, it is never cached by Hub, and it carries
 * the moment it stops being valid: a consumer that keeps it longer than
 * that keeps a permission that was already revoked.
 */

/** The version of the contract. */
export const ACCESS_CONTEXT_VERSION = 1

/** The maximum number of the permission keys of an answer. */
export const MAX_PERMISSION_KEYS = 4096

/** The maximum lifetime of an answer, in milliseconds. */
export const MAX_LIFETIME_MS = 5000

/** The maximum size of the body of a request, in bytes. */
export const MAX_REQUEST_BYTES = 64 * 1024

/** The request of a context. */
export interface AccessContextRequest {
  /** The principal, as the gateway signed it. */
  subject: string
  /** The tenant the principal has to belong to. */
  tenantId: string
  /** The workspace of the request. */
  workspaceId: string
  /** The route of the request. */
  routeId: string
}

/** The facts of a context, as the storage reads them. */
export interface AccessContextFacts {
  /** True when the principal exists in the tenant. */
  principalExists: boolean
  /** True when the principal is active. */
  principalActive: boolean
  /** True when the tenant of the principal is enabled. */
  tenantEnabled: boolean
  /** The complete set of the keys of the grants that apply. */
  permissionKeys: string[]
  /** The earliest expiry among the grants that apply. */
  earliestExpiry: Date | null
}

/** The answer of a context. */
export interface AccessContextAnswer {
  /** True when the principal may use the workspace on the route. */
  allow: boolean
  /** The complete set of the keys of the grants that apply. */
  permissionKeys: string[]
  /** The moment the answer was computed. */
  evaluatedAt: Date
  /** The moment the answer stops being valid. */
  validUntil: Date | null
}

/**
 * The rule of the context.
 *
 * A principal may use a workspace on a route when it exists, when it is
 * active, when its tenant is enabled and when at least one live grant
 * applies to it. The keys of the answer are the keys of the grants that
 * apply to the request: the grants of the principal and the grants of
 * its groups, whose workspace and route scope match the request or is
 * unrestricted. A consumer decides what the keys mean, Hub decides
 * which ones are held.
 */
export function evaluateAccessContext(facts: AccessContextFacts, now: Date): AccessContextAnswer {
  const keys = [...new Set(facts.permissionKeys)].sort()
  if (!facts.principalExists || !facts.principalActive || !facts.tenantEnabled) {
    return { allow: false, permissionKeys: [], evaluatedAt: now, validUntil: null }
  }
  if (keys.length === 0) {
    return { allow: false, permissionKeys: [], evaluatedAt: now, validUntil: null }
  }
  const limit = new Date(now.getTime() + MAX_LIFETIME_MS)
  const validUntil =
    facts.earliestExpiry && facts.earliestExpiry < limit ? facts.earliestExpiry : limit
  return { allow: true, permissionKeys: keys, evaluatedAt: now, validUntil }
}

/** The storage of the context. */
export interface AccessContextStore {
  /**
   * The facts of a context.
   *
   * The reading is one statement over the tables of the policy: the
   * context is not cached and it is computed on every request.
   */
  context: (request: AccessContextRequest) => Promise<AccessContextFacts>
}
