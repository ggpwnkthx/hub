import { describe, expect, test } from 'bun:test'
import { decide, isMissingRole, REASONS } from './index'

/** The facts of a decision that is allowed. */
const ALLOWED = {
  principalExists: true,
  tenantSlug: 'acme',
  principalActive: true,
  tenantEnabled: true,
  liveGrant: true,
  expiredGrant: false,
}

describe('the rule of the decision', () => {
  test('a grant that satisfies the rule allows the request', () => {
    expect(decide(ALLOWED)).toEqual({ allow: true, reason: REASONS.allowed })
  })

  test('a subject that is no principal is refused', () => {
    expect(decide({ ...ALLOWED, principalExists: false, liveGrant: false })).toEqual({
      allow: false,
      reason: REASONS.principalMissing,
    })
  })

  test('a disabled principal is refused', () => {
    expect(decide({ ...ALLOWED, principalActive: false })).toEqual({
      allow: false,
      reason: REASONS.principalDisabled,
    })
  })

  test('a disabled tenant is refused', () => {
    expect(decide({ ...ALLOWED, tenantEnabled: false })).toEqual({
      allow: false,
      reason: REASONS.tenantDisabled,
    })
  })

  test('a principal without a grant is refused', () => {
    expect(decide({ ...ALLOWED, liveGrant: false })).toEqual({
      allow: false,
      reason: REASONS.missingRole,
    })
  })

  test('a grant that has expired is refused', () => {
    expect(decide({ ...ALLOWED, liveGrant: false, expiredGrant: true })).toEqual({
      allow: false,
      reason: REASONS.expiredRole,
    })
  })

  test('the order of the reasons is the order of the specification', () => {
    // A disabled principal of a disabled tenant is a disabled principal.
    expect(decide({ ...ALLOWED, principalActive: false, tenantEnabled: false }).reason).toBe(
      REASONS.principalDisabled
    )
    // A disabled tenant is a disabled tenant, even without a grant.
    expect(decide({ ...ALLOWED, tenantEnabled: false, liveGrant: false }).reason).toBe(
      REASONS.tenantDisabled
    )
  })
})

describe('the reasons of the decisions', () => {
  test('the two reasons of a missing role carry the word role', () => {
    expect(isMissingRole(REASONS.missingRole)).toBe(true)
    expect(isMissingRole(REASONS.expiredRole)).toBe(true)
  })

  test('the other reasons do not carry it', () => {
    expect(isMissingRole(REASONS.principalMissing)).toBe(false)
    expect(isMissingRole(REASONS.principalDisabled)).toBe(false)
    expect(isMissingRole(REASONS.tenantDisabled)).toBe(false)
    expect(isMissingRole(REASONS.allowed)).toBe(false)
  })
})
