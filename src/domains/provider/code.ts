/**
 * The authorization code of Hub (spec §5.5).
 *
 * The code is an opaque random string of 32 bytes. It is stored under a
 * hash of itself, so the store never holds a code that a reader of the
 * store could redeem, and it is single use: the first exchange deletes
 * it.
 */

import { createHash, randomBytes } from 'node:crypto'

/** The life of a code, in seconds. */
export const CODE_TTL_SECONDS = 60

/** The record of a code. */
export interface CodeRecord {
  /** The client id of the gateway. */
  clientId: string
  /** The redirect uri of the login. */
  redirectUri: string
  /** The challenge of the PKCE of the gateway. */
  codeChallenge?: string
  /** The id of the principal. */
  subject: string
  /** The slug of the tenant of the principal. */
  tenant: string
  /** The client id of the gateway, which is the audience of the tokens. */
  audience: string
  /** The scopes of the login. */
  scopes: string[]
  /** The moment the code was created, in milliseconds. */
  createdAt: number
}

/** The store of the codes. */
export interface CodeStore {
  /** Stores a code under its hash. */
  put: (hash: string, record: CodeRecord, ttlSeconds: number) => Promise<void>
  /** Reads a code and deletes it: a code is single use. */
  take: (hash: string) => Promise<CodeRecord | null>
}

/** A fresh code of 32 bytes. */
export function aCode(): string {
  return randomBytes(32).toString('base64url')
}

/** The hash of a code: the key of the code in the store. */
export function hashOf(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('base64url')
}
