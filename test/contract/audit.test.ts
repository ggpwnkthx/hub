import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/**
 * The audit of the administration (spec §9.1).
 *
 * The audit is what an operator of the platform asks for when a grant
 * appears that nobody remembers: who changed it, when, and from which
 * address. It is a table, not only a line of a log, and it is read
 * through the administration.
 */
const ADMIN_TOKEN = 'the-admin-token'

let runtime: HubRuntime
let base: string

/** Calls the administration. */
async function admin(
  path: string,
  method: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? ((JSON.parse(text) as Record<string, unknown>) ?? {}) : {},
  }
}

/** The rows of the audit, as they are published. */
async function audit(query = ''): Promise<Record<string, unknown>> {
  const response = await admin(`/v1/admin/audit${query}`, 'GET')
  return response.body
}

beforeAll(async () => {
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKEN: ADMIN_TOKEN,
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`

  await admin('/v1/admin/tenants', 'POST', {
    slug: 'acme',
    displayName: 'Acme Inc',
    issuer: 'https://login.acme.example',
    idpClientId: 'hub-acme',
    idpClientSecret: 'the-secret-of-the-provider',
    clientId: 'shuttle-acme',
    clientSecret: 'the-secret-of-the-gateway',
    clientRedirectUris: ['https://shuttle-acme.example.com/auth/callback'],
  })
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the audit of the administration', () => {
  test('the creation of a tenant is audited', async () => {
    const body = await audit('?tenant=acme')
    const records = body.records as Record<string, unknown>[]
    expect(records.length).toBeGreaterThan(0)
    expect(records[0]!.action).toBe('tenant.created')
    expect(records[0]!.tenant).toBe('acme')
  })

  test('the audit names the operator by the fingerprint of its credential', async () => {
    const body = await audit('?tenant=acme')
    const records = body.records as Record<string, unknown>[]
    // The fingerprint is the first twelve characters of the digest of the
    // token: it names the operator and it is not the token.
    expect(records[0]!.operator).toMatch(/^[0-9a-f]{12}$/)
    expect(records[0]!.operator).not.toBe(ADMIN_TOKEN)
    expect(records[0]!.address).toBeTruthy()
    expect(records[0]!.requestId).toBeTruthy()
  })

  test('the change of a principal is audited', async () => {
    await admin('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject',
    })
    const body = await audit('?tenant=acme')
    const actions = (body.records as Record<string, unknown>[]).map((record) => record.action)
    expect(actions).toContain('principal.created')
  })

  test('the revocation of a grant is audited', async () => {
    const principal = await admin('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-a-grant',
    })
    const grant = await admin('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      userId: principal.body.id,
      permission: 'workspace.read',
      workspaceId: 'the-workspace',
    })
    const id = grant.body.id as string
    const response = await fetch(`${base}/v1/admin/grants/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    expect(response.status).toBe(204)
    const body = await audit('?tenant=acme')
    const actions = (body.records as Record<string, unknown>[]).map((record) => record.action)
    expect(actions).toContain('grant.created')
    expect(actions).toContain('grant.revoked')
  })

  test('the row of the audit names the thing that changed', async () => {
    const principal = await admin('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: 'the-subject-of-a-named-thing',
    })
    const body = await audit('?action=principal.created')
    const records = body.records as Record<string, unknown>[]
    expect(records.length).toBeGreaterThan(0)
    // The target of the audit is the row that the change wrote: the
    // identifier is never one that a caller named.
    expect(records[0]!.targetId).toBe(principal.body.id)
  })

  test('the audit is filtered by the action', async () => {
    const body = await audit('?action=grant.revoked')
    const records = body.records as Record<string, unknown>[]
    expect(records.length).toBeGreaterThan(0)
    for (const record of records) {
      expect(record.action).toBe('grant.revoked')
    }
  })

  test('the audit of a tenant that does not exist is a not found', async () => {
    const response = await admin('/v1/admin/audit?tenant=nowhere', 'GET')
    expect(response.status).toBe(404)
  })

  test('the audit needs the token of the administration', async () => {
    const response = await fetch(`${base}/v1/admin/audit`)
    expect(response.status).toBe(401)
  })
})
