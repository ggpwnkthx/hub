/**
 * The shared store of Hub.
 *
 * The store holds the authorization codes of the logins. It is shared by
 * the replicas of a deployment: a code that lives in the memory of one
 * replica is unknown to the others.
 */

import { createClient, type RedisClientType } from 'redis'
import type { CodeRecord, CodeStore } from '../../domains/provider'

/** The client of the shared store. */
export type SharedStoreClient = RedisClientType

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
