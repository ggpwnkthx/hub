import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/** The token of the administration of the tests. */
const TOKEN = 'the-admin-token'

let runtime: HubRuntime
let base: string

/** Calls the administration. */
async function call(
  path: string,
  method: string,
  body?: unknown,
  options: { token?: string | null; raw?: string } = {}
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(options.raw !== undefined
      ? { body: options.raw }
      : body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return {
    status: response.status,
    body: (parsed ?? {}) as Record<string, unknown>,
    headers: response.headers,
  }
}

beforeAll(async () => {
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKEN: TOKEN,
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the administration of Hub', () => {
  test('a tenant is created and the answer carries no secret', async () => {
    const response = await call('/v1/admin/tenants', 'POST', {
      slug: 'acme',
      displayName: 'Acme Inc',
      issuer: 'https://login.acme.example',
      idpClientId: 'hub-acme',
      idpClientSecret: 'the-secret-of-the-provider',
      idpRedirectUri: 'https://hub.example.com/oauth/tenant/callback',
      emailDomain: 'acme.example',
      clientId: 'shuttle-acme',
      clientSecret: 'the-secret-of-the-gateway',
    })
    expect(response.status).toBe(201)
    expect(response.body.slug).toBe('acme')
    expect(response.body.clientId).toBe('shuttle-acme')
    expect(response.body.default).toBe(false)
    expect(response.body.enabled).toBe(true)
    expect(JSON.stringify(response.body)).not.toContain('the-secret-of-the-provider')
    expect(JSON.stringify(response.body)).not.toContain('the-secret-of-the-gateway')
    expect(response.body.id).toBeTruthy()
  })

  test('the same slug changes the tenant', async () => {
    const response = await call('/v1/admin/tenants', 'POST', {
      slug: 'acme',
      displayName: 'Acme Incorporated',
      issuer: 'https://login.acme.example',
      idpClientId: 'hub-acme',
      idpClientSecret: 'the-secret-of-the-provider',
      clientId: 'shuttle-acme',
      clientSecret: 'the-secret-of-the-gateway',
    })
    expect(response.status).toBe(200)
    expect(response.body.displayName).toBe('Acme Incorporated')
  })

  test('a client id that belongs to another tenant is a conflict', async () => {
    const response = await call('/v1/admin/tenants', 'POST', {
      slug: 'another',
      displayName: 'Another',
      issuer: 'https://login.another.example',
      idpClientId: 'hub-another',
      idpClientSecret: 'secret',
      clientId: 'shuttle-acme',
      clientSecret: 'secret',
    })
    expect(response.status).toBe(409)
    expect(response.body.error).toBe('conflict')
  })

  test('the tenants are listed with their numbers', async () => {
    const response = await call('/v1/admin/tenants', 'GET')
    expect(response.status).toBe(200)
    expect(Array.isArray(response.body.tenants)).toBe(true)
    const listed = response.body.tenants as {
      slug: string
      userCount: number
      grantCount: number
    }[]
    const acme = listed.find((tenant) => tenant.slug === 'acme')!
    expect(acme.userCount).toBe(0)
    expect(acme.grantCount).toBe(0)
  })

  test('a principal is created and then changed', async () => {
    const created = await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: '00u1a2b3c4d5',
      email: 'alice@acme.example',
      displayName: 'Alice',
    })
    expect(created.status).toBe(201)
    expect(created.body.tenant).toBe('acme')
    expect(created.body.status).toBe('active')

    const updated = await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: '00u1a2b3c4d5',
      status: 'disabled',
    })
    expect(updated.status).toBe(200)
    expect(updated.body.status).toBe('disabled')
  })

  test('a principal of an unknown tenant is a not found', async () => {
    const response = await call('/v1/admin/users', 'POST', {
      tenant: 'unknown',
      externalSubject: 'sub',
    })
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('not_found')
  })

  test('a grant is created and the permission is created on demand', async () => {
    const principal = await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-a-grant',
    })
    const response = await call('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      userId: principal.body.id,
      permission: 'workspace.read',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
    })
    expect(response.status).toBe(200)
    expect(response.body.permission).toBe('workspace.read')
    expect(response.body.workspaceId).toBe('11111111-1111-4111-8111-111111111111')
    expect(response.body.revokedAt).toBeNull()
  })

  test('a grant is revoked and the revocation is idempotent', async () => {
    const principal = await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-a-revocation',
    })
    const grant = await call('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      userId: principal.body.id,
      permission: 'workspace.write',
    })
    const revoked = await call(`/v1/admin/grants/${grant.body.id}`, 'DELETE')
    expect(revoked.status).toBe(204)
    const again = await call(`/v1/admin/grants/${grant.body.id}`, 'DELETE')
    expect(again.status).toBe(204)
  })

  test('a grant that does not exist is a not found', async () => {
    const response = await call('/v1/admin/grants/does-not-exist', 'DELETE')
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('not_found')
  })

  test('a call without a token is refused', async () => {
    const response = await call('/v1/admin/tenants', 'GET', undefined, { token: null })
    expect(response.status).toBe(401)
    expect(response.body.error).toBe('unauthorized')
  })

  test('a call with a wrong token is refused', async () => {
    const response = await call('/v1/admin/tenants', 'GET', undefined, { token: 'wrong' })
    expect(response.status).toBe(401)
  })

  test('a body that is not json is refused', async () => {
    const response = await call('/v1/admin/tenants', 'POST', undefined, { raw: 'not json' })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid_request')
  })

  test('a body that does not match the schema is refused', async () => {
    const response = await call('/v1/admin/tenants', 'POST', { slug: 'ACME', displayName: 'x' })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid_request')
    expect(response.body.message).toContain('slug')
  })

  test('a body that is too large is refused', async () => {
    const response = await call('/v1/admin/tenants', 'POST', undefined, {
      raw: JSON.stringify({ slug: 'acme', displayName: 'x'.repeat(70_000) }),
    })
    expect(response.status).toBe(413)
    expect(response.body.error).toBe('invalid_request')
  })
})
