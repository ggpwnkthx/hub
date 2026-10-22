/**
 * The shared store of Hub.
 *
 * The store holds the authorization codes of the logins. It is shared by
 * the replicas of a deployment: a code that lives in the memory of one
 * replica is unknown to the others.
 */

import { createClient, type RedisClientType } from 'redis'
import type { CodeRecord, CodeStore } from '../../domains/provider'
import type { AuthenticationFailures, FailureCount } from '../../domains/administration'

/** The client of the shared store. */
export type SharedStoreClient = RedisClientType

/**
 * How many addresses are kept before the expired ones are swept.
 *
 * The count of an address that is gone is gone: the store forgets it
 * when its window ends, and the memory of the process forgets it too.
 */
const SWEEP_AT = 1_000

export interface StoreOptions {
  /** The url of the store. */
  url: string
  /** The prefix of the keys of the service. */
  keyPrefix?: string
  /** Called when the store reports an error. */
  onError?: (error: unknown) => void
}

/** Opens the shared store. */
export async function createStoreClient(options: StoreOptions): Promise<SharedStoreClient> {
  const client = createClient({
    url: options.url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => Math.min(retries * 200, 5_000),
    },
  })
  client.on('error', (error: unknown) => options.onError?.(error))
  await client.connect()
  return client as RedisClientType
}

/** The store of the codes, in the shared store. */
export class RedisCodeStore implements CodeStore {
  constructor(
    private readonly client: SharedStoreClient,
    private readonly keyPrefix = 'hub'
  ) {}

  /** The key of a code. */
  private key(hash: string): string {
    return `${this.keyPrefix}:code:${hash}`
  }

  async put(hash: string, record: CodeRecord, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key(hash), JSON.stringify(record), { EX: ttlSeconds })
  }

  async take(hash: string): Promise<CodeRecord | null> {
    // The read and the delete are one operation: a code that is redeemed
    // twice is a code that does not exist.
    const raw = await this.client.getDel(this.key(hash))
    if (!raw) return null
    try {
      return JSON.parse(raw) as CodeRecord
    } catch {
      return null
    }
  }
}

/** The store of the codes, in the memory of the process. */
export class MemoryCodeStore implements CodeStore {
  private readonly codes = new Map<string, { record: CodeRecord; expiresAt: number }>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(hash: string, record: CodeRecord, ttlSeconds: number): Promise<void> {
    this.codes.set(hash, { record, expiresAt: this.now() + ttlSeconds * 1000 })
  }

  async take(hash: string): Promise<CodeRecord | null> {
    const found = this.codes.get(hash)
    if (!found) return null
    this.codes.delete(hash)
    if (found.expiresAt <= this.now()) return null
    return found.record
  }
}

/**
 * The count of the failed authentications, in the shared store.
 *
 * The count is shared by the replicas of the deployment: the window of
 * the limiter of the administration is the window of the deployment and
 * not the window of a replica (spec §10.1).
 */
export class RedisAuthenticationFailures implements AuthenticationFailures {
  constructor(
    private readonly client: SharedStoreClient,
    private readonly keyPrefix = 'hub'
  ) {}

  /** The key of the count of an address. */
  private key(address: string): string {
    return `${this.keyPrefix}:admin-failures:${address}`
  }

  async fail(address: string, windowMs: number): Promise<FailureCount> {
    const key = this.key(address)
    const count = await this.client.incr(key)
    let ttl = await this.client.pTTL(key)
    if (count === 1 || ttl < 0) {
      // The window of the address starts at its first failure. A key
      // without a time to live is a key of a store that was restarted:
      // the window starts again rather than lasting forever.
      await this.client.pExpire(key, windowMs)
      ttl = windowMs
    }
    return { count, retryAfterMs: ttl > 0 ? ttl : windowMs }
  }

  async count(address: string, windowMs: number): Promise<FailureCount> {
    const key = this.key(address)
    const raw = await this.client.get(key)
    const count = raw === null ? 0 : Number(raw)
    if (count === 0) return { count: 0, retryAfterMs: 0 }
    const ttl = await this.client.pTTL(key)
    return { count, retryAfterMs: ttl > 0 ? ttl : windowMs }
  }

  async succeed(address: string): Promise<void> {
    await this.client.del(this.key(address))
  }
}

/**
 * The count of the failed authentications, in the memory of the process.
 *
 * It is the count of a deployment that keeps its state in the process: a
 * single node, which is the only topology where the count of a replica is
 * the count of the deployment.
 */
export class MemoryAuthenticationFailures implements AuthenticationFailures {
  private readonly failures = new Map<string, { count: number; since: number }>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  async fail(address: string, windowMs: number): Promise<FailureCount> {
    const now = this.now()
    this.sweep(now, windowMs)
    const failure = this.failures.get(address)
    if (!failure || now - failure.since >= windowMs) {
      this.failures.set(address, { count: 1, since: now })
      return { count: 1, retryAfterMs: windowMs }
    }
    failure.count += 1
    return { count: failure.count, retryAfterMs: windowMs - (now - failure.since) }
  }

  async count(address: string, windowMs: number): Promise<FailureCount> {
    const now = this.now()
    const failure = this.failures.get(address)
    if (!failure || now - failure.since >= windowMs) return { count: 0, retryAfterMs: 0 }
    return { count: failure.count, retryAfterMs: windowMs - (now - failure.since) }
  }

  async succeed(address: string): Promise<void> {
    this.failures.delete(address)
  }

  /**
   * Drops the addresses whose window is over.
   *
   * The count of an address that is gone is gone: the store of the
   * deployment forgets it when its window ends, and the memory of the
   * process forgets it too.
   */
  private sweep(now: number, windowMs: number): void {
    if (this.failures.size < SWEEP_AT) return
    for (const [address, failure] of this.failures) {
      if (now - failure.since >= windowMs) this.failures.delete(address)
    }
  }
}
