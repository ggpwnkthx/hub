/**
 * The comparison of the secrets.
 *
 * The tokens of the service are compared in constant time: the time of
 * the answer may not tell a caller whether a secret is right. The two
 * values are hashed first, so the comparison does not depend on the
 * length of the secret either.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Compares two secrets in constant time.
 *
 * The function answers whether the two secrets are the same; it does not
 * tell which one is wrong.
 */
export function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest()
  const b = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * The fingerprint of a secret.
 *
 * The fingerprint names a secret without naming it: the audit of the
 * administration records it, so an operator sees which credential made a
 * change, and the secret itself never reaches the table.
 *
 * The fingerprint is the first twelve hexadecimal characters of the
 * digest of the secret. It is not a secret: it is a label.
 */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12)
}
