import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/** The credential of the operator of the platform. */
const PLATFORM_TOKEN = 'the-token-of-the-operator-of-the-platform'

/** The credential of the operator of the tenant `acme`. */
const ACME_TOKEN = 'the-token-of-the-operator-of-acme'

/** The credential of the operator of the tenant `other`. */
const OTHER_TOKEN = 'the-token-of-the-operator-of-other'

let runtime: HubRuntime
let base: string

/** Calls the administration with a credential. */
async function call(
  path: string,
  method: string,
  body?: unknown,
  token: string = PLATFORM_TOKEN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: (parsed ?? {}) as Record<string, unknown> }
}

/** The registration of a tenant. */
function tenant(slug: string, clientId: string) {
  return {
    slug,
    displayName: slug,
    issuer: `https://login.${slug}.example`,
    idpClientId: `hub-${slug}`,
    idpClientSecret: `the-secret-of-the-provider-of-${slug}`,
    idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
    emailDomain: `${slug}.example`,
    clientId,
    clientSecret: `the-secret-of-the-gateway-of-${slug}`,
    clientRedirectUris: [`https://${clientId}.example.com/auth/callback`],
  }
}

beforeAll(async () => {
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKENS: JSON.stringify({
        [PLATFORM_TOKEN]: null,
        [ACME_TOKEN]: { tenant: 'acme', operator: 'alice' },
        [OTHER_TOKEN]: { tenant: 'other', operator: 'bob' },
      }),
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`

  await call('/v1/admin/tenants', 'POST', tenant('acme', 'shuttle-acme'))
  await call('/v1/admin/tenants', 'POST', tenant('other', 'shuttle-other'))
  await call('/v1/admin/users', 'POST', { tenant: 'acme', externalSubject: 'alice' })
  await call('/v1/admin/users', 'POST', { tenant: 'other', externalSubject: 'bob' })
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the credentials of the administration', () => {
  test('the credential of the platform acts for every tenant', async () => {
    const response = await call('/v1/admin/tenants', 'GET')
    expect(response.status).toBe(200)
    expect((response.body.tenants as { slug: string }[]).map((row) => row.slug).sort()).toEqual([
      'acme',
      'other',
    ])
  })

  test('the credential of a tenant acts for that tenant', async () => {
    const response = await call('/v1/admin/tenants', 'GET', undefined, ACME_TOKEN)
    expect(response.status).toBe(200)
    expect((response.body.tenants as { slug: string }[]).map((row) => row.slug)).toEqual(['acme'])
  })

  test('the credential of a tenant may not act for another tenant', async () => {
    const response = await call(
      '/v1/admin/users',
      'POST',
      { tenant: 'other', externalSubject: 'mallory' },
      ACME_TOKEN
    )
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('forbidden')
  })

  test('the credential of a tenant may not create a tenant', async () => {
    const response = await call(
      '/v1/admin/tenants',
      'POST',
      tenant('third', 'shuttle-third'),
      ACME_TOKEN
    )
    expect(response.status).toBe(403)
  })

  test('the credential of a tenant may not change another tenant', async () => {
    const response = await call(
      '/v1/admin/tenants',
      'POST',
      tenant('other', 'shuttle-other'),
      ACME_TOKEN
    )
    expect(response.status).toBe(403)
  })

  test('the credential of a tenant may not change the shared client of its tenant', async () => {
    // The shared client of a tenant moves the logins of the platform and
    // lifts the scope of the decisions of its gateway: it belongs to the
    // operator of the platform.
    const response = await call(
      '/v1/admin/tenants',
      'POST',
      { ...tenant('acme', 'shuttle-acme'), sharedClient: true },
      ACME_TOKEN
    )
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('forbidden')
  })

  test('the credential of a tenant may not change the default tenant of the platform', async () => {
    const response = await call(
      '/v1/admin/tenants',
      'POST',
      { ...tenant('acme', 'shuttle-acme'), default: true },
      ACME_TOKEN
    )
    expect(response.status).toBe(403)
    expect(response.body.error).toBe('forbidden')
  })

  test('the credential of a tenant changes its tenant with the flags it already has', async () => {
    const response = await call(
      '/v1/admin/tenants',
      'POST',
      { ...tenant('acme', 'shuttle-acme'), displayName: 'Acme Renamed' },
      ACME_TOKEN
    )
    expect(response.status).toBe(200)
    expect(response.body.displayName).toBe('Acme Renamed')
    expect(response.body.sharedClient).toBe(false)
  })

  test('the credential of the platform changes the shared client', async () => {
    const response = await call(
      '/v1/admin/tenants',
      'POST',
      { ...tenant('other', 'shuttle-other'), sharedClient: true },
      PLATFORM_TOKEN
    )
    expect(response.status).toBe(200)
    expect(response.body.sharedClient).toBe(true)
  })

  test('the list of the principals of a credential is the list of its tenant', async () => {
    const response = await call('/v1/admin/users', 'GET', undefined, ACME_TOKEN)
    expect(response.status).toBe(200)
    const principals = response.body.principals as { tenant: string }[]
    expect(principals.length).toBe(1)
    expect(principals[0]!.tenant).toBe('acme')
  })

  test('the filter of a query cannot widen the scope of a credential', async () => {
    const response = await call('/v1/admin/users?tenant=other', 'GET', undefined, ACME_TOKEN)
    expect(response.status).toBe(200)
    const principals = response.body.principals as { tenant: string }[]
    expect(principals.length).toBe(1)
    expect(principals[0]!.tenant).toBe('acme')
  })

  test('the audit of a change names the operator of the credential', async () => {
    await call(
      '/v1/admin/users',
      'POST',
      { tenant: 'acme', externalSubject: 'alice', email: 'alice@acme.example' },
      ACME_TOKEN
    )
    const response = await call('/v1/admin/audit?tenant=acme', 'GET', undefined, ACME_TOKEN)
    expect(response.status).toBe(200)
    const records = response.body.records as { operator: string; tenant: string }[]
    expect(records.length).toBeGreaterThan(0)
    expect(records[0]!.operator).toBe('alice')
    expect(records[0]!.tenant).toBe('acme')
  })

  test('the audit of a credential of a tenant holds no other tenant', async () => {
    const response = await call('/v1/admin/audit', 'GET', undefined, ACME_TOKEN)
    expect(response.status).toBe(200)
    const records = response.body.records as { tenant: string }[]
    expect(records.every((record) => record.tenant === 'acme')).toBe(true)
  })

  test('a credential that is not one of the deployment is refused', async () => {
    const response = await call('/v1/admin/tenants', 'GET', undefined, 'a-token-of-nobody')
    expect(response.status).toBe(401)
  })
})
