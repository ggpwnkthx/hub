import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'
import {
  startProviderFixture,
  type FixtureOptions,
  type ProviderFixture,
} from '../fixtures/provider'

/** The token of the administration of the tests. */
const ADMIN_TOKEN = 'the-admin-token'
/** The redirect uri of the gateway of the tests. */
const GATEWAY_REDIRECT = 'https://shuttle-acme.example.com/auth/callback'

/** The private key of the service of the tests. */
const SIGNING_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

/**
 * Starts a deployment with one tenant and runs a login against it.
 *
 * The answer of the callback is what the test asserts: a page of a
 * refusal, with its code.
 */
async function login(options: {
  provider?: FixtureOptions
  /** Whether the tenant creates the principals that it does not know. */
  autoProvision?: boolean
  /** Whether the principal of the tenant is disabled. */
  disabled?: boolean
  /** Whether the identity of the caller is known to the platform. */
  known?: boolean
}): Promise<{ status: number; body: string }> {
  const provider = await startProviderFixture(options.provider)
  const runtime: HubRuntime = await createRuntime(
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
  const base = `http://127.0.0.1:${runtime.listener.port}`
  try {
    const admin = async (path: string, method: string, body: Record<string, unknown>) => {
      await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
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
      autoProvision: options.autoProvision ?? false,
    })
    if (options.known) {
      await admin('/v1/admin/users', 'POST', {
        tenant: 'acme',
        externalSubject: provider.subject,
        status: options.disabled ? 'disabled' : 'active',
      })
    }

    const query = new URLSearchParams({
      client_id: 'shuttle-acme',
      redirect_uri: GATEWAY_REDIRECT,
      response_type: 'code',
      scope: 'openid',
      state: 'the-state-of-the-gateway',
      nonce: 'the-nonce-of-the-gateway',
    })
    const authorize = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
      redirect: 'manual',
    })
    // The refusal can happen at the authorization: the provider of the
    // tenant is refused before the browser leaves Hub.
    if (authorize.status !== 302) {
      return { status: authorize.status, body: await authorize.text() }
    }
    const cookie = (authorize.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const atProvider = await fetch(authorize.headers.get('location') ?? '', {
      redirect: 'manual',
    })
    const callback = await fetch(atProvider.headers.get('location') ?? '', {
      redirect: 'manual',
      headers: { cookie },
    })
    return { status: callback.status, body: await callback.text() }
  } finally {
    await provider.stop()
    await runtime.listener.stop(true)
    await runtime.database.close()
  }
}

describe('the refusals of the login', () => {
  test('a token that is signed with another key is refused', async () => {
    const answer = await login({ provider: { signWith: 'another-key' } })
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('identity_rejected')
  })

  test('a provider that names another issuer is refused', async () => {
    const answer = await login({ provider: { issuer: 'https://another.example.com' } })
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('identity_rejected')
  })

  test('a token that is issued for another audience is refused', async () => {
    const answer = await login({ provider: { audience: 'another-client' } })
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('identity_rejected')
  })

  test('a token that carries another nonce is refused', async () => {
    const answer = await login({ provider: { nonce: 'another-nonce' } })
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('identity_rejected')
  })

  test('an identity that is not known is refused', async () => {
    const answer = await login({})
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('identity_unknown')
  })

  test('a principal that is disabled is refused', async () => {
    const answer = await login({ known: true, disabled: true })
    expect(answer.status).toBe(403)
    expect(answer.body).toContain('principal_disabled')
  })

  test('an identity that is not known is created when the tenant allows it', async () => {
    const answer = await login({ autoProvision: true })
    // The login succeeds: the browser comes back with a code and the
    // principal exists with no grant at all.
    expect(answer.status).toBe(302)
  })
})

describe('the provider of a tenant that is down', () => {
  test('the provider that cannot be reached is a refusal', async () => {
    const provider: ProviderFixture = await startProviderFixture()
    const url = provider.url
    await provider.stop()
    const runtime = await createRuntime(
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
    const base = `http://127.0.0.1:${runtime.listener.port}`
    try {
      await fetch(`${base}/v1/admin/tenants`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: 'acme',
          displayName: 'Acme Inc',
          issuer: url,
          idpClientId: 'hub-acme',
          idpClientSecret: 'secret',
          idpRedirectUri: `${base}/oauth/tenant/callback`,
          clientId: 'shuttle-acme',
          clientSecret: 'secret',
          clientRedirectUris: [GATEWAY_REDIRECT],
        }),
      })
      const query = new URLSearchParams({
        client_id: 'shuttle-acme',
        redirect_uri: GATEWAY_REDIRECT,
        response_type: 'code',
        scope: 'openid',
      })
      const authorize = await fetch(`${base}/oauth/authorize?${query.toString()}`, {
        redirect: 'manual',
      })
      expect(authorize.status).toBe(502)
      expect(await authorize.text()).toContain('upstream_unavailable')
    } finally {
      await runtime.listener.stop(true)
      await runtime.database.close()
    }
  })
})
