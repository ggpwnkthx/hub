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
import { createLogger, type Logger } from '../observability'
import { startListener, type StartedListener } from '../platform/bun/listener'
import {
  createDatabase,
  MIGRATIONS_DIRECTORY,
  MIGRATIONS_TABLE,
  runMigrations,
  type Database,
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

  // The service stops accepting new work when it drains.
  const state = { draining: false }

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
  }

  const app = createHubApp(dependencies)
  const listener = startListener({
    app: createHubHandler(app),
    host: settings.network.host,
    port: settings.network.port,
    onError: (error) => logger.error('the listener reported an error', { error }),
  })

  const closeResources = async (): Promise<void> => {
    await database.close()
  }

  return {
    settings,
    logger,
    database,
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
