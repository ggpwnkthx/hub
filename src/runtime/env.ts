/**
 * The environment of Hub.
 *
 * The environment is read once, at the start of the process, and it is
 * validated as a whole: a value that cannot be understood stops the service,
 * because a setting that looks active but is not is a security hole. The
 * only exception is the level of the log, which falls back to `info`: a
 * typo in the level of a log must not keep a deployment down.
 *
 * The names of the variables never leave this module: the rest of Hub
 * receives the settings it needs, not the environment.
 */

import { z } from 'zod'
import type { LogLevel } from '../observability'
import { parseLogLevel } from '../observability'

/** The environment the process runs in. */
export type Environment = 'development' | 'production'

/** The settings of the listener. */
export interface NetworkSettings {
  /** The address the listener binds to. */
  host: string
  /** The port the listener binds to. */
  port: number
}

/** The urls the browser and the gateway use. */
export interface PublicSettings {
  /** The public issuer url of Hub: the `iss` of every token it issues. */
  issuer: string
  /** The public url of Hub, when it differs from the issuer. */
  publicUrl: string
}

/** The settings of the database of the five tables. */
export interface DatabaseSettings {
  /** The driver of the database. */
  driver: 'postgres' | 'pglite'
  /** The url of the PostgreSQL server, when the driver is the server. */
  url?: string
  /** The directory of the embedded database, when the driver is embedded. */
  path?: string
}

/** The settings of the shared store of the authorization codes. */
export interface StoreSettings {
  /** The url of the Redis of the deployment, when there is one. */
  url?: string
  /**
   * True when the deployment accepts the state in the memory of the process.
   *
   * The state of a deployment has to be shared: a code that lives in the
   * memory of one replica is unknown to the others. A deployment that is a
   * single node may say so explicitly.
   */
  allowMemoryState: boolean
}

/** The settings of the administration. */
export interface AdminSettings {
  /** The bearer token of the eight administrative endpoints. */
  token?: string
}

/** The settings of the decision contract of the gateway. */
export interface AccessSettings {
  /** The bearer token the gateway presents on `POST /v1/decisions`. */
  token?: string
  /**
   * The credentials of the access context contract.
   *
   * The value is a json object: every key is a bearer token and every
   * value holds the tenants the token may ask about. A `null` scope
   * means every tenant: it is a choice of the deployment and not the
   * default of a tenant credential.
   */
  contextTokens?: string
}

/** The settings of the metrics. */
export interface MetricsSettings {
  /** The bearer token that guards the metrics endpoint. */
  token?: string
}

/** The settings of the secrets of the process. */
export interface SecretSettings {
  /** The secret that signs and encrypts the state of a login. */
  stateSecret?: string
  /** The key that encrypts the client secrets at rest. */
  encryptionKey?: string
}

/** The settings of the key Hub signs its tokens with. */
export interface SigningSettings {
  /** The private key of Hub, in PEM. */
  key?: string
  /** The identifier of the key in the JWKS. */
  kid?: string
  /** The private key of the previous rotation, in PEM. */
  previousKey?: string
  /** The identifier of the previous key in the JWKS. */
  previousKid?: string
}

/** The settings of the deadlines. */
export interface TimeoutSettings {
  /** How long Hub waits for the provider of a tenant. */
  idpTimeoutMs: number
  /** How long a decision may take before it is a denial. */
  decisionTimeoutMs: number
  /** The tolerance of the clock on the tokens of a provider. */
  clockSkewSeconds: number
}

/** The settings of the observation. */
export interface ObservabilitySettings {
  /** The level of the log. */
  logLevel: LogLevel
}

/** Everything Hub needs to start. */
export interface RuntimeSettings {
  /** The environment of the process. */
  environment: Environment
  /** True when the environment is a production one. */
  production: boolean
  network: NetworkSettings
  public: PublicSettings
  database: DatabaseSettings
  store: StoreSettings
  admin: AdminSettings
  access: AccessSettings
  metrics: MetricsSettings
  secrets: SecretSettings
  signing: SigningSettings
  timeouts: TimeoutSettings
  observability: ObservabilitySettings
}

/** The issuer of a development deployment. */
export function developmentIssuer(port: number): string {
  return `http://localhost:${port}`
}

/** The smallest size of a secret, in bytes. */
export const MINIMUM_SECRET_BYTES = 32

/**
 * The directory of the embedded database of a development machine.
 *
 * The database of the development stack lives in the working directory, so
 * the tenants and the principals of a development machine survive the
 * restarts of the process.
 */
export const DEFAULT_EMBEDDED_DATABASE_PATH = './.hub/pglite'

/** An integer of the environment. */
function intEnv(defaultValue: number, options: { min?: number; max?: number } = {}) {
  let schema = z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? Number.NaN : value),
    z.coerce.number().int('a whole number is expected')
  )
  if (options.min !== undefined) {
    const min = options.min
    schema = schema.refine((value) => value >= min, {
      message: `the value must be at least ${min}`,
    })
  }
  if (options.max !== undefined) {
    const max = options.max
    schema = schema.refine((value) => value <= max, {
      message: `the value must be at most ${max}`,
    })
  }
  return schema.default(defaultValue)
}

/** A boolean of the environment. */
function boolEnv() {
  return z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .optional()
}

/** The environment of the process. */
export type Env = Record<string, string | undefined>

const EnvSchema = z.object({
  HUB_HOST: z.string().default('0.0.0.0'),
  HUB_PORT: intEnv(8081, { min: 0, max: 65_535 }),

  HUB_ISSUER: z.string().optional(),
  HUB_PUBLIC_URL: z.string().optional(),

  HUB_DATABASE_URL: z.string().optional(),
  HUB_REDIS_URL: z.string().optional(),
  HUB_ALLOW_MEMORY_STATE: boolEnv(),

  HUB_ADMIN_TOKEN: z.string().optional(),
  HUB_ACCESS_TOKEN: z.string().optional(),
  HUB_ACCESS_CONTEXT_TOKENS: z.string().optional(),
  HUB_METRICS_TOKEN: z.string().optional(),

  HUB_STATE_SECRET: z.string().optional(),
  HUB_SECRET_ENCRYPTION_KEY: z.string().optional(),

  HUB_SIGNING_KEY: z.string().optional(),
  HUB_SIGNING_KID: z.string().optional(),
  HUB_PREVIOUS_SIGNING_KEY: z.string().optional(),
  HUB_PREVIOUS_SIGNING_KID: z.string().optional(),

  HUB_IDP_TIMEOUT_MS: intEnv(5_000, { min: 1 }),
  HUB_DECISION_TIMEOUT_MS: intEnv(2_000, { min: 1 }),
  HUB_CLOCK_SKEW_SECONDS: intEnv(60, { min: 0 }),

  HUB_LOG_LEVEL: z.string().optional(),
  HUB_ENVIRONMENT: z.enum(['development', 'production']).default('development'),
})

/**
 * The number of bytes of a secret.
 *
 * A secret is handed over as a hex string, as a base64 string or as a
 * passphrase: the three are counted the way they are read, so a 32 byte
 * secret is 64 hexadecimal characters and 44 base64 characters.
 */
export function secretBytes(value: string): number {
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return trimmed.length / 2
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length % 4 === 0) {
    return Buffer.from(trimmed, 'base64').length
  }
  return Buffer.byteLength(trimmed, 'utf8')
}

/** Reports whether a value is an absolute http url. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Reports whether a value looks like a PEM private key. */
function isPrivateKeyPem(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
}

/**
 * Reads the environment.
 *
 * A value that cannot be understood stops the service: the message names
 * the variable, so the operator knows what to fix. Every problem of the
 * environment is reported at once: a deployment that fixes one variable
 * and restarts to learn about the next one is a deployment that stays down.
 */
export function readEnv(env: Env = process.env): RuntimeSettings {
  const result = EnvSchema.safeParse(env)
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'the environment'}: ${issue.message}`)
      .join('; ')
    throw new Error(`the environment is invalid: ${problems}`)
  }
  const parsed = result.data
  const production = parsed.HUB_ENVIRONMENT === 'production'
  const problems: string[] = []

  // The database of the five tables. A deployment talks to a PostgreSQL
  // server: the replicas share their tables. A development machine runs
  // the embedded PostgreSQL of the process when nothing is named.
  const rawDatabase = parsed.HUB_DATABASE_URL?.trim()
  let driver: 'postgres' | 'pglite' = 'pglite'
  let databaseUrl: string | undefined
  let databasePath: string | undefined
  if (!rawDatabase) {
    if (production) {
      problems.push(
        'HUB_DATABASE_URL must be set in a production environment: it names the PostgreSQL of the five tables of Hub'
      )
    } else {
      databasePath = DEFAULT_EMBEDDED_DATABASE_PATH
    }
  } else if (/^postgres(ql)?:\/\//i.test(rawDatabase)) {
    driver = 'postgres'
    databaseUrl = rawDatabase
  } else if (/^pglite:\/\//i.test(rawDatabase)) {
    driver = 'pglite'
    databasePath = rawDatabase.slice('pglite://'.length) || DEFAULT_EMBEDDED_DATABASE_PATH
  } else {
    problems.push(
      'HUB_DATABASE_URL must name a PostgreSQL server (postgres://...) or the embedded database of a development machine (pglite://...)'
    )
  }
  if (production && driver === 'pglite') {
    problems.push(
      'HUB_DATABASE_URL must name a PostgreSQL server in a production environment: the embedded database lives in one process and the replicas of a deployment share their tables'
    )
  }

  // The urls the browser and the gateway use. A value that is not a url is
  // a setting that looks active but is not.
  const issuer = parsed.HUB_ISSUER ?? (production ? undefined : developmentIssuer(parsed.HUB_PORT))
  if (!issuer) {
    problems.push(
      'HUB_ISSUER must be set in a production environment: it is the issuer of the tokens of Hub and the one the gateway is configured with'
    )
  } else if (!isHttpUrl(issuer)) {
    problems.push('HUB_ISSUER must be an absolute http url')
  }
  const publicUrl = parsed.HUB_PUBLIC_URL ?? issuer
  if (publicUrl && !isHttpUrl(publicUrl)) {
    problems.push('HUB_PUBLIC_URL must be an absolute http url')
  }

  // The secrets of the deployment. They are required in production: a
  // deployment without them cannot sign a login, encrypt a secret at rest
  // or authenticate a call.
  if (production) {
    if (!parsed.HUB_ADMIN_TOKEN) {
      problems.push(
        'HUB_ADMIN_TOKEN must be set in a production environment: it is the bearer token of the seven administrative endpoints'
      )
    }
    if (!parsed.HUB_ACCESS_TOKEN) {
      problems.push(
        'HUB_ACCESS_TOKEN must be set in a production environment: it is the bearer token the gateway presents on POST /v1/decisions'
      )
    }
    if (!parsed.HUB_STATE_SECRET) {
      problems.push(
        'HUB_STATE_SECRET must be set in a production environment: it signs and encrypts the state of a login and it has to be the same on every replica'
      )
    }
    if (!parsed.HUB_SECRET_ENCRYPTION_KEY) {
      problems.push(
        'HUB_SECRET_ENCRYPTION_KEY must be set in a production environment: it encrypts the client secrets of the tenants at rest'
      )
    }
    if (!parsed.HUB_SIGNING_KEY) {
      problems.push(
        'HUB_SIGNING_KEY must be set in a production environment: it is the private key Hub signs its tokens with, and a key that is generated at the start of a process invalidates every token that is alive'
      )
    }
    if (!parsed.HUB_SIGNING_KID) {
      problems.push(
        'HUB_SIGNING_KID must be set in a production environment: it is the identifier of the key in the JWKS'
      )
    }
    // The state of a deployment has to be shared by the replicas. A
    // deployment that is a single node may say so explicitly.
    if (!parsed.HUB_REDIS_URL && !parsed.HUB_ALLOW_MEMORY_STATE) {
      problems.push(
        'HUB_REDIS_URL must be set in a production environment: the authorization codes have to be shared by the replicas, or HUB_ALLOW_MEMORY_STATE=true when the deployment is a single node that accepts it'
      )
    }
  }

  // The secrets that are set are checked wherever they are set: a short
  // secret is a secret that is not a secret.
  if (parsed.HUB_STATE_SECRET && secretBytes(parsed.HUB_STATE_SECRET) < MINIMUM_SECRET_BYTES) {
    problems.push(
      `HUB_STATE_SECRET must be at least ${MINIMUM_SECRET_BYTES} bytes long: it signs and encrypts the state of a login`
    )
  }
  if (
    parsed.HUB_SECRET_ENCRYPTION_KEY &&
    secretBytes(parsed.HUB_SECRET_ENCRYPTION_KEY) < MINIMUM_SECRET_BYTES
  ) {
    problems.push(
      `HUB_SECRET_ENCRYPTION_KEY must be at least ${MINIMUM_SECRET_BYTES} bytes long: it encrypts the client secrets of the tenants at rest`
    )
  }
  if (parsed.HUB_SIGNING_KEY && !isPrivateKeyPem(parsed.HUB_SIGNING_KEY)) {
    problems.push('HUB_SIGNING_KEY must be a PEM private key')
  }

  if (problems.length > 0) {
    throw new Error(`the environment is invalid: ${problems.join('; ')}`)
  }

  return {
    environment: parsed.HUB_ENVIRONMENT,
    production,
    network: {
      host: parsed.HUB_HOST,
      port: parsed.HUB_PORT,
    },
    public: {
      issuer: issuer!,
      publicUrl: publicUrl!,
    },
    database: {
      driver,
      url: databaseUrl,
      path: databasePath,
    },
    store: {
      url: parsed.HUB_REDIS_URL,
      allowMemoryState: parsed.HUB_ALLOW_MEMORY_STATE ?? false,
    },
    admin: {
      token: parsed.HUB_ADMIN_TOKEN,
    },
    access: {
      token: parsed.HUB_ACCESS_TOKEN,
      contextTokens: parsed.HUB_ACCESS_CONTEXT_TOKENS,
    },
    metrics: {
      token: parsed.HUB_METRICS_TOKEN,
    },
    secrets: {
      stateSecret: parsed.HUB_STATE_SECRET,
      encryptionKey: parsed.HUB_SECRET_ENCRYPTION_KEY,
    },
    signing: {
      key: parsed.HUB_SIGNING_KEY,
      kid: parsed.HUB_SIGNING_KID,
      previousKey: parsed.HUB_PREVIOUS_SIGNING_KEY,
      previousKid: parsed.HUB_PREVIOUS_SIGNING_KID,
    },
    timeouts: {
      idpTimeoutMs: parsed.HUB_IDP_TIMEOUT_MS,
      decisionTimeoutMs: parsed.HUB_DECISION_TIMEOUT_MS,
      clockSkewSeconds: parsed.HUB_CLOCK_SKEW_SECONDS,
    },
    observability: {
      logLevel: parseLogLevel(parsed.HUB_LOG_LEVEL),
    },
  }
}
