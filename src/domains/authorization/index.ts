/**
 * The access of the callers.
 *
 * The domain owns the rule of the decision: a principal may use a
 * workspace on a route when there is at least one grant that satisfies
 * it. The roles of a request are the context of the decision, never its
 * policy: they are a snapshot of the token and a policy that read them
 * would allow a revoked grant until the next login.
 */

export type {
  Decision,
  DecisionFacts,
  DecisionRequest,
  DecisionStore,
} from './decision'
export { decide, isMissingRole, REASONS } from './decision'
export { isUuid } from './identifier'
export type {
  AccessContextAnswer,
  AccessContextFacts,
  AccessContextRequest,
  AccessContextStore,
} from './access-context'
export {
  ACCESS_CONTEXT_VERSION,
  MAX_LIFETIME_MS,
  MAX_PERMISSION_KEYS,
  MAX_REQUEST_BYTES,
  evaluateAccessContext,
} from './access-context'
