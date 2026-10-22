import { generateKeyPairSync } from 'node:crypto'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/**
 * The Hub under test.
 *
 * The suite runs against a Hub that it starts itself, in the process of
 * the test: it is the fast way, and it is the way a developer runs it.
 *
 * The suite can also run against a Hub that is **already running** — the
 * image of a release, for instance — when the environment names it:
 *
 *   HUB_EXTERNAL_URL           the url the callers reach that Hub at
 *   HUB_EXTERNAL_ADMIN_TOKEN   the token of its administration
 *   HUB_EXTERNAL_ACCESS_TOKEN  the token of its decisions
 *
 * The suite never creates what the environment names: a suite that is
 * supposed to prove the image of a release has to talk to that image,
 * and a suite that talks to another Hub proves nothing about it.
 */

/** The Hub under test. */
export interface HubUnderTest {
  /** The url the callers reach Hub at. */
  url: string
  /** The token of the administration of Hub. */
  adminToken: string
  /** The token of the decisions of Hub. */
  accessToken: string
  /** True when Hub runs in the process of the test. */
  local: boolean
  /** Stops Hub, when the suite is the one that started it. */
  stop: () => Promise<void>
}

/** Finds a free port. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  const port = server.port ?? 0
  await server.stop(true)
  return port
}

/**
 * The Hub that the suite runs against.
 *
 * The environment decides: a running Hub when it is named, a Hub of the
 * process of the test otherwise.
 */
export async function startHubUnderTest(): Promise<HubUnderTest> {
  const external = process.env.HUB_EXTERNAL_URL?.trim()
  if (external) {
    const adminToken = process.env.HUB_EXTERNAL_ADMIN_TOKEN?.trim()
    const accessToken = process.env.HUB_EXTERNAL_ACCESS_TOKEN?.trim()
    if (!adminToken) {
      throw new Error(
        'HUB_EXTERNAL_URL is set and HUB_EXTERNAL_ADMIN_TOKEN is not: the suite administers the Hub it is given'
      )
    }
    if (!accessToken) {
      throw new Error(
        'HUB_EXTERNAL_URL is set and HUB_EXTERNAL_ACCESS_TOKEN is not: the gateway of the reference asks the Hub it is given for its decisions'
      )
    }
    return {
      url: external,
      adminToken,
      accessToken,
      local: false,
      stop: async () => {
        // The Hub is not ours: it is not ours to stop.
      },
    }
  }

  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const signingKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey

  const hub: HubRuntime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_ISSUER: url,
      HUB_PUBLIC_URL: url,
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKEN: 'the-admin-token',
      HUB_ACCESS_TOKEN: 'the-access-token-of-hub',
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
      HUB_STATE_SECRET: 'b'.repeat(64),
      HUB_SIGNING_KEY: signingKey,
      HUB_SIGNING_KID: 'hub-1',
    })
  )

  return {
    url,
    adminToken: 'the-admin-token',
    accessToken: 'the-access-token-of-hub',
    local: true,
    stop: async () => {
      await hub.listener.stop(true)
      await hub.database.close()
    },
  }
}
