/**
 * The encryption of the client secrets at rest (spec §4.3).
 *
 * The two client secrets of a tenant are encrypted with AES-256-GCM under
 * `HUB_SECRET_ENCRYPTION_KEY` before they are written. The ciphertext
 * carries the version of its format, so a rotation of the format is a
 * version and not a migration of the column.
 *
 * The key is derived with HKDF-SHA256 from the secret of the deployment:
 * the secret may be given as a passphrase, as a hexadecimal string or as a
 * base64 string, and the key of the encryption is always 32 bytes.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/** The version of the format of the ciphertext. */
export const CIPHERTEXT_VERSION = 1

/** The size of the key of the encryption. */
export const KEY_BYTES = 32

/** The size of the nonce of the encryption. */
export const NONCE_BYTES = 12

/** The size of the tag of the encryption. */
export const TAG_BYTES = 16

/** The label of the derivation of the key. */
const KEY_INFO = 'hub:client-secret:v1'

/**
 * The failure of the reading of a secret.
 *
 * The message never carries the secret and never carries the reason of
 * the failure of the cipher: an operator has to know that the key of the
 * deployment and the stored secret do not belong together, nothing else.
 */
export class SecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretError'
  }
}

/** The encryption and the decryption of a secret. */
export interface SecretCipher {
  /** Encrypts a clear secret. */
  encrypt(clear: string): Uint8Array
  /** Decrypts a stored secret. */
  decrypt(ciphertext: Uint8Array): string
}

/**
 * Derives the key of the encryption from the secret of the deployment.
 *
 * The secret is used as it is given: the derivation is what makes a
 * passphrase of any length a key of 32 bytes.
 */
export function deriveKey(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), KEY_INFO, KEY_BYTES)
  )
}

/**
 * Builds the cipher of the client secrets.
 *
 * The same cipher encrypts and decrypts: it holds the key of the
 * deployment in the memory of the process and it never writes it.
 */
export function createSecretCipher(secret: string): SecretCipher {
  const key = deriveKey(secret)
  return {
    encrypt(clear: string): Uint8Array {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const body = Buffer.concat([cipher.update(clear, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      // The version is the first byte of the ciphertext: the reader knows
      // the format of what it reads.
      return Buffer.concat([Buffer.from([CIPHERTEXT_VERSION]), nonce, body, tag])
    },
    decrypt(ciphertext: Uint8Array): string {
      if (ciphertext.length < 1 + NONCE_BYTES + TAG_BYTES) {
        throw new SecretError('the stored secret is not a ciphertext of this format')
      }
      const version = ciphertext[0]!
      if (version !== CIPHERTEXT_VERSION) {
        throw new SecretError(
          `the stored secret has the version ${version} and this version of Hub reads the version ${CIPHERTEXT_VERSION}`
        )
      }
      const nonce = ciphertext.subarray(1, 1 + NONCE_BYTES)
      const body = ciphertext.subarray(1 + NONCE_BYTES, ciphertext.length - TAG_BYTES)
      const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', key, nonce)
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
      } catch {
        throw new SecretError(
          'the stored secret cannot be read: the key of the deployment does not decrypt it'
        )
      }
    },
  }
}
