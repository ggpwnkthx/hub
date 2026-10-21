import { createHash, generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'
import { startProviderFixture, type ProviderFixture } from '../fixtures/provider'

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
  const header = response.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}

/**
 * Starts a login and follows it until the callback.
 *
 * The browser goes to the authorization of Hub, then to the provider and
 * then back to the callback of Hub.
 */
async function startLogin(
  options: { clientId?: string; tenant?: string; scope?: string } = {}
): Promise<{ response: Response; cookie: string }> {
  const query = new URLSearchParams({
    client_id: options.clientId ?? 'shuttle-acme',
    redirect_uri: GATEWAY_REDIRECT,
    response_type: 'code',
    scope: options.scope ?? 'openid profile email',
    state: 'the-state-of-the-gateway',
    nonce: 'the-nonce-of-the-gateway',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...(options.tenant ? { tenant: options.tenant } : {}),
  })
  const authorize = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
    redirect: 'manual',
  })
  const cookie = cookieOf(authorize)
  if (authorize.status !== 302) return { response: authorize, cookie }
  const location = authorize.headers.get('location') ?? ''
  const atProvider = await fetch(location, { redirect: 'manual' })
  const callback = atProvider.headers.get('location') ?? ''
  const response = await fetch(callback, {
    redirect: 'manual',
    headers: { cookie },
  })
  return { response, cookie }
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

  await admin('/v1/admin/tenants', 'POST', {
    slug: 'acme',
    displayName: 'Acme Inc',
    issuer: provider.issuer,
    idpClientId: provider.clientId,
    idpClientSecret: provider.clientSecret,
    idpRedirectUri: `${base}/oauth/tenant/callback`,
    clientId: 'shuttle-acme',
    clientSecret: 'the-secret-of-the-gateway',
    clientRedirectUris: ['https://shuttle-acme.example.com/auth/callback'],
  })
  await admin('/v1/admin/users', 'POST', {
    tenant: 'acme',
    externalSubject: provider.subject,
    email: 'alice@acme.example',
    displayName: 'Alice',
  })
})

afterAll(async () => {
  await provider.stop()
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the login of Hub', () => {
  test('a browser logs in at the provider and comes back with a code', async () => {
    const { response } = await startLogin()
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe(GATEWAY_REDIRECT)
    expect(location.searchParams.get('code')).toBeTruthy()
    expect(location.searchParams.get('state')).toBe('the-state-of-the-gateway')
  })

  test('a redirect uri that is not registered is refused', async () => {
    // The url the browser comes back to is a value the caller controls:
    // one that is not registered for the client is never sent a code, and
    // the browser is not sent to it either.
    const query = new URLSearchParams({
      client_id: 'shuttle-acme',
      redirect_uri: 'https://evil.example/steal',
      response_type: 'code',
      scope: 'openid',
      state: 'the-state-of-the-gateway',
    })
    const response = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
      redirect: 'manual',
    })
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('invalid_request')
  })

  test('the state cookie is deleted by the callback', async () => {
    const { response } = await startLogin()
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('hub_login_state=')
    expect(cookie).toContain('Max-Age=0')
  })

  test('the gateway exchanges the code for the tokens', async () => {
    const { response } = await startLogin()
    const location = new URL(response.headers.get('location') ?? '')
    const code = location.searchParams.get('code') ?? ''
    const token = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('shuttle-acme:the-secret-of-the-gateway').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: GATEWAY_REDIRECT,
        code_verifier: VERIFIER,
      }).toString(),
    })
    expect(token.status).toBe(200)
    const body = (await token.json()) as Record<string, unknown>
    expect(typeof body.id_token).toBe('string')
    expect(typeof body.access_token).toBe('string')
    expect(body.token_type).toBe('Bearer')
    expect(body.expires_in).toBe(300)
  })

  test('the same code exchanged twice is refused', async () => {
    const { response } = await startLogin()
    const location = new URL(response.headers.get('location') ?? '')
    const code = location.searchParams.get('code') ?? ''
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: GATEWAY_REDIRECT,
      code_verifier: VERIFIER,
    }).toString()
    const headers = {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('shuttle-acme:the-secret-of-the-gateway').toString('base64')}`,
    }
    expect((await fetch(`${base}/oauth/token`, { method: 'POST', headers, body })).status).toBe(200)
    const second = await fetch(`${base}/oauth/token`, { method: 'POST', headers, body })
    expect(second.status).toBe(400)
    expect(((await second.json()) as Record<string, unknown>).error).toBe('invalid_grant')
  })

  test('a client with a wrong secret is refused', async () => {
    const { response } = await startLogin()
    const location = new URL(response.headers.get('location') ?? '')
    const token = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('shuttle-acme:wrong').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: location.searchParams.get('code') ?? '',
        redirect_uri: GATEWAY_REDIRECT,
      }).toString(),
    })
    expect(token.status).toBe(401)
  })

  test('a code exchanged with another redirect uri is refused', async () => {
    const { response } = await startLogin()
    const location = new URL(response.headers.get('location') ?? '')
    const token = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('shuttle-acme:the-secret-of-the-gateway').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: location.searchParams.get('code') ?? '',
        redirect_uri: 'https://shuttle-acme.example.com/auth/other',
      }).toString(),
    })
    expect(token.status).toBe(400)
    expect(((await token.json()) as Record<string, unknown>).error).toBe('invalid_grant')
  })

  test('a login without the state cookie is refused', async () => {
    const query = new URLSearchParams({
      client_id: 'shuttle-acme',
      redirect_uri: GATEWAY_REDIRECT,
      response_type: 'code',
      scope: 'openid',
      state: 'the-state-of-the-gateway',
    })
    const authorize = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
      redirect: 'manual',
    })
    const atProvider = await fetch(authorize.headers.get('location') ?? '', { redirect: 'manual' })
    const callback = await fetch(atProvider.headers.get('location') ?? '', { redirect: 'manual' })
    expect(callback.status).toBe(400)
    expect(await callback.text()).toContain('login_state_invalid')
  })

  test('a client that names no tenant is refused', async () => {
    const query = new URLSearchParams({
      client_id: 'shuttle-unknown',
      redirect_uri: GATEWAY_REDIRECT,
      response_type: 'code',
      scope: 'openid',
    })
    const authorize = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
      redirect: 'manual',
    })
    expect(authorize.status).toBe(400)
    expect(await authorize.text()).toContain('invalid_request')
  })
})
