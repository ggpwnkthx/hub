import { describe, expect, test } from 'bun:test'
import { createHubApp } from './app'
import type { HubDependencies } from './dependencies'
import { createSilentLogger } from '../observability'

/** The dependencies of the tests. */
function dependencies(): HubDependencies {
  return {
    version: '1.0.0',
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
    decisions: { decide: async () => ({}) as never },
    accessContexts: { context: async () => ({}) as never },
    accessContextCredentials: [],
    login: {} as HubDependencies['login'],
    codes: {} as HubDependencies['codes'],
    tenants: {} as HubDependencies['tenants'],
    cookieSecure: false,
    publicUrl: 'https://hub.example.com',
    peerAddress: () => '127.0.0.1',
    sharedTokenNoticeWritten: false,
  }
}

describe('the application of Hub', () => {
  test('the application answers a request', async () => {
    const app = createHubApp(dependencies())
    const response = await app.fetch(new Request('http://hub.example.com/healthz'))
    expect(response.status).toBe(200)
  })
})

describe('the administration of the application', () => {
  test('a store that is down refuses the call', async () => {
    const deps = dependencies()
    deps.administration = {
      authenticate: async () => {
        throw new Error('the shared store is not reachable')
      },
    } as unknown as HubDependencies['administration']
    const app = createHubApp(deps)
    const response = await app.fetch(
      new Request('http://hub.example.com/v1/admin/tenants', {
        method: 'POST',
        headers: { authorization: 'Bearer the-admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'acme' }),
      })
    )
    expect(response.status).toBe(503)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.error).toBe('service_unavailable')
  })
})
