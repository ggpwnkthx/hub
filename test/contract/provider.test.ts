import { generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/** A private key of the tests. */
function aKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

let runtime: HubRuntime
let base: string

beforeAll(async () => {
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ISSUER: 'https://hub.example.com',
      HUB_SIGNING_KEY: aKey(),
      HUB_SIGNING_KID: 'hub-1',
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the provider of Hub', () => {
  test('the JWKS publishes the key of the service', async () => {
    const response = await fetch(`${base}/oauth/jwks`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { keys: { kid: string; alg: string; n: string }[] }
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0]?.kid).toBe('hub-1')
    expect(body.keys[0]?.alg).toBe('RS256')
    expect(body.keys[0]?.n).toBeTruthy()
  })

  test('the discovery document carries the issuer of the service', async () => {
    const response = await fetch(`${base}/.well-known/openid-configuration`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.issuer).toBe('https://hub.example.com')
    expect(body.token_endpoint).toBe('https://hub.example.com/oauth/token')
    expect(body.jwks_uri).toBe('https://hub.example.com/oauth/jwks')
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.token_endpoint_auth_methods_supported).toEqual(['client_secret_basic'])
  })

  test('the userinfo without a token is refused', async () => {
    const response = await fetch(`${base}/oauth/userinfo`)
    expect(response.status).toBe(401)
  })

  test('the userinfo with a wrong token is refused', async () => {
    const response = await fetch(`${base}/oauth/userinfo`, {
      headers: { authorization: 'Bearer not-a-token' },
    })
    expect(response.status).toBe(401)
  })
})
