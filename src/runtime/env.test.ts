import { describe, expect, test } from 'bun:test'
import { readEnv, secretBytes } from './env'

/** The environment of a production deployment, with every secret. */
const PRODUCTION: Record<string, string> = {
  HUB_ENVIRONMENT: 'production',
  HUB_DATABASE_URL: 'postgres://hub:hub@localhost:5432/hub',
  HUB_REDIS_URL: 'redis://localhost:6379/0',
  HUB_ISSUER: 'https://hub.example.com',
  HUB_ADMIN_TOKEN: 'the-admin-token-of-the-production',
  HUB_ACCESS_TOKEN: 'the-access-token-of-the-production',
  HUB_STATE_SECRET: '4f9a2c8e'.repeat(8),
  HUB_SECRET_ENCRYPTION_KEY: 'b31e7d09'.repeat(8),
  HUB_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----',
  HUB_SIGNING_KID: 'hub-1',
}

describe('the environment of Hub', () => {
  test('the defaults are the ones of the specification', () => {
    const settings = readEnv({ HUB_DATABASE_URL: 'postgres://localhost:5432/hub' })
    expect(settings.environment).toBe('development')
    expect(settings.production).toBe(false)
    expect(settings.network.host).toBe('0.0.0.0')
    expect(settings.network.port).toBe(8081)
    expect(settings.public.issuer).toBe('http://localhost:8081')
    expect(settings.public.publicUrl).toBe('http://localhost:8081')
    expect(settings.timeouts.idpTimeoutMs).toBe(5_000)
    expect(settings.timeouts.decisionTimeoutMs).toBe(2_000)
    expect(settings.timeouts.clockSkewSeconds).toBe(60)
    expect(settings.observability.logLevel).toBe('info')
    expect(settings.store.allowMemoryState).toBe(false)
    expect(settings.store.url).toBeUndefined()
  })

  test('the public url of Hub defaults to the issuer', () => {
    const settings = readEnv({
      HUB_DATABASE_URL: 'postgres://localhost:5432/hub',
      HUB_ISSUER: 'https://hub.example.com',
    })
    expect(settings.public.publicUrl).toBe('https://hub.example.com')
    expect(
      readEnv({
        HUB_DATABASE_URL: 'postgres://localhost:5432/hub',
        HUB_ISSUER: 'https://hub.example.com',
        HUB_PUBLIC_URL: 'https://www.hub.example.com',
      }).public.publicUrl
    ).toBe('https://www.hub.example.com')
  })

  test('the database of a development machine is the embedded one', () => {
    const settings = readEnv({})
    expect(settings.database.driver).toBe('pglite')
    expect(settings.database.path).toBe('./.hub/pglite')
    expect(settings.database.url).toBeUndefined()
  })

  test('the url of the database names the driver', () => {
    expect(
      readEnv({ HUB_DATABASE_URL: 'postgres://hub:hub@localhost:5432/hub' }).database.driver
    ).toBe('postgres')
    expect(
      readEnv({ HUB_DATABASE_URL: 'postgres://hub:hub@localhost:5432/hub' }).database.url
    ).toBe('postgres://hub:hub@localhost:5432/hub')
    expect(readEnv({ HUB_DATABASE_URL: 'pglite://memory://' }).database.driver).toBe('pglite')
    expect(readEnv({ HUB_DATABASE_URL: 'pglite://memory://' }).database.path).toBe('memory://')
    expect(readEnv({ HUB_DATABASE_URL: 'pglite://' }).database.path).toBe('./.hub/pglite')
    expect(() => readEnv({ HUB_DATABASE_URL: 'mysql://localhost' })).toThrow(/HUB_DATABASE_URL/)
  })

  test('a malformed value stops the service', () => {
    const database = { HUB_DATABASE_URL: 'postgres://localhost:5432/hub' }
    expect(() => readEnv({ ...database, HUB_PORT: 'http' })).toThrow(/HUB_PORT/)
    expect(() => readEnv({ ...database, HUB_IDP_TIMEOUT_MS: '-1' })).toThrow(/HUB_IDP_TIMEOUT_MS/)
    expect(() => readEnv({ ...database, HUB_DECISION_TIMEOUT_MS: 'soon' })).toThrow(
      /HUB_DECISION_TIMEOUT_MS/
    )
    expect(() => readEnv({ ...database, HUB_ENVIRONMENT: 'staging' })).toThrow(/HUB_ENVIRONMENT/)
    expect(() => readEnv({ ...database, HUB_ISSUER: 'not-a-url' })).toThrow(/HUB_ISSUER/)
  })

  test('the level of the log falls back to info', () => {
    const database = { HUB_DATABASE_URL: 'postgres://localhost:5432/hub' }
    expect(readEnv({ ...database, HUB_LOG_LEVEL: 'nonsense' }).observability.logLevel).toBe('info')
    expect(readEnv({ ...database, HUB_LOG_LEVEL: 'debug' }).observability.logLevel).toBe('debug')
  })

  test('a production deployment needs every secret', () => {
    let message = ''
    try {
      readEnv({ HUB_ENVIRONMENT: 'production' })
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('HUB_DATABASE_URL')
    expect(message).toContain('HUB_ISSUER')
    expect(message).toContain('HUB_ADMIN_TOKEN')
    expect(message).toContain('HUB_STATE_SECRET')
    expect(message).toContain('HUB_SECRET_ENCRYPTION_KEY')
    expect(message).toContain('HUB_SIGNING_KEY')
    expect(message).toContain('HUB_SIGNING_KID')
    expect(message).toContain('HUB_REDIS_URL')
  })

  test('the shared token of the decisions is optional', () => {
    // The token of the deployment is not scoped to a tenant and it is
    // deprecated: a deployment that has moved its gateways to the
    // credentials of their tenant does not set it (spec §8.8).
    const settings = readEnv({ ...PRODUCTION, HUB_ACCESS_TOKEN: undefined })
    expect(settings.production).toBe(true)
    expect(settings.access.token).toBeUndefined()
  })

  test('the previous token of the decisions without the token it replaced is refused', () => {
    // The deployment believes it removed the shared secret, and the
    // secret is still accepted: the service says so instead of starting.
    expect(() =>
      readEnv({ ...PRODUCTION, HUB_ACCESS_TOKEN: undefined, HUB_PREVIOUS_ACCESS_TOKEN: 'old' })
    ).toThrow(/HUB_PREVIOUS_ACCESS_TOKEN/)
  })

  test('a production deployment with every secret starts', () => {
    const settings = readEnv(PRODUCTION)
    expect(settings.production).toBe(true)
    expect(settings.public.issuer).toBe('https://hub.example.com')
    expect(settings.admin.token).toBe('the-admin-token-of-the-production')
    expect(settings.access.token).toBe('the-access-token-of-the-production')
    expect(settings.store.url).toBe('redis://localhost:6379/0')
    expect(settings.signing.kid).toBe('hub-1')
  })

  test('a deployment of a single node may keep the state in the process', () => {
    const settings = readEnv({
      ...PRODUCTION,
      HUB_REDIS_URL: undefined,
      HUB_ALLOW_MEMORY_STATE: 'true',
    })
    expect(settings.store.allowMemoryState).toBe(true)
    expect(settings.store.url).toBeUndefined()
  })

  test('a production deployment without the shared store is refused', () => {
    expect(() => readEnv({ ...PRODUCTION, HUB_REDIS_URL: undefined })).toThrow(/HUB_REDIS_URL/)
  })

  test('a production deployment does not run on the embedded database', () => {
    expect(() => readEnv({ ...PRODUCTION, HUB_DATABASE_URL: 'pglite://memory://' })).toThrow(
      /HUB_DATABASE_URL/
    )
  })

  test('a secret that is too short is refused', () => {
    expect(() => readEnv({ ...PRODUCTION, HUB_STATE_SECRET: 'short' })).toThrow(/HUB_STATE_SECRET/)
    expect(() => readEnv({ ...PRODUCTION, HUB_SECRET_ENCRYPTION_KEY: 'short' })).toThrow(
      /HUB_SECRET_ENCRYPTION_KEY/
    )
  })

  test('a signing key that is not a private key is refused', () => {
    expect(() => readEnv({ ...PRODUCTION, HUB_SIGNING_KEY: 'the-key' })).toThrow(/HUB_SIGNING_KEY/)
  })

  test('a token that is too short is refused in a production deployment', () => {
    // The length of a secret is the first thing that is tried: a token
    // of one character protects the administration as well as a token of
    // thirty two characters (spec §4.1).
    expect(() => readEnv({ ...PRODUCTION, HUB_ADMIN_TOKEN: 'short' })).toThrow(
      /HUB_ADMIN_TOKEN must be at least 16 bytes/
    )
    expect(() => readEnv({ ...PRODUCTION, HUB_METRICS_TOKEN: 'short' })).toThrow(
      /HUB_METRICS_TOKEN must be at least 16 bytes/
    )
    expect(() =>
      readEnv({ ...PRODUCTION, HUB_ACCESS_TOKEN: 'short', HUB_PREVIOUS_ACCESS_TOKEN: undefined })
    ).toThrow(/HUB_ACCESS_TOKEN must be at least 16 bytes/)
  })

  test('a token that is not set is not a short token', () => {
    // The shared token of the decisions is optional: its absence is not
    // a length (spec §4.4, §8.8).
    const settings = readEnv({ ...PRODUCTION, HUB_METRICS_TOKEN: undefined })
    expect(settings.metrics.token).toBeUndefined()
  })

  test('the values of the example are refused in a production deployment', () => {
    // The example file is published, and so is every deployment that
    // kept one of its values (spec §4.1).
    expect(() =>
      readEnv({ ...PRODUCTION, HUB_ADMIN_TOKEN: 'the-admin-token-of-the-development' })
    ).toThrow(/HUB_ADMIN_TOKEN is the value of the example/)
  })

  test('a secret that is one repeated character is refused in a production deployment', () => {
    expect(() => readEnv({ ...PRODUCTION, HUB_STATE_SECRET: '0'.repeat(64) })).toThrow(
      /HUB_STATE_SECRET is the value of the example/
    )
    expect(() => readEnv({ ...PRODUCTION, HUB_SECRET_ENCRYPTION_KEY: '1'.repeat(64) })).toThrow(
      /HUB_SECRET_ENCRYPTION_KEY is the value of the example/
    )
  })

  test('a development machine may use the values of the example', () => {
    const settings = readEnv({
      HUB_ADMIN_TOKEN: 'the-admin-token-of-the-development',
      HUB_STATE_SECRET: '0'.repeat(64),
    })
    expect(settings.admin.token).toBe('the-admin-token-of-the-development')
  })

  test('the size of a secret is counted the way it is read', () => {
    expect(secretBytes('a'.repeat(64))).toBe(32)
    expect(secretBytes('a'.repeat(43) + '=')).toBe(32)
    expect(secretBytes('secret-passphrase-32-bytes-long!')).toBe(32)
    expect(secretBytes('secret-passphrase-31-bytes-long')).toBe(31)
  })
})
