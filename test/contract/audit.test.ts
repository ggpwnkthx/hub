import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/**
 * The audit of the administration (spec §10.1).
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

describe('the export of the audit', () => {
  /** Reads the export of the audit, in a format. */
  async function exported(format: string, query = ''): Promise<Response> {
    return await fetch(`${base}/v1/admin/audit?format=${format}${query}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
  }

  test('the export in CSV carries the header and the rows', async () => {
    const response = await exported('csv')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(response.headers.get('content-disposition')).toContain('attachment')

    const text = await response.text()
    const lines = text.trim().split('\n')
    expect(lines[0]).toBe('id,at,action,targetId,tenant,operator,address,requestId')
    expect(lines.length).toBeGreaterThan(1)
    // The rows are the rows of the audit.
    const body = await audit('?limit=200')
    const records = body.records as Record<string, unknown>[]
    expect(lines.length - 1).toBe(records.length)
    expect(lines[1]).toContain(records[0]!.action as string)
  })

  test('the export in JSON Lines carries one object per line', async () => {
    const response = await exported('jsonl')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/x-ndjson')

    const text = await response.text()
    const lines = text.trim().split('\n')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>
      expect(typeof record.action).toBe('string')
      expect(typeof record.at).toBe('string')
    }
  })

  test('the export carries the filter of the list', async () => {
    const response = await exported('csv', '&action=grant.revoked')
    const text = await response.text()
    const lines = text.trim().split('\n').slice(1)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toContain('grant.revoked')
    }
  })

  test('a format that is not known is refused', async () => {
    const response = await exported('xml')
    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.error).toBe('invalid_request')
  })

  test('the export needs the token of the administration', async () => {
    const response = await fetch(`${base}/v1/admin/audit?format=csv`)
    expect(response.status).toBe(401)
  })
})
