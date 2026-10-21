/**
 * The fixture of the provider of a tenant (HUB-045).
 *
 * The fixture is an OpenID Connect provider: it publishes a discovery
 * document, it signs the id tokens and it exchanges the codes. It is
 * broken on purpose when the test needs a provider that signs with the
 * wrong key, that names another issuer, that issues the token for another
 * audience or that carries another nonce.
 */

import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto'
import { exportJWK, SignJWT } from 'jose'

/** A private key of the fixture. */
const KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

/** Another private key: the one of a provider that signs with the wrong key. */
const OTHER_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

export interface FixtureOptions {
  /** The issuer the discovery document names; it is the wrong one when it differs. */
  issuer?: string
  /** The key the fixture signs with. */
  signWith?: 'the-key' | 'another-key'
  /** The audience of the id token. */
  audience?: 'the-client' | 'another-client'
  /** The nonce of the id token. */
  nonce?: 'the-nonce' | 'another-nonce'
  /** The subject of the caller. */
  subject?: string
  /** The e-mail of the caller. */
  email?: string
  /** The name of the caller. */
  name?: string
}

/** The fixture of a provider. */
export interface ProviderFixture {
  /** The url of the provider. */
  url: string
  /** The issuer of the provider. */
  issuer: string
  /** The client id of Hub at the provider. */
  clientId: string
  /** The client secret of Hub at the provider. */
  clientSecret: string
  /** The subject of the caller. */
  subject: string
  /** Stops the fixture. */
  stop: () => Promise<void>
  /** The number of calls to the token endpoint. */
  exchanges: () => number
}

/** Starts the fixture of a provider. */
export async function startProviderFixture(options: FixtureOptions = {}): Promise<ProviderFixture> {
  const subject = options.subject ?? 'the-subject-of-the-caller'
  const email = options.email ?? 'alice@acme.example'
  const name = options.name ?? 'Alice'
  const clientId = 'hub-acme'
  const clientSecret = 'the-secret-of-the-provider'
  let exchanges = 0

  // The codes of the fixture: the nonce of the login travels with them.
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>()

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/.well-known/openid-configuration') {
        const issuer = options.issuer ?? url.origin
        return Response.json({
          issuer,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          jwks_uri: `${url.origin}/jwks`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
        })
      }

      if (url.pathname === '/jwks') {
        // The published key is always the key of the tenant: the broken
        // fixture signs with another one, so its tokens do not verify.
        const publicKey = createPublicKey(createPrivateKey(KEY.privateKey))
        const jwk = await exportJWK(publicKey)
        return Response.json({ keys: [{ ...jwk, kid: 'fixture-1', alg: 'RS256', use: 'sig' }] })
      }

      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const nonce = url.searchParams.get('nonce') ?? ''
        const challenge = url.searchParams.get('code_challenge') ?? ''
        const code = crypto.randomUUID()
        codes.set(code, { nonce, challenge, redirectUri })
        const location = new URL(redirectUri)
        location.searchParams.set('code', code)
        location.searchParams.set('state', state)
        return new Response(null, { status: 302, headers: { location: location.toString() } })
      }

      if (url.pathname === '/token') {
        exchanges += 1
        const body = await request.formData()
        const code = String(body.get('code') ?? '')
        const verifier = String(body.get('code_verifier') ?? '')
        const redirectUri = String(body.get('redirect_uri') ?? '')
        const record = codes.get(code)
        codes.delete(code)
        if (!record) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        if (record.redirectUri !== redirectUri) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        if (record.challenge) {
          const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url')
          if (challenge !== record.challenge) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
        }
        const issuer = options.issuer ?? url.origin
        const audience = options.audience === 'another-client' ? 'another-client' : clientId
        const nonce = options.nonce === 'another-nonce' ? 'another-nonce' : record.nonce
        const privateKey = createPrivateKey(
          options.signWith === 'another-key' ? OTHER_KEY.privateKey : KEY.privateKey
        )
        const idToken = await new SignJWT({
          sub: subject,
          iss: issuer,
          aud: audience,
          nonce,
          email,
          name,
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'fixture-1' })
          .sign(privateKey)
        return Response.json({
          access_token: 'the-access-token-of-the-provider',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        })
      }

      return new Response('not found', { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    issuer: `http://127.0.0.1:${server.port}`,
    clientId,
    clientSecret,
    subject,
    stop: async () => {
      await server.stop(true)
    },
    exchanges: () => exchanges,
  }
}
