import { describe, expect, test } from 'bun:test'
import {
  type AccessContextFacts,
  evaluateAccessContext,
  MAX_LIFETIME_MS,
  MAX_PERMISSION_KEYS,
} from './access-context'

/** The facts of a principal that holds two keys. */
function facts(overrides: Partial<AccessContextFacts> = {}): AccessContextFacts {
  return {
    principalExists: true,
    principalActive: true,
    tenantEnabled: true,
    permissionKeys: ['content.editor', 'content.reader'],
    earliestExpiry: null,
    ...overrides,
  }
}

describe('the rule of the access context', () => {
  test('a principal that holds a grant may use the workspace', () => {
    const answer = evaluateAccessContext(facts(), new Date('2026-10-21T16:00:00.000Z'))
    expect(answer.allow).toBe(true)
    expect(answer.permissionKeys).toEqual(['content.editor', 'content.reader'])
  })

  test('the keys are sorted and deduplicated', () => {
    const answer = evaluateAccessContext(
      facts({ permissionKeys: ['b', 'a', 'a'] }),
      new Date('2026-10-21T16:00:00.000Z')
    )
    expect(answer.permissionKeys).toEqual(['a', 'b'])
  })

  test('an unknown principal is refused without a reason', () => {
    const answer = evaluateAccessContext(
      facts({ principalExists: false }),
      new Date('2026-10-21T16:00:00.000Z')
    )
    expect(answer.allow).toBe(false)
    expect(answer.permissionKeys).toEqual([])
    expect(answer.validUntil).toBeNull()
  })

  test('a disabled principal is refused', () => {
    const answer = evaluateAccessContext(
      facts({ principalActive: false }),
      new Date('2026-10-21T16:00:00.000Z')
    )
    expect(answer.allow).toBe(false)
  })

  test('a disabled tenant is refused', () => {
    const answer = evaluateAccessContext(
      facts({ tenantEnabled: false }),
      new Date('2026-10-21T16:00:00.000Z')
    )
    expect(answer.allow).toBe(false)
  })

  test('a principal without a grant is refused', () => {
    const answer = evaluateAccessContext(
      facts({ permissionKeys: [] }),
      new Date('2026-10-21T16:00:00.000Z')
    )
    expect(answer.allow).toBe(false)
  })

  test('the validity never exceeds the limit of the contract', () => {
    const now = new Date('2026-10-21T16:00:00.000Z')
    const answer = evaluateAccessContext(facts(), now)
    expect(answer.validUntil!.getTime() - now.getTime()).toBe(MAX_LIFETIME_MS)
  })

  test('the validity never exceeds the earliest expiry of the grants', () => {
    const now = new Date('2026-10-21T16:00:00.000Z')
    const expiry = new Date(now.getTime() + 1000)
    const answer = evaluateAccessContext(facts({ earliestExpiry: expiry }), now)
    expect(answer.validUntil!.getTime()).toBe(expiry.getTime())
  })

  test('the limits of the contract are the ones of the specification', () => {
    expect(MAX_PERMISSION_KEYS).toBe(4096)
    expect(MAX_LIFETIME_MS).toBe(5000)
  })
})
