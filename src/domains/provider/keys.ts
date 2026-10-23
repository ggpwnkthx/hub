/**
 * The keys of Hub (spec §4.2).
 *
 * The tokens Hub issues are signed with RS256 and published at
 * `/oauth/jwks`. The key is a secret of the deployment: it comes from the
 * environment and it is never generated at the start of a process, because
 * a key that changes at every restart invalidates every token that is
 * alive.
 *
 * A rotation is the publication of a second key in the JWKS and the change
 * of the key that signs: the old key stays published until the last token
 * it signed has expired.
 */

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { exportJWK, SignJWT, type JWK, type JWTPayload } from 'jose'

/** The algorithm of the tokens of Hub. */
const SIGNING_ALGORITHM = 'RS256'

/** A key of the JWKS. */
interface PublishedKey {
  /** The identifier of the key. */
  kid: string
  /** The public part of the key. */
  jwk: JWK
}

/** The keys of the service. */
export interface SigningKeys {
  /** The identifier of the key that signs. */
  kid: string
  /** Signs the payload of a token. */
  sign: (payload: JWTPayload) => Promise<string>
  /** The published keys: the one that signs and the ones that are kept. */
  published: PublishedKey[]
}

export interface SigningKeyOptions {
  /** The private key of the service, in PEM. */
  key?: string
  /** The identifier of the key in the JWKS. */
  kid?: string
  /** The private key of the previous rotation, in PEM. */
  previousKey?: string
  /** The identifier of the previous key in the JWKS. */
  previousKid?: string
}

/** Turns a PEM private key into the key that signs. */
async function signerOf(
  pem: string,
  kid: string
): Promise<{
  sign: (payload: JWTPayload) => Promise<string>
  published: PublishedKey
}> {
  const privateKey = createPrivateKey(pem)
  const publicKey = createPublicKey(privateKey)
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: SIGNING_ALGORITHM,
    use: 'sig',
  } as JWK
  return {
    sign: async (payload: JWTPayload) =>
      await new SignJWT(payload)
        .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid })
        .sign(privateKey),
    published: { kid, jwk },
  }
}

/**
 * Loads the keys of the service.
 *
 * The answer is null when the deployment has no key: the service cannot
 * issue a token and it says so. A key that cannot be read stops the
 * process: a key that looks usable and is not signs nothing.
 */
export async function loadSigningKeys(options: SigningKeyOptions): Promise<SigningKeys | null> {
  if (!options.key) return null
  if (!options.kid) {
    throw new Error('the identifier of the signing key is missing: the JWKS would have no name')
  }

  let current: Awaited<ReturnType<typeof signerOf>>
  try {
    current = await signerOf(options.key, options.kid)
  } catch {
    throw new Error('the signing key cannot be read: it is not a PEM private key')
  }

  const published: PublishedKey[] = [current.published]
  if (options.previousKey) {
    if (!options.previousKid) {
      throw new Error(
        'the identifier of the previous signing key is missing: the JWKS would have an unnamed key'
      )
    }
    try {
      published.push((await signerOf(options.previousKey, options.previousKid)).published)
    } catch {
      throw new Error('the previous signing key cannot be read: it is not a PEM private key')
    }
  }

  return { kid: options.kid, sign: current.sign, published }
}

/** The JWKS of the service. */
export function jwksOf(keys: SigningKeys): { keys: JWK[] } {
  return { keys: keys.published.map((key) => key.jwk) }
}
