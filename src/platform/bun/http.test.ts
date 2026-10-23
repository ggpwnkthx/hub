import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createFetchTransport } from './http'

/**
 * The transport of the outbound calls.
 *
 * The transport makes the call to the address of the target, and not to
 * the address the name of the host resolves to: the guard of the addresses
 * checked one address, and the call speaks of that one.
 */

describe('the transport of the outbound calls', () => {
  let server: ReturnType<typeof Bun.serve>
  let seen: { host: string | null; url: string }[]
  let bodySize = 0

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        seen.push({ host: request.headers.get('host'), url: request.url })
        if (bodySize > 0) {
          return new Response('x'.repeat(bodySize))
        }
        return new Response('the answer of the provider')
      },
    })
  })

  afterAll(() => {
    server.stop(true)
  })

  test('the call is made to the address of the target', async () => {
    seen = []
    const transport = createFetchTransport()
    const answer = await transport.call('https://login.acme.example/.well-known', {
      method: 'GET',
      headers: { accept: 'application/json' },
      timeoutMs: 5_000,
      target: {
        url: `http://127.0.0.1:${server.port}/.well-known`,
        host: 'login.acme.example',
        servername: 'login.acme.example',
        secure: false,
      },
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('the answer of the provider')
    // The call reached the address of the target: the name of the host
    // does not resolve, so the call could only arrive through the address
    // of the target. It carried the name of the host in the `Host`
    // header.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.host).toBe('login.acme.example')
  })

  test('a call without a target resolves the name itself', async () => {
    const transport = createFetchTransport()
    // The name of the host does not resolve: the call fails, and it fails
    // on the name, not on the address.
    await expect(
      transport.call('https://login.acme.example/.well-known', {
        method: 'GET',
        headers: {},
        timeoutMs: 5_000,
      })
    ).rejects.toThrow()
  })

  test('a call without a target is made to the url', async () => {
    seen = []
    const transport = createFetchTransport()
    const answer = await transport.call(`http://127.0.0.1:${server.port}/direct`, {
      method: 'GET',
      headers: {},
      timeoutMs: 5_000,
    })
    expect(answer.status).toBe(200)
    expect(seen[0]!.url).toBe(`http://127.0.0.1:${server.port}/direct`)
  })

  test('an answer that is too large is a failure', async () => {
    bodySize = 2 * 1_048_576
    try {
      const transport = createFetchTransport()
      await expect(
        transport.call(`http://127.0.0.1:${server.port}/big`, {
          method: 'GET',
          headers: {},
          timeoutMs: 5_000,
        })
      ).rejects.toThrow(/too large/)
    } finally {
      bodySize = 0
    }
  })
})
