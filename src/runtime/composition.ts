/**
 * The composition root of Hub.
 *
 * This is the only place where the concrete pieces are assembled: the
 * environment is read here, the clients and the stores are created here,
 * the domains are wired together here and the listener is started here.
 * Everything else receives its dependencies.
 */

import { createHubApp, createHubHandler } from '../app/app'
import type { HubDependencies } from '../app/dependencies'
import { createAdministrationService } from './adapters'
import { createLogger, type Logger } from '../observability'
import { startListener, type StartedListener } from '../platform/bun/listener'
import {
  createDatabase,
  createSecretCipher,
  createTracedClient,
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
    await database.close()
  }

  return {
    settings,
    logger,
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
