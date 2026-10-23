/**
 * The composition root of Hub.
 *
 * This is the only place where the concrete pieces are assembled: the
 * environment is read here, the clients and the stores are created here,
 * the domains are wired together here and the listener is started here.
 * Everything else receives its dependencies.
 */

import { createHubApp, createHubHandler } from '../app/app'
import type { AdminCredential } from '../domains/administration'
import type { AccessContextCredential } from '../app/access-context'
import { LoginService, ProviderClient, createStateCipher } from '../domains/identity'
import type { TenantOfLogin } from '../domains/identity'
import { CodeService, ProviderService } from '../domains/provider'
import { assertCallableAddress } from '../platform/bun/address'
import { createFetchTransport } from '../platform/bun/http'
import {
  createStoreClient,
  MemoryAuthenticationFailures,
  MemoryCodeStore,
  RedisAuthenticationFailures,
  RedisCodeStore,
} from '../platform/redis/store'
import type { HubDependencies } from '../app/dependencies'
import { createAdministrationService } from './adapters'
import { createLogger, MetricsStore, type Logger, type Observer } from '../observability'
import { startListener, type StartedListener } from '../platform/bun/listener'
import {
  createDatabase,
  createSecretCipher,
  createTracedClient,
  AccessContextRepository,
  AuditRepository,
  DecisionRepository,
  GrantRepository,
  GroupRepository,
  MIGRATIONS_TABLE,
  PermissionRepository,
  resolveMigrationsDirectory,
  roleOf,
  runMigrations,
  TenantRepository,
  type TenantRow,
  UserRepository,
  type Database,
  type SecretCipher,
} from '../platform/postgres'
import type { RuntimeSettings } from './env'
import { drain as drainRuntime } from './lifecycle'
import { VERSION } from './version'

/** The runtime of Hub. */
export interface HubRuntime {
  /** The settings the runtime was built with. */
  settings: RuntimeSettings
  /** The logger of the service. */
  logger: Logger
  /** The observer of the service. */
  observer: Observer
  /** The database of the five tables. */
  database: Database
  /** The cipher of the client secrets, when the deployment has a key. */
  secrets?: SecretCipher
  /** The storage of the five tables. */
  repositories: HubRepositories
  /** The listener of the service. */
  listener: StartedListener
  /** True while the service is draining. */
  isDraining: () => boolean
  /** Stops the admission of new work. */
  setDraining: (draining: boolean) => void
  /** Drains the service and closes everything it owns. */
  drain: (reason: string) => Promise<void>
  /** Closes everything the runtime owns. */
  close: () => Promise<void>
}

/** The storage of the five tables, as the domains receive it. */
export interface HubRepositories {
  tenants: TenantRepository
  users: UserRepository
  permissions: PermissionRepository
  grants: GrantRepository
}

/** The lifetime of the client of a provider of a tenant. */
const PROVIDER_CLIENT_TTL_MS = 600_000

/**
 * Builds the runtime of Hub.
 *
 * The dependencies of the domains are assembled here and nowhere else: a
 * domain never builds a client and never reads the environment.
 */
export async function createRuntime(settings: RuntimeSettings): Promise<HubRuntime> {
  const logger = createLogger({
    level: settings.observability.logLevel,
    bindings: { service: 'hub' },
  })
  const observer = new MetricsStore()

  // The database of the five tables. A deployment talks to a PostgreSQL
  // server and a development machine runs the embedded PostgreSQL of the
  // process: both are PostgreSQL and the migrations are the same.
  const database = await createDatabase({
    driver: settings.database.driver,
    url: settings.database.url,
    path: settings.database.path,
    // The deadline of the statements of the service is the one of the
    // tightest deadline of the service: it is the deadline of the
    // decision. The server stops the statement that takes too long and
    // the connection of the pool is given back at once.
    statementTimeoutMs: settings.timeouts.decisionTimeoutMs,
  })

  // The schema is applied before the listener accepts: Hub does not start
  // against a schema it does not understand.
  const migrations = await runMigrations({
    database,
    directory: resolveMigrationsDirectory(),
    logger,
  })
  const knownMigrations = migrations.applied.length + migrations.alreadyApplied.length
  logger.info('the schema is up to date', {
    driver: database.driver,
    applied: migrations.applied.length,
    known: knownMigrations,
  })

  // The isolation of the tenants is enforced by the database, and the
  // policies of the tables are only policies for a role that is subject
  // to them. A superuser and a role with BYPASSRLS are not: a production
  // deployment refuses to start with such a role, because the isolation
  // would be a promise and not a rule (spec §3.7).
  if (settings.production) {
    const role = await roleOf(database)
    if (role.superuser || role.bypassesRowLevelSecurity) {
      throw new Error(
        `the role "${role.name}" of the database bypasses the isolation of the tenants: a production deployment needs a role that is not a superuser and that does not have BYPASSRLS (spec §3.8)`
      )
    }
    logger.info('the isolation of the tenants is enforced by the database', { role: role.name })
  }

  // The cipher of the client secrets at rest. Without a key the service
  // cannot store the secrets of a tenant: the administration answers that
  // the deployment is not configured for it, and it does not store them in
  // clear.
  const secrets = settings.secrets.encryptionKey
    ? createSecretCipher(settings.secrets.encryptionKey)
    : undefined
  if (!secrets) {
    logger.warn('the client secrets cannot be encrypted: the key of the deployment is not set')
  }

  // Every statement of the repositories is timed: a query that slows down
  // is a fact the operator has to see.
  const traced = createTracedClient(database, { logger })
  const repositories: HubRepositories = {
    tenants: new TenantRepository(traced, secrets),
    users: new UserRepository(traced),
    permissions: new PermissionRepository(traced),
    grants: new GrantRepository(traced),
  }

  // The service stops accepting new work when it drains.
  const state = { draining: false }

  // The address of the peer of a request is known by the listener, which
  // is built after the application: the holder is filled in below.
  const peer = { address: (_request: Request) => '0.0.0.0' }

  // The store of the authorization codes. It is shared by the replicas of
  // a deployment: a code that lives in the memory of one replica is
  // unknown to the others.
  const transport = createFetchTransport()
  // The clients of the providers of the tenants, one per tenant (spec
  // §6.6).
  const providerClients = new Map<string, { client: ProviderClient; at: number }>()
  const storeClient = settings.store.url
    ? await createStoreClient({
        url: settings.store.url,
        onError: (error) => {
          logger.warn('the shared store is not reachable', { error })
          observer.recordStoreError('redis')
        },
      })
    : undefined
  const codes = new MemoryCodeStore()
  const codeStore = storeClient ? new RedisCodeStore(storeClient) : codes

  // The count of the failed authentications of the administration. It is
  // the shared store when the deployment has one: the window of the
  // limiter is the window of the deployment and not the window of a
  // replica (spec §10.1). A deployment that keeps its state in the
  // process is a single node, and its count is the count of the
  // deployment.
  const failures = storeClient
    ? new RedisAuthenticationFailures(storeClient)
    : new MemoryAuthenticationFailures()

  // The provider of the gateway: the keys, the discovery document and the
  // tokens of the principal.
  const provider = new ProviderService({
    signingKey: settings.signing.key,
    signingKid: settings.signing.kid,
    previousSigningKey: settings.signing.previousKey,
    previousSigningKid: settings.signing.previousKid,
    issuer: settings.public.issuer,
    publicUrl: settings.public.publicUrl,
    roles: {
      roleKeys: async (userId: string) => await repositories.grants.findLivePermissionKeys(userId),
    },
    principals: {
      findById: async (id: string) => {
        const principal = await repositories.users.findById(id)
        if (!principal) return null
        return {
          id: principal.id,
          email: principal.email,
          displayName: principal.displayName,
          status: principal.status,
        }
      },
    },
    audiences: {
      isKnown: async (clientId: string) =>
        (await repositories.tenants.findByClientId(clientId)) !== null,
    },
    onRolesDropped: (count, subject) => {
      logger.warn('the roles of the token are capped', { subject, dropped: count })
    },
  })
  await provider.load()
  if (!provider.ready) {
    logger.warn('the service cannot issue a token: it has no signing key')
  }

  // The login of the callers: the tenant of the login, the state of the
  // login, the provider of the tenant and the mapping of the identity.
  //
  // The tenant of the login is read four ways: by the client id of the
  // gateway, by the slug, by the domain of an e-mail and as the default
  // of the platform. Every way answers the same shape of the tenant.
  const tenantOfLogin = (tenant: TenantRow | null): TenantOfLogin | null => {
    if (!tenant) return null
    return {
      id: tenant.id,
      slug: tenant.slug,
      enabled: tenant.enabled,
      sharedClient: tenant.sharedClient,
      isDefault: tenant.isDefault,
      autoProvision: tenant.autoProvision,
      issuer: tenant.idpIssuer,
      idpClientId: tenant.idpClientId,
      idpRedirectUri: tenant.idpRedirectUri,
      emailDomain: tenant.emailDomain,
      clientId: tenant.clientId,
      clientRedirectUris: tenant.clientRedirectUris,
      scopes: tenant.idpScopes,
      algorithms: tenant.idpAlgorithms,
    }
  }

  const login = new LoginService({
    tenants: {
      findByClientId: async (clientId: string) =>
        tenantOfLogin(await repositories.tenants.findByClientId(clientId)),
      findBySlug: async (slug: string) =>
        tenantOfLogin(await repositories.tenants.findBySlug(slug)),
      findByEmailDomain: async (emailDomain: string) =>
        tenantOfLogin(await repositories.tenants.findByEmailDomain(emailDomain)),
      findDefault: async () => tenantOfLogin(await repositories.tenants.findDefault()),
    },
    principals: {
      findByExternalSubject: async (tenantId: string, externalSubject: string) => {
        const principal = await repositories.users.findByExternalSubject(tenantId, externalSubject)
        if (!principal) return null
        return {
          id: principal.id,
          tenantId: principal.tenantId,
          tenantSlug: principal.tenantSlug,
          externalSubject: principal.externalSubject,
          email: principal.email,
          displayName: principal.displayName,
          status: principal.status,
        }
      },
      create: async (principal) => {
        const created = await repositories.users.create(principal)
        return {
          id: created.id,
          tenantId: created.tenantId,
          tenantSlug: created.tenantSlug,
          externalSubject: created.externalSubject,
          email: created.email,
          displayName: created.displayName,
          status: created.status,
        }
      },
    },
    state: createStateCipher(settings.secrets.stateSecret ?? 'the-state-of-the-development'),
    // The client of the provider of a tenant is kept for ten minutes: the
    // discovery document and the keys of the provider are cached in it,
    // and a login does not call the provider on every request (spec
    // §6.6). A change of the registration of a tenant drops its client.
    clientOf: async (tenant) => {
      const cached = providerClients.get(tenant.id)
      if (cached && Date.now() - cached.at < PROVIDER_CLIENT_TTL_MS) {
        return cached.client
      }
      const secret = await repositories.tenants.readProviderSecret(tenant.id)
      const client = new ProviderClient({
        issuer: tenant.issuer,
        clientId: tenant.idpClientId,
        clientSecret: secret ?? '',
        redirectUri: tenant.idpRedirectUri,
        scopes: tenant.scopes,
        algorithms: tenant.algorithms,
        transport,
        guard: {
          assert: async (url: string) =>
            await assertCallableAddress(url, { allowPrivate: !settings.production }),
        },
        cacheTtlMs: 600_000,
      })
      providerClients.set(tenant.id, { client, at: Date.now() })
      return client
    },
    secret: settings.secrets.stateSecret ?? 'the-state-of-the-development',
    clockSkewSeconds: settings.timeouts.clockSkewSeconds,
    algorithmsOf: (tenant) => tenant.algorithms,
  })

  // The codes of the logins and their exchange.
  const codeService = new CodeService({
    store: codeStore,
    principals: {
      findById: async (id: string) => {
        const principal = await repositories.users.findById(id)
        if (!principal) return null
        return {
          id: principal.id,
          email: principal.email,
          displayName: principal.displayName,
          tenantSlug: principal.tenantSlug,
          status: principal.status,
        }
      },
    },
    tokens: {
      issueTokens: async (subject) => await provider.issueTokens(subject),
    },
  })

  const dependencies: HubDependencies = {
    version: VERSION,
    logger,
    // The readiness of Hub is the health of its dependencies: the database
    // has to answer and the migrations have to be applied.
    probe: {
      ready: async () => {
        try {
          await database.query('select 1')
          const rows = await database.query<{ count: number }>(
            `select count(*)::int as count from ${MIGRATIONS_TABLE}`
          )
          return rows[0]?.count === knownMigrations
        } catch {
          return false
        }
      },
    },
    isDraining: () => state.draining,
    observer,
    provider,
    login,
    codes: codeService,
    tenants: {
      findByClientId: async (clientId: string) => {
        const tenant = await repositories.tenants.findByClientId(clientId)
        return tenant
          ? {
              id: tenant.id,
              slug: tenant.slug,
              clientId: tenant.clientId,
              sharedClient: tenant.sharedClient,
            }
          : null
      },
      gatewaySecrets: async (tenantId: string) =>
        await repositories.tenants.readGatewaySecrets(tenantId),
    },
    cookieSecure: settings.production,
    // The decision of the gateway: one statement over the tables of the
    // policy, with the deadline of the deployment.
    decisions: new DecisionRepository(traced, settings.timeouts.decisionTimeoutMs),
    accessToken: settings.access.token,
    previousAccessToken: settings.access.previousToken,
    // The access context contract: the same tables of the policy, read
    // with the complete set of the keys of the grants.
    accessContexts: new AccessContextRepository(traced),
    accessContextCredentials: readAccessContextCredentials(settings.access.contextTokens),
    metricsToken: settings.metrics.token,
    // The administration of the platform: the nine endpoints of the
    // specification, and nothing else.
    administration: createAdministrationService({
      tenants: repositories.tenants,
      users: repositories.users,
      groups: new GroupRepository(traced),
      permissions: repositories.permissions,
      grants: repositories.grants,
      failures,
      // The audit of the administration: a table of the infrastructure,
      // like the table of the migrations.
      audit: new AuditRepository(traced),
      token: settings.admin.token,
      previousToken: settings.admin.previousToken,
      credentials: readAdminCredentials(settings.admin.credentials),
      publicUrl: settings.public.publicUrl,
      // The registration of a tenant changed: its client of the provider
      // is dropped, so that the next login builds a new one (spec §6.6).
      onTenantChanged: (tenantId: string) => {
        providerClients.delete(tenantId)
      },
    }),
    publicUrl: settings.public.publicUrl,
    peerAddress: (request: Request) => peer.address(request),
    // The notice of the deprecated bearer token is written once per service.
    sharedTokenNoticeWritten: false,
  }

  const app = createHubApp(dependencies)
  const listener = startListener({
    app: createHubHandler(app),
    host: settings.network.host,
    port: settings.network.port,
    onError: (error) => logger.error('the listener reported an error', { error }),
  })
  peer.address = listener.peerAddress

  const closeResources = async (): Promise<void> => {
    await storeClient?.quit()
    await database.close()
  }

  return {
    settings,
    logger,
    observer,
    database,
    secrets,
    repositories,
    listener,
    setDraining: (draining: boolean) => {
      state.draining = draining
    },
    isDraining: () => state.draining,
    drain: async (reason: string) => {
      await drainRuntime(
        {
          logger,
          stopListener: (force) => listener.stop(force),
          closeResources,
          setDraining: (draining) => {
            state.draining = draining
          },
        },
        reason
      )
    },
    close: closeResources,
  }
}

/**
 * Reads the credentials of the administration (spec §10.1).
 *
 * The value is a json object: every key is a bearer token and every
 * value holds the scope of that token. A value of `null` is the scope of
 * the platform: the credential may act for every tenant. A value of an
 * object holds the slug of the tenant the credential may act for and the
 * name of its operator.
 *
 * A malformed value stops the service: a credential that is not
 * understood is a credential that is not scoped.
 */
export function readAdminCredentials(raw: string | undefined): AdminCredential[] {
  if (!raw || raw.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('HUB_ADMIN_TOKENS must be a json object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HUB_ADMIN_TOKENS must be a json object')
  }
  const credentials: AdminCredential[] = []
  for (const [token, scope] of Object.entries(parsed as Record<string, unknown>)) {
    if (token.length < 16) {
      throw new Error('a credential of the administration is at least 16 characters long')
    }
    if (scope === null) {
      credentials.push({ token, tenant: null, operator: null })
      continue
    }
    if (typeof scope !== 'object' || Array.isArray(scope)) {
      throw new Error(
        'the scope of a credential of the administration is an object with a tenant, or null'
      )
    }
    const value = scope as { tenant?: unknown; operator?: unknown }
    if (typeof value.tenant !== 'string' || value.tenant.trim().length === 0) {
      throw new Error('the tenant of a credential of the administration is the slug of a tenant')
    }
    if (
      value.operator !== undefined &&
      value.operator !== null &&
      typeof value.operator !== 'string'
    ) {
      throw new Error('the operator of a credential of the administration is a name')
    }
    const operator =
      typeof value.operator === 'string' && value.operator.trim().length > 0
        ? value.operator.trim()
        : null
    credentials.push({ token, tenant: value.tenant.trim(), operator })
  }
  return credentials
}

/**
 * Reads the credentials of the access context contract.
 *
 * The value is a json object: every key is a bearer token and every
 * value holds the tenants the token may ask about. A malformed value
 * stops the service: a credential that is not understood is a credential
 * that is not scoped.
 */
function readAccessContextCredentials(raw: string | undefined): AccessContextCredential[] {
  if (!raw || raw.trim().length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('HUB_ACCESS_CONTEXT_TOKENS must be a json object')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HUB_ACCESS_CONTEXT_TOKENS must be a json object')
  }
  const credentials: AccessContextCredential[] = []
  for (const [token, scope] of Object.entries(parsed as Record<string, unknown>)) {
    if (token.length < 16) {
      throw new Error('a credential of the access context is at least 16 characters long')
    }
    if (scope === null) {
      credentials.push({ token, tenants: null })
      continue
    }
    if (!Array.isArray(scope) || scope.some((entry) => typeof entry !== 'string')) {
      throw new Error('the scope of a credential of the access context is a list of tenants')
    }
    credentials.push({ token, tenants: scope as string[] })
  }
  return credentials
}
