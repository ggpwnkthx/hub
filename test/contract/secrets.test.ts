import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/**
 * The rotation of the secrets of the deployment (spec §4.3).
 *
 * A secret that is presented by a client is rotated without a window in
 * which the client and the service disagree: the secret that is replaced
 * is accepted until the end of the window of the rotation, and the
 * deployment removes it afterwards.
 *
 * The secrets that are rotated here are the secret of the gateway of a
 * tenant, the token of the decisions and the token of the administration.
 */
const ADMIN_TOKEN = 'the-admin-token'
const PREVIOUS_ADMIN_TOKEN = 'the-previous-admin-token'
const ACCESS_TOKEN = 'the-access-token'
const PREVIOUS_ACCESS_TOKEN = 'the-previous-access-token'
const GATEWAY_SECRET = 'the-secret-of-the-gateway'
const NEXT_GATEWAY_SECRET = 'the-next-secret-of-the-gateway'

let runtime: HubRuntime
let base: string

/** Calls the administration with a token. */
async function admin(
  path: string,
  method: string,
  body: Record<string, unknown>,
  token: string = ADMIN_TOKEN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? ((JSON.parse(text) as Record<string, unknown>) ?? {}) : {},
  }
}

/** Asks for a decision with the credentials of the tenant. */
async function decideWith(
  clientId: string,
  clientSecret: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/v1/decisions`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ subject: '11111111-1111-4111-8111-111111111111' }),
  })
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  }
}

beforeAll(async () => {
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKEN: ADMIN_TOKEN,
      HUB_PREVIOUS_ADMIN_TOKEN: PREVIOUS_ADMIN_TOKEN,
      HUB_ACCESS_TOKEN: ACCESS_TOKEN,
      HUB_PREVIOUS_ACCESS_TOKEN: PREVIOUS_ACCESS_TOKEN,
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`

  await admin('/v1/admin/tenants', 'POST', {
    slug: 'acme',
    displayName: 'Acme Inc',
    issuer: 'https://login.acme.example',
    idpClientId: 'hub-acme',
    idpClientSecret: 'secret',
    clientId: 'shuttle-acme',
    clientSecret: GATEWAY_SECRET,
  })
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the rotation of the secrets of the deployment', () => {
  test('the token that the administration replaced is still accepted', async () => {
    const response = await admin('/v1/admin/tenants', 'GET', {}, PREVIOUS_ADMIN_TOKEN)
    expect(response.status).toBe(200)
  })

  test('a token that was never a token is refused', async () => {
    const response = await admin('/v1/admin/tenants', 'GET', {}, 'the-wrong-token')
    expect(response.status).toBe(401)
  })

  test('the token that the decisions replaced is still accepted', async () => {
    const response = await fetch(`${base}/v1/decisions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${PREVIOUS_ACCESS_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ subject: '11111111-1111-4111-8111-111111111111' }),
    })
    expect(response.status).toBe(200)
  })

  test('the secret of a gateway is accepted before the rotation', async () => {
    const response = await decideWith('shuttle-acme', GATEWAY_SECRET)
    expect(response.status).toBe(200)
  })

  test('the secret of a gateway is rotated', async () => {
    const response = await admin('/v1/admin/tenants', 'POST', {
      slug: 'acme',
      displayName: 'Acme Inc',
      issuer: 'https://login.acme.example',
      idpClientId: 'hub-acme',
      idpClientSecret: 'secret',
      clientId: 'shuttle-acme',
      clientSecret: NEXT_GATEWAY_SECRET,
    })
    expect(response.status).toBe(200)
  })

  test('the secret that the rotation replaced is still accepted', async () => {
    const response = await decideWith('shuttle-acme', GATEWAY_SECRET)
    expect(response.status).toBe(200)
  })

  test('the secret that is in use is accepted', async () => {
    const response = await decideWith('shuttle-acme', NEXT_GATEWAY_SECRET)
    expect(response.status).toBe(200)
  })

  test('a call that presents the secret that is in use is not a rotation', async () => {
    // The tenant is changed without changing its secret: the window of
    // the rotation that is in flight is not closed by an unrelated
    // change of the tenant.
    const response = await admin('/v1/admin/tenants', 'POST', {
      slug: 'acme',
      displayName: 'Acme Incorporated',
      issuer: 'https://login.acme.example',
      idpClientId: 'hub-acme',
      idpClientSecret: 'secret',
      clientId: 'shuttle-acme',
      clientSecret: NEXT_GATEWAY_SECRET,
    })
    expect(response.status).toBe(200)
    const accepted = await decideWith('shuttle-acme', GATEWAY_SECRET)
    expect(accepted.status).toBe(200)
  })

  test('a secret that was never a secret is refused', async () => {
    const response = await decideWith('shuttle-acme', 'the-wrong-secret')
    expect(response.status).toBe(401)
  })
})
