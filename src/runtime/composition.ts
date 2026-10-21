/**
 * The composition root of Hub.
 *
 * This is the only place where the concrete pieces are assembled: the
 * environment is read here, the clients and the stores are created here,
 * the domains are wired together here and the listener is started here.
 * Everything else receives its dependencies.
 */

import { createHubApp, createHubHandler } from '../app/app'
import { LoginService, ProviderClient, createStateCipher } from '../domains/identity'
import { CodeService, ProviderService } from '../domains/provider'
import { assertCallableAddress } from '../platform/bun/address'
import { createFetchTransport } from '../platform/bun/http'
import { createStoreClient, MemoryCodeStore, RedisCodeStore } from '../platform/redis/store'
import type { HubDependencies } from '../app/dependencies'
import { createAdministrationService } from './adapters'
import { createLogger, MetricsStore, type Logger, type Observer } from '../observability'
import { startListener, type StartedListener } from '../platform/bun/listener'
import {
  createDatabase,
  createSecretCipher,
  createTracedClient,
  DecisionRepository,
  GrantRepository,
  MIGRATIONS_DIRECTORY,
  MIGRATIONS_TABLE,
  PermissionRepository,
  runMigrations,
  TenantRepository,
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
  /** The database of the four tables. */
  database: Database
  /** The cipher of the client secrets, when the deployment has a key. */
  secrets?: SecretCipher
  /** The storage of the four tables. */
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

/** The storage of the four tables, as the domains receive it. */
export interface HubRepositories {
  tenants: TenantRepository
  users: UserRepository
  permissions: PermissionRepository
  grants: GrantRepository
}

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

  // The database of the four tables. A deployment talks to a PostgreSQL
  // server and a development machine runs the embedded PostgreSQL of the
  // process: both are PostgreSQL and the migrations are the same.
  const database = await createDatabase({
    driver: settings.database.driver,
    url: settings.database.url,
    path: settings.database.path,
  })

  // The schema is applied before the listener accepts: Hub does not start
  // against a schema it does not understand.
  const migrations = await runMigrations({ database, directory: MIGRATIONS_DIRECTORY, logger })
  const knownMigrations = migrations.applied.length + migrations.alreadyApplied.length
  logger.info('the schema is up to date', {
    driver: database.driver,
    applied: migrations.applied.length,
    known: knownMigrations,
  })

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
  const login = new LoginService({
    tenants: {
      findByClientId: async (clientId: string) => {
        const tenant = await repositories.tenants.findByClientId(clientId)
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
          scopes: tenant.idpScopes,
          algorithms: tenant.idpAlgorithms,
        }
      },
      findBySlug: async (slug: string) => {
        const tenant = await repositories.tenants.findBySlug(slug)
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
          scopes: tenant.idpScopes,
          algorithms: tenant.idpAlgorithms,
        }
      },
      findByEmailDomain: async (emailDomain: string) => {
        const tenant = await repositories.tenants.findByEmailDomain(emailDomain)
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
          scopes: tenant.idpScopes,
          algorithms: tenant.idpAlgorithms,
        }
      },
      findDefault: async () => {
        const tenant = await repositories.tenants.findDefault()
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
          scopes: tenant.idpScopes,
          algorithms: tenant.idpAlgorithms,
        }
      },
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
    clientOf: async (tenant) => {
      const secret = await repositories.tenants.readProviderSecret(tenant.id)
      return new ProviderClient({
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
        return tenant ? { id: tenant.id, clientId: tenant.clientId } : null
      },
      gatewaySecret: async (tenantId: string) =>
        await repositories.tenants.readGatewaySecret(tenantId),
    },
    cookieSecure: settings.production,
    // The decision of the gateway: one statement over the tables of the
    // policy, with the deadline of the deployment.
    decisions: new DecisionRepository(traced, settings.timeouts.decisionTimeoutMs),
    accessToken: settings.access.token,
    metricsToken: settings.metrics.token,
    // The administration of the platform: the five endpoints of the
    // specification, and nothing else.
    administration: createAdministrationService({
      tenants: repositories.tenants,
      users: repositories.users,
      permissions: repositories.permissions,
      grants: repositories.grants,
      token: settings.admin.token,
      publicUrl: settings.public.publicUrl,
    }),
    publicUrl: settings.public.publicUrl,
    peerAddress: (request: Request) => peer.address(request),
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
