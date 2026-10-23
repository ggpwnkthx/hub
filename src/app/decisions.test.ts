import { describe, expect, test } from 'bun:test'
import { createHubApp } from './app'
import type { HubDependencies } from './dependencies'
import type { DecisionFacts } from '../domains/authorization'
import { createSilentLogger } from '../observability'
import { TimeoutError } from '../platform/postgres'

/** The token of the gateway of the tests. */
const TOKEN = 'the-access-token'

/** The subject of the tests: the id of a principal. */
const SUBJECT = '11111111-1111-4111-8111-111111111111'

/** The dependencies of the tests. */
function dependencies(decide: () => Promise<DecisionFacts>): HubDependencies {
  return {
    version: '0.2.0',
    logger: createSilentLogger(),
    observer: {
      recordDecision: () => undefined,
      recordAdminRequest: () => undefined,
      recordStoreError: () => undefined,
      recordLogin: () => undefined,
      render: async () => '',
      contentType: 'text/plain',
    },
    probe: { ready: async () => true },
    isDraining: () => false,
    administration: {} as HubDependencies['administration'],
    provider: {} as HubDependencies['provider'],
    login: {} as HubDependencies['login'],
    codes: {} as HubDependencies['codes'],
    tenants: {} as HubDependencies['tenants'],
    cookieSecure: false,
    decisions: { decide },
    accessContexts: { context: async () => ({}) as never },
    accessContextCredentials: [],
    accessToken: TOKEN,
    publicUrl: 'https://hub.example.com',
    peerAddress: () => '127.0.0.1',
    sharedTokenNoticeWritten: false,
  }
}

/** Asks for a decision. */
async function ask(app: ReturnType<typeof createHubApp>): Promise<Response> {
  return await app.fetch(
    new Request('http://hub.example.com/v1/decisions', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ subject: SUBJECT, workspaceId: 'w', routeId: 'r', roles: [] }),
    })
  )
}

describe('the decision endpoint', () => {
  test('a decision that cannot be computed is a service that is not available', async () => {
    const app = createHubApp(
      dependencies(async () => {
        throw new Error('the database is down')
      })
    )
    const response = await ask(app)
    expect(response.status).toBe(503)
    expect(((await response.json()) as Record<string, unknown>).error).toBe('service_unavailable')
  })

  test('a decision that takes too long is a service that is not available', async () => {
    const app = createHubApp(
      dependencies(async () => {
        throw new TimeoutError(2_000)
      })
    )
    const response = await ask(app)
    expect(response.status).toBe(503)
  })

  test('a decision is answered with the reason', async () => {
    const app = createHubApp(
      dependencies(async () => ({
        principalExists: true,
        tenantSlug: 'acme',
        principalActive: true,
        tenantEnabled: true,
        liveGrant: false,
        expiredGrant: false,
      }))
    )
    const response = await ask(app)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      allow: false,
      reason: 'the principal does not have the role of the workspace',
      reasonCode: 'missing_role',
    })
  })
})

describe('the deprecation of the bearer token of the deployment', () => {
  test('the notice is written once, and it says what to use instead', async () => {
    const warnings: string[] = []
    const deps = dependencies(async () => ({
      principalExists: true,
      tenantSlug: 'acme',
      principalActive: true,
      tenantEnabled: true,
      liveGrant: false,
      expiredGrant: false,
    }))
    deps.logger = {
      ...createSilentLogger(),
      warn: (message: string) => {
        warnings.push(message)
      },
    }
    const app = createHubApp(deps)

    await ask(app)
    await ask(app)

    // The notice is written once: a warning on every decision would
    // drown the log of the decisions.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('deprecated')
    expect(warnings[0]).toContain('scoped')
  })

  test('the credentials of a tenant are not deprecated', async () => {
    const warnings: string[] = []
    const deps = dependencies(async () => ({
      principalExists: true,
      tenantSlug: 'acme',
      principalActive: true,
      tenantEnabled: true,
      liveGrant: false,
      expiredGrant: false,
    }))
    deps.logger = {
      ...createSilentLogger(),
      warn: (message: string) => {
        warnings.push(message)
      },
    }
    deps.tenants = {
      findByClientId: async () => ({
        id: '22222222-2222-4222-8222-222222222222',
        slug: 'acme',
        clientId: 'shuttle-acme',
        sharedClient: false,
      }),
      gatewaySecrets: async () => ({
        current: 'the-secret',
        previous: null,
        previousUntil: null,
      }),
    } as HubDependencies['tenants']
    const app = createHubApp(deps)

    const response = await app.fetch(
      new Request('http://hub.example.com/v1/decisions', {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from('shuttle-acme:the-secret').toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ subject: SUBJECT, workspaceId: 'w', routeId: 'r', roles: [] }),
      })
    )
    expect(response.status).toBe(200)
    expect(warnings).toHaveLength(0)
  })
})
