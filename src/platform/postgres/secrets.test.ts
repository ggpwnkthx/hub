import { describe, expect, test } from 'bun:test'
import { createSecretCipher, deriveKey, SecretError } from './secrets'

describe('the encryption of the client secrets', () => {
  test('the round trip gives the clear value back', () => {
    const cipher = createSecretCipher('the-key-of-the-deployment')
    const encrypted = cipher.encrypt('the-secret-of-the-provider')
    expect(Buffer.from(encrypted).toString('utf8')).not.toContain('the-secret-of-the-provider')
    expect(cipher.decrypt(encrypted)).toBe('the-secret-of-the-provider')
  })

  test('the ciphertext carries the version of its format', () => {
    const cipher = createSecretCipher('the-key-of-the-deployment')
    const encrypted = cipher.encrypt('the-secret')
    expect(encrypted[0]).toBe(1)
  })

  test('two encryptions of the same secret are different', () => {
    const cipher = createSecretCipher('the-key-of-the-deployment')
    const first = cipher.encrypt('the-secret')
    const second = cipher.encrypt('the-secret')
    expect(Buffer.from(first).toString('hex')).not.toBe(Buffer.from(second).toString('hex'))
  })

  test('another key does not read the secret', () => {
    const cipher = createSecretCipher('the-key-of-the-deployment')
    const other = createSecretCipher('the-key-of-another-deployment')
    const encrypted = cipher.encrypt('the-secret')
    expect(() => other.decrypt(encrypted)).toThrow(SecretError)
  })

  test('a ciphertext that was changed does not read', () => {
    const cipher = createSecretCipher('the-key-of-the-deployment')
    const encrypted = cipher.encrypt('the-secret')
    const changed = Buffer.from(encrypted)
    changed[changed.length - 1] = (changed[changed.length - 1]! + 1) % 256
    expect(() => cipher.decrypt(changed)).toThrow(SecretError)
  })

  test('a ciphertext of another version is refused', () => {
    const cipher = createSecretCipher('the-key-of-the-deployment')
    const encrypted = Buffer.from(cipher.encrypt('the-secret'))
    encrypted[0] = 9
    expect(() => cipher.decrypt(encrypted)).toThrow(/version 9/)
  })

  test('a short ciphertext is refused', () => {
    const cipher = createSecretCipher('the-key-of-the-deployment')
    expect(() => cipher.decrypt(new Uint8Array([1, 2, 3]))).toThrow(SecretError)
  })

  test('the key of the encryption is 32 bytes whatever the secret is', () => {
    expect(deriveKey('a-passphrase').length).toBe(32)
    expect(deriveKey('a'.repeat(64)).length).toBe(32)
  })
})
