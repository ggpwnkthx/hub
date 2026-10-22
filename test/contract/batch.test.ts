import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/**
 * The batch of the administration (spec §10.4, §10.6).
 *
 * A batch is the call that onboards a tenant: one call writes a hundred
 * principals instead of a hundred calls. It is the **same** endpoint and
 * the same administration surface: the body carries the list, and the
 * answer names the outcome of every item.
 *
 * Every item is written on its own: the change of an item and the row of
 * its audit are one statement, so an item that is written is audited and
 * an item that fails leaves nothing behind.
 */

/** The token of the administration of the tests. */
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
    idpClientSecret: 'secret',
    idpRedirectUri: `${base}/oauth/tenant/callback`,
    clientId: 'shuttle-acme',
    clientSecret: 'secret',
  })
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the batch of the principals', () => {
  test('a batch writes every principal of the list', async () => {
    const response = await admin('/v1/admin/users', 'POST', {
      principals: [
        { tenant: 'acme', externalSubject: 'the-subject-1', email: 'one@acme.example' },
        { tenant: 'acme', externalSubject: 'the-subject-2', email: 'two@acme.example' },
        { tenant: 'acme', externalSubject: 'the-subject-3', displayName: 'Three' },
      ],
    })
    expect(response.status).toBe(200)
    const principals = response.body.principals as Record<string, unknown>[]
    expect(principals.length).toBe(3)
    for (const principal of principals) {
      expect(principal.created).toBe(true)
      expect(typeof principal.id).toBe('string')
      expect(principal.error).toBeUndefined()
    }
  })

  test('the principals of the batch exist', async () => {
    const list = await admin('/v1/admin/users?tenant=acme', 'GET')
    const principals = list.body.principals as Record<string, unknown>[]
    const subjects = principals.map((principal) => principal.externalSubject)
    expect(subjects).toContain('the-subject-1')
    expect(subjects).toContain('the-subject-3')
  })

  test('the batch is idempotent', async () => {
    const response = await admin('/v1/admin/users', 'POST', {
      principals: [{ tenant: 'acme', externalSubject: 'the-subject-1' }],
    })
    expect(response.status).toBe(200)
    const principals = response.body.principals as Record<string, unknown>[]
    expect(principals[0]!.created).toBe(false)
    expect(typeof principals[0]!.id).toBe('string')
  })

  test('an item that fails does not stop the others', async () => {
    const response = await admin('/v1/admin/users', 'POST', {
      principals: [
        { tenant: 'acme', externalSubject: 'the-subject-4' },
        { tenant: 'nowhere', externalSubject: 'the-subject-5' },
        { tenant: 'acme', externalSubject: 'the-subject-6' },
      ],
    })
    expect(response.status).toBe(200)
    const principals = response.body.principals as Record<string, unknown>[]
    expect(principals.length).toBe(3)
    expect(principals[0]!.created).toBe(true)
    expect(principals[1]!.error).toBe('not_found')
    expect(principals[1]!.id).toBeNull()
    expect(principals[2]!.created).toBe(true)
  })

  test('an empty batch is refused', async () => {
    const response = await admin('/v1/admin/users', 'POST', { principals: [] })
    expect(response.status).toBe(400)
  })

  test('a body that is neither a principal nor a batch is refused', async () => {
    const response = await admin('/v1/admin/users', 'POST', { tenant: 'acme' })
    expect(response.status).toBe(400)
    const body = (await fetch(`${base}/v1/admin/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: 'acme' }),
    }).then((response) => response.json())) as Record<string, unknown>
    expect(body.error).toBe('invalid_request')
  })
})

describe('the batch of the grants', () => {
  test('a batch writes every grant of the list', async () => {
    const principals = await admin('/v1/admin/users', 'POST', {
      principals: [
        { tenant: 'acme', externalSubject: 'the-subject-of-a-grant-1' },
        { tenant: 'acme', externalSubject: 'the-subject-of-a-grant-2' },
      ],
    })
    const written = principals.body.principals as Record<string, unknown>[]
    const response = await admin('/v1/admin/grants', 'PUT', {
      grants: [
        { tenant: 'acme', userId: written[0]!.id, permission: 'workspace.read' },
        { tenant: 'acme', userId: written[1]!.id, permission: 'workspace.read' },
      ],
    })
    expect(response.status).toBe(200)
    const grants = response.body.grants as Record<string, unknown>[]
    expect(grants.length).toBe(2)
    for (const grant of grants) {
      expect(grant.created).toBe(true)
      expect(typeof grant.id).toBe('string')
    }
  })

  test('a grant of a principal that does not exist is refused in the batch', async () => {
    const response = await admin('/v1/admin/grants', 'PUT', {
      grants: [
        {
          tenant: 'acme',
          userId: '33333333-3333-4333-8333-333333333333',
          permission: 'workspace.read',
        },
      ],
    })
    expect(response.status).toBe(200)
    const grants = response.body.grants as Record<string, unknown>[]
    expect(grants[0]!.error).toBe('not_found')
    expect(grants[0]!.id).toBeNull()
  })

  test('the grants of the batch exist', async () => {
    const list = await admin('/v1/admin/grants?tenant=acme', 'GET')
    const grants = list.body.grants as Record<string, unknown>[]
    expect(grants.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the audit of a batch', () => {
  test('every principal of the batch is audited', async () => {
    await admin('/v1/admin/users', 'POST', {
      principals: [
        { tenant: 'acme', externalSubject: 'the-audited-1' },
        { tenant: 'acme', externalSubject: 'the-audited-2' },
      ],
    })
    const audit = await admin('/v1/admin/audit?action=principal.created&limit=200', 'GET')
    const records = audit.body.records as Record<string, unknown>[]
    const targets = records.map((record) => record.targetId)
    // Two principals, two rows of the audit: a change that is not
    // audited does not exist.
    expect(targets.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the size of a batch', () => {
  test('a batch of a thousand principals is accepted', async () => {
    // The body of a batch is bigger than the body of one principal: the
    // two limits have to agree, or the batch of a thousand items is a
    // limit that cannot be reached.
    const principals = Array.from({ length: 1000 }, (_, index) => ({
      tenant: 'acme',
      externalSubject: `the-subject-of-the-batch-${index}`,
      email: `the-batch-${index}@acme.example`,
    }))
    const response = await admin('/v1/admin/users', 'POST', { principals })
    expect(response.status).toBe(200)
    const written = response.body.principals as Record<string, unknown>[]
    expect(written.length).toBe(1000)
    const failed = written.filter((principal) => principal.error !== undefined)
    expect(failed.length).toBe(0)
  })

  test('a batch of more than a thousand principals is refused', async () => {
    const principals = Array.from({ length: 1001 }, (_, index) => ({
      tenant: 'acme',
      externalSubject: `the-subject-of-the-too-big-batch-${index}`,
    }))
    const response = await admin('/v1/admin/users', 'POST', { principals })
    expect(response.status).toBe(400)
    const body = (await fetch(`${base}/v1/admin/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ principals }),
    }).then((response) => response.json())) as Record<string, unknown>
    expect(body.error).toBe('invalid_request')
  })
})
