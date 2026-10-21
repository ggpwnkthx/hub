import { describe, expect, test } from 'bun:test'
import { createHubApp } from './app'
import type { HubDependencies } from './dependencies'
import { createSilentLogger } from '../observability'

/** The dependencies of the tests. */
function dependencies(): HubDependencies {
  return {
    version: '0.1.0',
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
  }
}

describe('the application of Hub', () => {
  test('the application answers a request', async () => {
    const app = createHubApp(dependencies())
    const response = await app.fetch(new Request('http://hub.example.com/healthz'))
    expect(response.status).toBe(200)
  })
})
