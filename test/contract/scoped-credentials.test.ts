import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/**
 * The credentials of a tenant, and the end of the migration of the shared
 * token (spec §8.8).
 *
 * The bearer token of the deployment is not scoped to a tenant and it is
 * deprecated. It is **optional**: a deployment that does not set it
 * accepts only the credentials of a tenant, which are scoped to it. This
 * file proves that a deployment without the shared token answers the
 * gateway that presents the credentials of its tenant, and refuses the
 * bearer scheme.
 */

/** The token of the administration of the tests. */
const ADMIN_TOKEN = 'the-admin-token'
/** The workspace of the tests. */
const WORKSPACE = '11111111-1111-4111-8111-111111111111'

let runtime: HubRuntime
let base: string

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

/** Asks for a decision with a header of authorization. */
async function decide(
  authorization: string | null,
  subject: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/v1/decisions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization === null ? {} : { authorization }),
    },
    body: JSON.stringify({ subject, workspaceId: WORKSPACE, routeId: 'workspace-api', roles: [] }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

/** The id of the principal of the tests. */
let subject: string

beforeAll(async () => {
  // The deployment of the end of the migration: no shared token.
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
    clientId: 'shuttle-acme',
    clientSecret: 'the-secret-of-the-gateway',
  })
  const principal = await admin('/v1/admin/users', 'POST', {
    tenant: 'acme',
    externalSubject: 'the-subject',
  })
  subject = principal.id as string
  await admin('/v1/admin/grants', 'PUT', {
    tenant: 'acme',
    userId: subject,
    permission: 'workspace.read',
    workspaceId: WORKSPACE,
    routeId: 'workspace-api',
  })
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('a deployment without the shared token', () => {
  test('the credentials of the tenant of the gateway are accepted', async () => {
    const credentials = Buffer.from('shuttle-acme:the-secret-of-the-gateway').toString('base64')
    const answer = await decide(`Basic ${credentials}`, subject)
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ allow: true, reason: 'allowed' })
  })

  test('the bearer scheme is refused', async () => {
    const answer = await decide('Bearer the-access-token', subject)
    expect(answer.status).toBe(401)
    expect(answer.body.error).toBe('unauthorized')
  })

  test('a request without a credential is refused', async () => {
    const answer = await decide(null, subject)
    expect(answer.status).toBe(401)
    expect(answer.body.error).toBe('unauthorized')
  })

  test('the credentials of a tenant are scoped to it', async () => {
    await admin('/v1/admin/tenants', 'POST', {
      slug: 'other',
      displayName: 'Other Inc',
      issuer: 'https://login.other.example',
      idpClientId: 'hub-other',
      idpClientSecret: 'secret',
      clientId: 'shuttle-other',
      clientSecret: 'the-secret-of-the-other-gateway',
    })
    const principal = await admin('/v1/admin/users', 'POST', {
      tenant: 'other',
      externalSubject: 'the-subject-of-the-other-tenant',
    })
    const credentials = Buffer.from('shuttle-acme:the-secret-of-the-gateway').toString('base64')
    const answer = await decide(`Basic ${credentials}`, principal.id as string)
    expect(answer.status).toBe(200)
    // The subject exists, in another tenant: the answer does not tell the
    // gateway that it exists.
    expect(answer.body.allow).toBe(false)
    expect(answer.body.reason).toBe('the principal does not exist')
  })
})
