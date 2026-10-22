import { createHash, generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'
import { startProviderFixture, type ProviderFixture } from '../fixtures/provider'

/**
 * The shared client (spec §5.2).
 *
 * A shared client is the escape hatch of the topology of §1.4: one
 * gateway, several tenants. The gateway presents one client id, and the
 * tenant of the login is named by the parameter of the request.
 *
 * The code of the login belongs to the **client** that began it, and not
 * to the tenant of the login: the gateway exchanges the code with the
 * client id and the secret it is registered with, and the audience of
 * the tokens is that client id. This file proves that a login of another
 * tenant is exchanged by the client that began it.
 */

/** The token of the administration of the tests. */
const ADMIN_TOKEN = 'the-admin-token'
/** The redirect uri of the gateway of the tests. */
const GATEWAY_REDIRECT = 'https://shuttle-acme.example.com/auth/callback'
/** The verifier of the PKCE of the gateway of the tests. */
const VERIFIER = 'the-verifier-of-the-gateway'
/** The challenge of the PKCE of the gateway of the tests. */
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url')

/** The private key of the service of the tests. */
const SIGNING_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

let runtime: HubRuntime
let base: string
let provider: ProviderFixture

/** Calls the administration of the tests. */
async function admin(
  path: string,
  method: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return (await response.json()) as Record<string, unknown>
}

/** The cookie of a response, as the browser would keep it. */
function cookieOf(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

/**
 * A login of another tenant, begun by the shared client.
 *
 * The browser goes to the authorization of Hub, then to the provider and
 * then back to the callback of Hub.
 */
async function loginOfTheOtherTenant(): Promise<string> {
  const query = new URLSearchParams({
    client_id: 'shuttle-acme',
    redirect_uri: GATEWAY_REDIRECT,
    response_type: 'code',
    scope: 'openid profile email',
    state: 'the-state-of-the-gateway',
    nonce: 'the-nonce-of-the-gateway',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    tenant: 'other',
  })
  const authorize = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
    redirect: 'manual',
  })
  expect(authorize.status).toBe(302)
  const cookie = cookieOf(authorize)
  const atProvider = await fetch(authorize.headers.get('location') ?? '', { redirect: 'manual' })
  const callback = await fetch(atProvider.headers.get('location') ?? '', {
    redirect: 'manual',
    headers: { cookie },
  })
  expect(callback.status).toBe(302)
  const location = new URL(callback.headers.get('location') ?? '')
  return location.searchParams.get('code') ?? ''
}

/** Exchanges a code with the credentials of a client. */
async function exchange(code: string, credentials: string): Promise<Response> {
  return await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: GATEWAY_REDIRECT,
      code_verifier: VERIFIER,
    }).toString(),
  })
}

beforeAll(async () => {
  provider = await startProviderFixture()
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKEN: ADMIN_TOKEN,
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
      HUB_STATE_SECRET: 'b'.repeat(64),
      HUB_ISSUER: 'https://hub.example.com',
      HUB_SIGNING_KEY: SIGNING_KEY,
      HUB_SIGNING_KID: 'hub-1',
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`

  // The tenant that owns the client: the one the gateway is registered
  // with, and the one whose client is shared.
  await admin('/v1/admin/tenants', 'POST', {
    slug: 'acme',
    displayName: 'Acme Inc',
    issuer: provider.issuer,
    idpClientId: provider.clientId,
    idpClientSecret: provider.clientSecret,
    idpRedirectUri: `${base}/oauth/tenant/callback`,
    clientId: 'shuttle-acme',
    clientSecret: 'the-secret-of-the-gateway',
    clientRedirectUris: [GATEWAY_REDIRECT],
    sharedClient: true,
  })
  // The tenant that the parameter of the request names.
  await admin('/v1/admin/tenants', 'POST', {
    slug: 'other',
    displayName: 'Other Inc',
    issuer: provider.issuer,
    idpClientId: provider.clientId,
    idpClientSecret: provider.clientSecret,
    idpRedirectUri: `${base}/oauth/tenant/callback`,
    clientId: 'shuttle-other',
    clientSecret: 'the-secret-of-the-other-gateway',
    clientRedirectUris: [],
  })
  await admin('/v1/admin/users', 'POST', {
    tenant: 'other',
    externalSubject: provider.subject,
    email: 'alice@other.example',
    displayName: 'Alice',
  })
})

afterAll(async () => {
  await provider.stop()
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the shared client', () => {
  test('the code of a login of another tenant is exchanged by the client that began it', async () => {
    const code = await loginOfTheOtherTenant()
    expect(code).toBeTruthy()

    const token = await exchange(code, 'shuttle-acme:the-secret-of-the-gateway')
    const body = (await token.json()) as Record<string, unknown>
    expect(token.status).toBe(200)
    expect(typeof body.id_token).toBe('string')
    expect(typeof body.access_token).toBe('string')
  })

  test('the audience of the tokens is the client and the tenant is the tenant of the login', async () => {
    const code = await loginOfTheOtherTenant()
    const token = await exchange(code, 'shuttle-acme:the-secret-of-the-gateway')
    expect(token.status).toBe(200)
    const body = (await token.json()) as Record<string, unknown>

    // The claims of the id token, read without verifying the signature:
    // the audience is the client that the gateway is registered with, and
    // the tenant is the tenant that the parameter of the request named.
    const payload = JSON.parse(
      Buffer.from(String(body.id_token).split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as { aud?: string; tid?: string }
    expect(payload.aud).toBe('shuttle-acme')
    expect(payload.tid).toBe('other')
  })

  test('the code of a login of another tenant is not exchanged by another client', async () => {
    const code = await loginOfTheOtherTenant()
    const token = await exchange(code, 'shuttle-other:the-secret-of-the-other-gateway')
    const body = (await token.json()) as Record<string, unknown>
    expect(token.status).toBe(400)
    expect(body.error).toBe('invalid_grant')
  })
})
