import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'
import { startProviderFixture, type ProviderFixture } from '../fixtures/provider'

/**
 * The rehearsal of the cutover of a tenant (docs/release.md §4).
 *
 * The rehearsal is the cutover, played against the gateway of the
 * reference, unchanged. It follows the phases of the runbook:
 *
 * 1. the tenant is registered,
 * 2. the principals are registered,
 * 3. the grants are registered,
 * 4. the check: a browser logs in at the provider of the tenant and
 *    reaches an upstream of the gateway,
 * 5. the way back: the grant is revoked and the access ends,
 * 6. the tenant is switched again without registering anything.
 *
 * The rehearsal is what makes the checklist of the cutover a list of
 * facts instead of a list of hopes.
 */

/** The root of the reference. */
const reference =
  process.env.HUB_SHUTTLE_PATH ?? resolve(import.meta.dir, '..', '..', '..', 'shuttle')

const ADMIN_TOKEN = 'the-admin-token'
const ACCESS_TOKEN = 'the-access-token-of-hub'
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'

const SIGNING_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

let hub: HubRuntime
let hubUrl: string
let provider: ProviderFixture
let gateway: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
let gatewayUrl: string
let directory: string
let upstreamUrl: string

const upstream = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    return Response.json({ headers: Object.fromEntries(request.headers.entries()) })
  },
})

/** Calls the administration of Hub. */
async function admin(
  path: string,
  method: string,
  body?: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${hubUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
  }
}

/** Finds a free port. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  const port = server.port ?? 0
  await server.stop(true)
  return port
}

/** Waits for a url to answer. */
async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.status > 0) return
    } catch {
      // The service is not listening yet.
    }
    await Bun.sleep(50)
  }
  throw new Error(`the service at ${url} did not answer`)
}

/** The login of a browser, from the gateway to Hub and back. */
async function login(): Promise<string> {
  const jar = new Map<string, string>()
  const header = (): string =>
    [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  const capture = (response: Response): void => {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    for (const cookie of headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';')
      if (!pair) continue
      const index = pair.indexOf('=')
      if (index === -1) continue
      jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }
  }

  const start = await fetch(`${gatewayUrl}/auth/login?redirect=%2F`, { redirect: 'manual' })
  capture(start)
  let location = start.headers.get('location') ?? ''
  let callback: Response | null = null
  for (let hop = 0; hop < 10; hop += 1) {
    const response = await fetch(location, {
      redirect: 'manual',
      headers: jar.size > 0 ? { cookie: header() } : undefined,
    })
    capture(response)
    const next = response.headers.get('location')
    if (!next) {
      callback = response
      break
    }
    location = new URL(next, gatewayUrl).toString()
  }
  callback ??= new Response(null, { status: 500 })
  const session = jar.get('shuttle_session')
  if (!session) {
    throw new Error(`the login did not create a session: ${callback.status}`)
  }
  return `shuttle_session=${session}`
}

/** A request to a route of the gateway. */
async function request(path: string, cookie: string, host: string): Promise<Response> {
  return await fetch(`${gatewayUrl}${path}`, {
    headers: { cookie, host },
    redirect: 'manual',
  })
}

beforeAll(async () => {
  upstreamUrl = `http://127.0.0.1:${upstream.port}`
  provider = await startProviderFixture()

  const hubPort = await freePort()
  hubUrl = `http://127.0.0.1:${hubPort}`

  hub = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(hubPort),
      HUB_ISSUER: hubUrl,
      HUB_PUBLIC_URL: hubUrl,
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKEN: ADMIN_TOKEN,
      HUB_ACCESS_TOKEN: ACCESS_TOKEN,
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
      HUB_STATE_SECRET: 'b'.repeat(64),
      HUB_SIGNING_KEY: SIGNING_KEY,
      HUB_SIGNING_KID: 'hub-1',
    })
  )

  const gatewayPort = await freePort()
  gatewayUrl = `http://127.0.0.1:${gatewayPort}`

  directory = await mkdtemp(join(tmpdir(), 'hub-cutover-'))
  const configPath = join(directory, 'routes.json')
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: 1,
        defaults: {
          auth: { mode: 'none' },
          timeouts: { responseMs: 5000, firstByteMs: 30000, bodyMs: 300000 },
          maxBodyBytes: 1024 * 1024,
        },
        trustedProxies: ['127.0.0.1/32'],
        routes: [
          {
            id: 'workspace-api',
            match: { host: 'api.shuttle.test', path: '/ws/{workspaceId}/' },
            upstream: upstreamUrl,
            auth: { mode: 'any', workspace: { param: 'workspaceId', requireUuid: true } },
          },
        ],
      },
      null,
      2
    )
  )

  gateway = Bun.spawn(['bun', 'run', join(reference, 'src', 'main.ts')], {
    cwd: reference,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      SHUTTLE_CONFIG: configPath,
      SHUTTLE_GATEWAY_HOST: '127.0.0.1',
      SHUTTLE_GATEWAY_PORT: String(gatewayPort),
      SHUTTLE_OIDC_ISSUER: hubUrl,
      SHUTTLE_OIDC_CLIENT_ID: 'shuttle-acme',
      SHUTTLE_OIDC_CLIENT_SECRET: 'the-secret-of-the-gateway',
      SHUTTLE_OIDC_REDIRECT_URI: `${gatewayUrl}/auth/callback`,
      SHUTTLE_OIDC_ALLOW_INSECURE: 'true',
      SHUTTLE_ACCESS_URL: hubUrl,
      SHUTTLE_ACCESS_TOKEN: ACCESS_TOKEN,
      SHUTTLE_ACCESS_CACHE_TTL_MS: '0',
      SHUTTLE_SESSION_SECRET: 'the-session-secret',
      SHUTTLE_SESSION_URL: 'memory://local',
      SHUTTLE_COOKIE_SECURE: 'false',
      SHUTTLE_LOG_LEVEL: 'error',
      SHUTTLE_SHUTDOWN_TIMEOUT_MS: '2000',
      SHUTTLE_RATE_LIMIT_MAX: '0',
      SHUTTLE_RATE_LIMIT_GLOBAL_MAX: '0',
      SHUTTLE_LOGIN_RATE_LIMIT_MAX: '1000',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await waitFor(`${gatewayUrl}/healthz`)
})

afterAll(async () => {
  gateway?.kill('SIGTERM')
  await gateway?.exited
  await hub?.listener.stop(true)
  await hub?.database.close()
  await provider?.stop()
  await upstream.stop(true)
  await rm(directory, { recursive: true, force: true })
})

describe('the rehearsal of the cutover of a tenant', () => {
  test('the tenant, its principal and its grant are registered', async () => {
    // Phase 1: the tenant is registered.
    const tenant = await admin('/v1/admin/tenants', 'POST', {
      slug: 'acme',
      displayName: 'Acme Inc',
      issuer: provider.issuer,
      idpClientId: provider.clientId,
      idpClientSecret: provider.clientSecret,
      idpRedirectUri: `${hubUrl}/oauth/tenant/callback`,
      clientId: 'shuttle-acme',
      clientSecret: 'the-secret-of-the-gateway',
      // The url the gateway sends the browser back to is registered with
      // the tenant: the gateway of the reference is at a port of the test.
      clientRedirectUris: [`${gatewayUrl}/auth/callback`],
    })
    expect(tenant.status).toBe(201)

    // Phase 2: the principals are registered.
    const principal = await admin('/v1/admin/users', 'POST', {
      tenant: 'acme',
      externalSubject: provider.subject,
      email: 'alice@shuttle.test',
      displayName: 'Alice',
    })
    expect(principal.status).toBe(201)

    // Phase 3: the grants are registered.
    const grant = await admin('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      userId: principal.body.id,
      permission: 'workspace.read',
      workspaceId: WORKSPACE_ID,
      routeId: 'workspace-api',
    })
    expect(grant.status).toBe(200)

    // The checklist of the cutover: the tenant, its principals and its
    // grants are registered, and the operator can read them.
    const tenants = await admin('/v1/admin/tenants', 'GET')
    expect((tenants.body.tenants as { slug: string }[]).map((row) => row.slug)).toContain('acme')
    const principals = await admin('/v1/admin/users?tenant=acme', 'GET')
    expect((principals.body.principals as { id: string }[]).map((row) => row.id)).toContain(
      principal.body.id as string
    )
    const grants = await admin('/v1/admin/grants?tenant=acme', 'GET')
    expect((grants.body.grants as { id: string }[]).map((row) => row.id)).toContain(
      grant.body.id as string
    )
  })

  test('the check: a browser logs in and reaches an upstream of the gateway', async () => {
    const cookie = await login()
    const response = await request(`/ws/${WORKSPACE_ID}/`, cookie, 'api.shuttle.test')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-shuttle-user']).toBeTruthy()
    expect(body.headers['x-shuttle-roles']).toContain('workspace.read')
  })

  test('the way back: the revocation of the grant ends the access', async () => {
    const grants = await admin('/v1/admin/grants?tenant=acme', 'GET')
    const grant = (grants.body.grants as { id: string }[])[0]!
    const revoked = await admin(`/v1/admin/grants/${grant.id}`, 'DELETE')
    expect(revoked.status).toBe(204)

    const cookie = await login()
    const response = await request(`/ws/${WORKSPACE_ID}/`, cookie, 'api.shuttle.test')
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('workspace_forbidden')
  })

  test('the tenant is switched again without registering anything', async () => {
    // The data of Hub stays: the principal and the tenant are still
    // there, and the access is given again by a grant.
    const principals = await admin('/v1/admin/users?tenant=acme', 'GET')
    const principal = (principals.body.principals as { id: string }[])[0]!
    const grant = await admin('/v1/admin/grants', 'PUT', {
      tenant: 'acme',
      userId: principal.id,
      permission: 'workspace.read',
      workspaceId: WORKSPACE_ID,
      routeId: 'workspace-api',
    })
    expect(grant.status).toBe(200)

    const cookie = await login()
    const response = await request(`/ws/${WORKSPACE_ID}/`, cookie, 'api.shuttle.test')
    expect(response.status).toBe(200)
  })
})
