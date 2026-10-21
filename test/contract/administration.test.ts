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
      clientRedirectUris: ['https://shuttle-acme.example.com/auth/callback'],
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
      clientRedirectUris: ['https://shuttle-acme.example.com/auth/callback'],
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

describe('the lists of the administration', () => {
  test('the principals are listed with their total', async () => {
    const created = await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-the-list',
      email: 'listed@acme.example',
      displayName: 'Listed',
    })
    expect(created.status).toBe(201)

    const response = await call('/v1/admin/users?tenant=acme', 'GET')
    expect(response.status).toBe(200)
    const principals = response.body.principals as { id: string; tenant: string }[]
    expect(Array.isArray(principals)).toBe(true)
    expect(principals.some((row) => row.id === created.body.id)).toBe(true)
    expect(principals.every((row) => row.tenant === 'acme')).toBe(true)
    expect(response.body.total).toBe(principals.length)
    expect(response.body.limit).toBe(50)
    expect(response.body.offset).toBe(0)
  })

  test('the list of the principals is filtered and paginated', async () => {
    const filtered = await call('/v1/admin/users?tenant=acme&email=listed@acme.example', 'GET')
    expect(filtered.status).toBe(200)
    expect((filtered.body.principals as unknown[]).length).toBe(1)

    const page = await call('/v1/admin/users?tenant=acme&limit=1&offset=0', 'GET')
    expect(page.status).toBe(200)
    expect((page.body.principals as unknown[]).length).toBe(1)
    expect(page.body.limit).toBe(1)
  })

  test('a limit that is not understood is refused', async () => {
    const response = await call('/v1/admin/users?limit=many', 'GET')
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid_request')
  })

  test('a tenant that does not exist is a not found', async () => {
    const response = await call('/v1/admin/users?tenant=nowhere', 'GET')
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('not_found')
  })

  test('the grants are listed and they carry who granted them', async () => {
    const principal = await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-the-listed-grant',
    })
    const grant = await call('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      userId: principal.body.id,
      permission: 'workspace.read',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
      grantedBy: 'ops@acme.example',
    })
    expect(grant.status).toBe(200)
    expect(grant.body.grantedBy).toBe('ops@acme.example')

    const response = await call('/v1/admin/grants?tenant=acme', 'GET')
    expect(response.status).toBe(200)
    const grants = response.body.grants as { id: string; grantedBy: string | null }[]
    const listed = grants.find((row) => row.id === grant.body.id)
    expect(listed?.grantedBy).toBe('ops@acme.example')
    expect(response.body.total).toBe(grants.length)
  })

  test('the list of the grants knows the live ones from the dead ones', async () => {
    const live = await call('/v1/admin/grants?tenant=acme&live=true', 'GET')
    expect(live.status).toBe(200)
    expect(
      (live.body.grants as { revokedAt: string | null }[]).every((row) => row.revokedAt === null)
    ).toBe(true)

    const dead = await call('/v1/admin/grants?tenant=acme&live=false', 'GET')
    expect(dead.status).toBe(200)
    expect((dead.body.grants as unknown[]).length).toBeGreaterThan(0)
  })

  test('the lists are behind the token of the administration', async () => {
    const withoutToken = await call('/v1/admin/users', 'GET', undefined, { token: null })
    expect(withoutToken.status).toBe(401)
    const wrongToken = await call('/v1/admin/grants', 'GET', undefined, { token: 'wrong' })
    expect(wrongToken.status).toBe(401)
  })
})

describe('the groups of the administration', () => {
  test('a group is created with its members', async () => {
    const member = await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-a-member',
      email: 'member@acme.example',
    })
    expect(member.status).toBe(201)

    const response = await call('/v1/admin/groups', 'POST', {
      tenant: 'acme',
      key: 'team-platform',
      displayName: 'The platform team',
      members: ['the-subject-of-a-member'],
    })
    expect(response.status).toBe(201)
    expect(response.body.key).toBe('team-platform')
    expect(response.body.members).toEqual(['the-subject-of-a-member'])
  })

  test('the groups of a tenant are listed', async () => {
    const response = await call('/v1/admin/groups?tenant=acme', 'GET')
    expect(response.status).toBe(200)
    const groups = response.body.groups as { key: string; members: string[] }[]
    expect(Array.isArray(groups)).toBe(true)
    expect(groups.some((row) => row.key === 'team-platform')).toBe(true)
    expect(response.body.total).toBeGreaterThan(0)
  })

  test('the list of the groups is filtered by the key', async () => {
    const response = await call('/v1/admin/groups?tenant=acme&key=team-platform', 'GET')
    expect(response.status).toBe(200)
    const groups = response.body.groups as { key: string }[]
    expect(groups.length).toBe(1)
    expect(groups[0]!.key).toBe('team-platform')
  })

  test('the list of the groups of a tenant that does not exist is a not found', async () => {
    const response = await call('/v1/admin/groups?tenant=nowhere', 'GET')
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('not_found')
  })

  test('the membership is replaced by the second call', async () => {
    await call('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-the-second-member',
    })
    const response = await call('/v1/admin/groups', 'POST', {
      tenant: 'acme',
      key: 'team-platform',
      members: ['the-subject-of-the-second-member'],
    })
    expect(response.status).toBe(200)
    expect(response.body.members).toEqual(['the-subject-of-the-second-member'])
  })

  test('a member that is not a principal is a not found', async () => {
    const response = await call('/v1/admin/groups', 'POST', {
      tenant: 'acme',
      key: 'team-unknown',
      members: ['the-subject-that-does-not-exist'],
    })
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('not_found')
  })

  test('a grant of a group names the group', async () => {
    const response = await call('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      group: 'team-platform',
      permission: 'workspace.team',
      workspaceId: '11111111-1111-4111-8111-111111111111',
      routeId: 'workspace-api',
    })
    expect(response.status).toBe(200)
    expect(response.body.group).toBe('team-platform')
    expect(response.body.userId).toBeNull()
  })

  test('a grant that names a principal and a group is refused', async () => {
    const response = await call('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      userId: '33333333-3333-4333-8333-333333333333',
      group: 'team-platform',
      permission: 'workspace.both',
    })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid_request')
  })

  test('a grant that names neither a principal nor a group is refused', async () => {
    const response = await call('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      permission: 'workspace.neither',
    })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid_request')
  })

  test('a grant of a group that does not exist is a not found', async () => {
    const response = await call('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      group: 'team-that-does-not-exist',
      permission: 'workspace.nowhere',
    })
    expect(response.status).toBe(404)
    expect(response.body.error).toBe('not_found')
  })
})
