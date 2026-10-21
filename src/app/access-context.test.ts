import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import {
  accessContextDiscoveryHandler,
  accessContextHandler,
  type AccessContextCredential,
} from './access-context'
import type { AccessContextFacts, AccessContextRequest } from '../domains/authorization'

const CREDENTIAL = 'access-context-credential-0001'
const TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333'

const credentials: AccessContextCredential[] = [
  { token: CREDENTIAL, tenants: [TENANT] },
  { token: 'platform-credential-0000000001', tenants: null },
]

/** The facts of the tests. */
function factsOf(overrides: Partial<AccessContextFacts> = {}): AccessContextFacts {
  return {
    principalExists: true,
    principalActive: true,
    tenantEnabled: true,
    permissionKeys: ['content.reader'],
    earliestExpiry: null,
    ...overrides,
  }
}

/** The application of the tests. */
function app(facts: AccessContextFacts = factsOf()): Hono {
  const instance = new Hono()
  const dependencies = {
    store: { context: async (_request: AccessContextRequest) => facts },
    credentials,
  }
  instance.get('/v1/access-context', (context) =>
    accessContextDiscoveryHandler(context as never, dependencies)
  )
  instance.post(
    '/v1/access-context',
    async (context) => await accessContextHandler(context as never, dependencies)
  )
  return instance
}

/** A request of a context. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    subject: '11111111-1111-4111-8111-111111111111',
    tenantId: TENANT,
    workspaceId: '44444444-4444-4444-8444-444444444444',
    routeId: 'data-api',
    ...overrides,
  }
}

describe('the discovery of the contract', () => {
  test('it answers the version and the limits', async () => {
    const response = await app().request('/v1/access-context', {
      headers: { authorization: `Bearer ${CREDENTIAL}` },
    })
    expect(response.status).toBe(200)
    const answer = (await response.json()) as Record<string, unknown>
    expect(answer.versions).toEqual([1])
    expect(answer.maxPermissionKeys).toBe(4096)
    expect(answer.maxLifetimeMs).toBe(5000)
  })

  test('it refuses a request without a credential', async () => {
    const response = await app().request('/v1/access-context')
    expect(response.status).toBe(401)
  })

  test('it refuses a request with a wrong credential', async () => {
    const response = await app().request('/v1/access-context', {
      headers: { authorization: 'Bearer nope' },
    })
    expect(response.status).toBe(401)
  })
})

describe('the evaluation of a context', () => {
  test('it answers the complete set of the keys', async () => {
    const response = await app(factsOf({ permissionKeys: ['b', 'a'] })).request(
      '/v1/access-context',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CREDENTIAL}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body()),
      }
    )
    expect(response.status).toBe(200)
    const answer = (await response.json()) as Record<string, unknown>
    expect(answer.allow).toBe(true)
    expect(answer.permissionKeys).toEqual(['a', 'b'])
    expect(answer.subject).toBe('11111111-1111-4111-8111-111111111111')
    expect(answer.tenantId).toBe(TENANT)
    expect(typeof answer.validUntil).toBe('string')
  })

  test('a refusal is an answer of 200 without a validity', async () => {
    const response = await app(factsOf({ permissionKeys: [], principalExists: false })).request(
      '/v1/access-context',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${CREDENTIAL}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body()),
      }
    )
    expect(response.status).toBe(200)
    const answer = (await response.json()) as Record<string, unknown>
    expect(answer.allow).toBe(false)
    expect(answer.permissionKeys).toEqual([])
    expect(answer.validUntil).toBeUndefined()
  })

  test('a credential of a tenant may not ask about another tenant', async () => {
    const response = await app().request('/v1/access-context', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ tenantId: OTHER_TENANT })),
    })
    expect(response.status).toBe(403)
  })

  test('a credential of the platform may ask about every tenant', async () => {
    const response = await app().request('/v1/access-context', {
      method: 'POST',
      headers: {
        authorization: 'Bearer platform-credential-0000000001',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ tenantId: OTHER_TENANT })),
    })
    expect(response.status).toBe(200)
  })

  test('it refuses an unknown field of the body', async () => {
    const response = await app().request('/v1/access-context', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ extra: true })),
    })
    expect(response.status).toBe(400)
  })

  test('it refuses an unsupported version', async () => {
    const response = await app().request('/v1/access-context', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ version: 2 })),
    })
    expect(response.status).toBe(400)
  })

  test('it refuses a body that is not json', async () => {
    const response = await app().request('/v1/access-context', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: 'not json',
    })
    expect(response.status).toBe(400)
  })

  test('it refuses a body that is too large', async () => {
    const response = await app().request('/v1/access-context', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CREDENTIAL}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body({ padding: 'x'.repeat(70 * 1024) })),
    })
    expect(response.status).toBe(400)
  })
})
