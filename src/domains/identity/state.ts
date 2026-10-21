/**
 * The state of a login (spec §5.3).
 *
 * The state of a login travels in two cookies and in the parameters of the
 * redirects: the cookie holds the encrypted state of the login and the
 * parameters hold the state of the provider and the state of the gateway.
 *
 * The cookie is encrypted with `HUB_STATE_SECRET` (AES-256-GCM,
 * authenticated): it carries nothing readable and nothing durable.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'

/** The name of the cookie of the state of a login. */
export const STATE_COOKIE = 'hub_login_state'

/** The life of the state of a login, in seconds. */
export const STATE_TTL_SECONDS = 600

/** The size of the key of the encryption. */
const KEY_BYTES = 32

/** The size of the nonce of the encryption. */
const NONCE_BYTES = 12

/** The size of the tag of the encryption. */
const TAG_BYTES = 16

/** The label of the derivation of the key. */
const KEY_INFO = 'hub:login-state:v1'

/** The state of a login. */
export interface LoginState {
  /** The slug of the tenant of the login. */
  tenant: string
  /** The client id of the gateway. */
  clientId: string
  /** The redirect uri of the request. */
  redirectUri: string
  /** The state of the gateway. */
  state: string
  /** The nonce of the login. */
  nonce: string
  /** The verifier of the PKCE of the provider. */
  verifier: string
  /** The scopes of the request. */
  scopes: string[]
  /** The challenge of the PKCE of the gateway, when the request has one. */
  codeChallenge?: string
  /** The moment the login started, in milliseconds. */
  startedAt: number
}

/** The failure of the reading of a state of a login. */
export class LoginStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginStateError'
  }
}

/** The cipher of the state of a login. */
export interface StateCipher {
  /** Encrypts a state of a login. */
  encrypt: (state: LoginState) => string
  /** Decrypts a state of a login. */
  decrypt: (value: string) => LoginState
}

/** Derives the key of the encryption from the secret of the deployment. */
function deriveKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), KEY_INFO, KEY_BYTES)
  )
}

/**
 * Builds the cipher of the state of a login.
 *
 * The state is authenticated: a state that was changed does not decrypt,
 * and the failure does not tell what was changed.
 */
export function createStateCipher(secret: string): StateCipher {
  const key = deriveKey(secret)
  return {
    encrypt(state: LoginState): string {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const body = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return Buffer.concat([nonce, body, tag]).toString('base64url')
    },
    decrypt(value: string): LoginState {
      let raw: Buffer
      try {
        raw = Buffer.from(value, 'base64url')
      } catch {
        throw new LoginStateError('the state of the login is not readable')
      }
      if (raw.length < NONCE_BYTES + TAG_BYTES) {
        throw new LoginStateError('the state of the login is not readable')
      }
      const nonce = raw.subarray(0, NONCE_BYTES)
      const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)
      const tag = raw.subarray(raw.length - TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      let clear: string
      try {
        clear = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new LoginStateError('the state of the login is not readable')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(clear)
      } catch {
        throw new LoginStateError('the state of the login is not readable')
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new LoginStateError('the state of the login is not readable')
      }
      const state = parsed as Partial<LoginState>
      if (
        typeof state.tenant !== 'string' ||
        typeof state.clientId !== 'string' ||
        typeof state.redirectUri !== 'string' ||
        typeof state.verifier !== 'string' ||
        typeof state.startedAt !== 'number'
      ) {
        throw new LoginStateError('the state of the login is not readable')
      }
      return {
        tenant: state.tenant,
        clientId: state.clientId,
        redirectUri: state.redirectUri,
        state: typeof state.state === 'string' ? state.state : '',
        nonce: typeof state.nonce === 'string' ? state.nonce : '',
        verifier: state.verifier,
        scopes: Array.isArray(state.scopes) ? state.scopes : [],
        ...(typeof state.codeChallenge === 'string' ? { codeChallenge: state.codeChallenge } : {}),
        startedAt: state.startedAt,
      }
    },
  }
}

/** A fresh verifier of the PKCE. */
export function aVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** The challenge of the PKCE of a verifier. */
export function aChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** A fresh state of the provider. */
export function aProviderState(): string {
  return randomUUID()
}

/** A fresh nonce of the login. */
export function aNonce(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Reports whether a state of a login is still alive.
 *
 * The state lives ten minutes: a login that was started and abandoned
 * does not come back.
 */
export function isAlive(state: LoginState, now: number = Date.now()): boolean {
  return now - state.startedAt < STATE_TTL_SECONDS * 1000
}
