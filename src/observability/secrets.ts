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
