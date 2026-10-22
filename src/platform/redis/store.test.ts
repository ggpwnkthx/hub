import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  createStoreClient,
  MemoryAuthenticationFailures,
  RedisAuthenticationFailures,
  type SharedStoreClient,
} from './store'

/**
 * The count of the failed authentications.
 *
 * The count is held by the shared store of the deployment, so the window
 * of the limiter of the administration is the window of the deployment
 * and not the window of a replica (spec §10.1).
 *
 * The tests of the shared store need a Redis: the environment names it in
 * `HUB_TEST_REDIS_URL`, and the tests are skipped without it.
 */

/** The url of the store of the tests. */
const url = process.env.HUB_TEST_REDIS_URL

/** True when the tests run against a Redis. */
const againstServer = typeof url === 'string' && url.length > 0

let client: SharedStoreClient | null = null

beforeAll(async () => {
  if (!againstServer) return
  client = await createStoreClient({ url: url! })
})

afterAll(async () => {
  await client?.quit()
})

describe('the count of the failures in the memory of the process', () => {
  test('the count of an address grows with its failures', async () => {
    const failures = new MemoryAuthenticationFailures()
    expect((await failures.fail('10.0.0.1', 60_000)).count).toBe(1)
    expect((await failures.fail('10.0.0.1', 60_000)).count).toBe(2)
    expect((await failures.count('10.0.0.1', 60_000)).count).toBe(2)
  })

  test('the count of another address is its own', async () => {
    const failures = new MemoryAuthenticationFailures()
    await failures.fail('10.0.0.1', 60_000)
    expect((await failures.count('10.0.0.2', 60_000)).count).toBe(0)
  })

  test('a success clears the count of the address', async () => {
    const failures = new MemoryAuthenticationFailures()
    await failures.fail('10.0.0.1', 60_000)
    await failures.succeed('10.0.0.1')
    expect((await failures.count('10.0.0.1', 60_000)).count).toBe(0)
  })

  test('the window of an address ends', async () => {
    let now = 1_000_000
    const failures = new MemoryAuthenticationFailures(() => now)
    await failures.fail('10.0.0.1', 60_000)
    now += 60_001
    expect((await failures.count('10.0.0.1', 60_000)).count).toBe(0)
    // The window starts again at the next failure.
    expect((await failures.fail('10.0.0.1', 60_000)).count).toBe(1)
  })
})

describe.skipIf(!againstServer)('the count of the failures in the shared store', () => {
  test('the count of an address is shared by the replicas', async () => {
    const first = new RedisAuthenticationFailures(client!, 'hub-test')
    const second = new RedisAuthenticationFailures(client!, 'hub-test')
    const address = '10.0.0.1'
    await first.succeed(address)

    expect((await first.fail(address, 60_000)).count).toBe(1)
    // The second replica is another process: it reads the count of the
    // first one.
    expect((await second.count(address, 60_000)).count).toBe(1)
    expect((await second.fail(address, 60_000)).count).toBe(2)
    expect((await first.count(address, 60_000)).count).toBe(2)
    await first.succeed(address)
  })

  test('the window of an address is the window of the store', async () => {
    const failures = new RedisAuthenticationFailures(client!, 'hub-test-window')
    const address = '10.0.0.2'
    await failures.succeed(address)
    const failed = await failures.fail(address, 60_000)
    expect(failed.count).toBe(1)
    expect(failed.retryAfterMs).toBeGreaterThan(0)
    expect(failed.retryAfterMs).toBeLessThanOrEqual(60_000)
    await failures.succeed(address)
  })

  test('the count of an address that never failed is zero', async () => {
    const failures = new RedisAuthenticationFailures(client!, 'hub-test-empty')
    const count = await failures.count('10.0.0.3', 60_000)
    expect(count.count).toBe(0)
    expect(count.retryAfterMs).toBe(0)
  })
})

describe('the sweep of the count in the memory of the process', () => {
  test('the count of an address whose window is over is forgotten', async () => {
    let now = 1_000_000
    const failures = new MemoryAuthenticationFailures(() => now)
    // More addresses than the sweep threshold: the expired ones are
    // dropped, and the memory of the process does not grow for ever.
    for (let index = 0; index < 1_100; index += 1) {
      await failures.fail(`10.0.0.${index % 256}`, 60_000)
    }
    now += 60_001
    await failures.fail('10.0.0.255', 60_000)
    expect((await failures.count('10.0.0.255', 60_000)).count).toBe(1)
  })
})
