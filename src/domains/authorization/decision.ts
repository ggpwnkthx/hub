/**
 * The access of the callers (spec §8).
 *
 * The domain owns the rule of the decision and the vocabulary of the
 * reasons. The storage is a port: the reading of the grants is one
 * statement, and the domain turns its facts into the answer of the
 * protocol.
 */

/** The request of a decision. */
export interface DecisionRequest {
  /** The id of the principal. */
  subject: string
  /** The workspace of the request. */
  workspaceId: string
  /** The route of the request. */
  routeId: string
  /** The roles of the token of the caller: the context, never the policy. */
  roles: string[]
  /**
   * The tenant the decision is scoped to, or null for every tenant.
   *
   * A gateway that authenticates itself with the credentials of a tenant
   * only asks about the principals of that tenant (spec §8.8).
   */
  tenantId?: string | null
}

/**
 * The facts of a decision, as the storage reads them.
 *
 * They are the conditions of the rule of the specification (§8.3): the
 * domain turns them into the answer.
 */
export interface DecisionFacts {
  /** True when the principal exists. */
  principalExists: boolean
  /** The slug of the tenant of the principal, when it exists. */
  tenantSlug: string | null
  /** True when the principal is active. */
  principalActive: boolean
  /** True when the tenant of the principal is enabled. */
  tenantEnabled: boolean
  /** True when a live grant satisfies the rule. */
  liveGrant: boolean
  /** True when a grant of the scope exists but has expired. */
  expiredGrant: boolean
}

/** The answer of a decision. */
export interface Decision {
  /** True when the principal may use the workspace on the route. */
  allow: boolean
  /** The reason of the answer: for the operator, never for the caller. */
  reason: string
}

/**
 * The reasons of the decisions (spec §8.7).
 *
 * The two last reasons carry the word *role*: the gateway counts a denial
 * whose reason mentions a role as `missing_role` and any other denial as
 * `access_denied` (§6 of the specification of the gateway).
 */
export const REASONS = {
  allowed: 'allowed',
  principalMissing: 'the principal does not exist',
  principalDisabled: 'the principal is disabled',
  tenantDisabled: 'the tenant is disabled',
  missingRole: 'the principal does not have the role of the workspace',
  expiredRole: 'the role of the workspace has expired',
} as const

/** The storage of the decision. */
export interface DecisionStore {
  /**
   * The facts of a decision.
   *
   * The reading is one statement over the tables of the policy: the
   * decision is not cached and it is computed on every request.
   */
  decide(request: DecisionRequest): Promise<DecisionFacts>
}

/**
 * The rule of the decision (spec §8.3).
 *
 * A principal may use a workspace on a route when there is at least one
 * grant that satisfies every condition of the rule. The order of the
 * reasons is the order of the specification: the first condition that is
 * not satisfied is the reason of the refusal.
 */
export function decide(facts: DecisionFacts): Decision {
  if (!facts.principalExists) {
    return { allow: false, reason: REASONS.principalMissing }
  }
  if (!facts.principalActive) {
    return { allow: false, reason: REASONS.principalDisabled }
  }
  if (!facts.tenantEnabled) {
    return { allow: false, reason: REASONS.tenantDisabled }
  }
  if (facts.liveGrant) {
    return { allow: true, reason: REASONS.allowed }
  }
  if (facts.expiredGrant) {
    return { allow: false, reason: REASONS.expiredRole }
  }
  return { allow: false, reason: REASONS.missingRole }
}

/**
 * Reports whether a reason is a missing role.
 *
 * The gateway counts the denials this way: the vocabulary of the reasons
 * is what makes the metric of the gateway right.
 */
export function isMissingRole(reason: string): boolean {
  return reason.includes('role')
}
