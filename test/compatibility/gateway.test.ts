import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'
import { startProviderFixture, type ProviderFixture } from '../fixtures/provider'

/**
 * The compatibility suite (spec §14.1).
 *
 * The gateway of the reference runs, unchanged, with its own configuration
 * and with Hub in place of the two fixtures: Hub is the provider of the
 * identity and the access service of the gateway. The gateway is started
 * as a process of the reference: the tree of the reference is read-only
 * and it is never modified.
 */

/** The root of the reference. */
const reference =
  process.env.HUB_SHUTTLE_PATH ?? resolve(import.meta.dir, '..', '..', '..', 'shuttle')

/** The token of the administration of the tests. */
const ADMIN_TOKEN = 'the-admin-token'
/** The token of the access service of the tests. */
const ACCESS_TOKEN = 'the-access-token-of-hub'
/** The token of the metrics of the gateway. */
const METRICS_TOKEN = 'the-metrics-token-of-the-gateway'
/** The workspace of the tests. */
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'

/** The private key of the service of the tests. */
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

/** The upstream of the tests: it answers with the headers it received. */
const upstream = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    return Response.json({ headers: Object.fromEntries(request.headers.entries()) })
  },
})

/** Calls the administration of Hub. */
async function admin(path: string, method: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${hubUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`the administration answered ${response.status}: ${await response.text()}`)
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
  // The issuer of Hub is the url the gateway reaches: the discovery
  // document of the provider is read at that address.
  const gatewayPort = await freePort()
  gatewayUrl = `http://127.0.0.1:${gatewayPort}`

  await admin('/v1/admin/tenants', 'POST', {
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

  // The principal that has a grant and the one that has none.
  const withGrant = await fetch(`${hubUrl}/v1/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant: 'acme',
      externalSubject: provider.subject,
      email: 'alice@shuttle.test',
      displayName: 'Alice',
    }),
  })
  const principal = (await withGrant.json()) as { id: string }
  await fetch(`${hubUrl}/v1/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenant: 'acme',
      externalSubject: 'the-subject-without-a-grant',
      email: 'bob@shuttle.test',
      displayName: 'Bob',
    }),
  })

  await admin('/v1/admin/grants', 'PUT', {
    tenant: 'acme',
    userId: principal.id,
    permission: 'workspace.read',
    workspaceId: WORKSPACE_ID,
    routeId: 'workspace-api',
  })

  // The configuration of the gateway: it is the configuration of the
  // reference, with the routes of the tests.
  directory = await mkdtemp(join(tmpdir(), 'hub-compatibility-'))
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
            id: 'public-site',
            match: { host: 'public.shuttle.test', path: '/' },
            upstream: upstreamUrl,
            auth: { mode: 'none' },
          },
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

  // The gateway of the reference, unchanged, with Hub in place of the two
  // fixtures.
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
      SHUTTLE_METRICS_TOKEN: METRICS_TOKEN,
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

/**
 * The login of a browser, from the gateway to Hub and back.
 *
 * The browser keeps its cookies: the state of the login travels in one of
 * them and it has to come back to the callback of Hub.
 */
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

describe('the compatibility of Hub with the gateway', () => {
  test('a browser logs in at the provider of the tenant and comes back with a session', async () => {
    const cookie = await login()
    expect(cookie).toContain('shuttle_session=')
  })

  test('the gateway writes the headers of the identity of the principal', async () => {
    const cookie = await login()
    const response = await request(`/ws/${WORKSPACE_ID}/`, cookie, 'api.shuttle.test')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { headers: Record<string, string> }
    expect(body.headers['x-shuttle-user']).toBeTruthy()
    expect(body.headers['x-shuttle-email']).toBe('alice@shuttle.test')
    expect(body.headers['x-shuttle-roles']).toContain('workspace.read')
  })

  test('a principal without a grant is refused by the gateway', async () => {
    // The principal that has no grant at all reaches nothing: the
    // decision of Hub denies it and the gateway fails closed.
    provider.authenticateAs('the-subject-without-a-grant')
    const cookie = await login()
    const response = await request(`/ws/${WORKSPACE_ID}/`, cookie, 'api.shuttle.test')
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('workspace_forbidden')
  })

  test('the metrics of the gateway count the denial as a missing role', async () => {
    provider.authenticateAs('the-subject-without-a-grant')
    const cookie = await login()
    await request(`/ws/${WORKSPACE_ID}/`, cookie, 'api.shuttle.test')
    const metrics = await fetch(`${gatewayUrl}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    })
    const text = await metrics.text()
    expect(text).toContain('shuttle_auth_failures_total')
    expect(text).toContain('missing_role')
  })

  test('the gateway discovers Hub and accepts its tokens', async () => {
    const discovery = await fetch(`${hubUrl}/.well-known/openid-configuration`)
    const document = (await discovery.json()) as Record<string, unknown>
    expect(document.issuer).toBe(hubUrl)
    expect(document.jwks_uri).toBe(`${hubUrl}/oauth/jwks`)
  })
})
