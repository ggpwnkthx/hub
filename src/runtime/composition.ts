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
import type { RuntimeSettings } from './env'
import { drain as drainRuntime } from './lifecycle'
import { VERSION } from './version'

/** The runtime of Hub. */
export interface HubRuntime {
  /** The settings the runtime was built with. */
  settings: RuntimeSettings
  /** The logger of the service. */
  logger: Logger
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
export function createRuntime(settings: RuntimeSettings): HubRuntime {
  const logger = createLogger({
    level: settings.observability.logLevel,
    bindings: { service: 'hub' },
  })

  // The service stops accepting new work when it drains.
  const state = { draining: false }

  const dependencies: HubDependencies = {
    version: VERSION,
    logger,
    // The readiness of Hub is the health of its dependencies. The database
    // is not connected yet: the client of PostgreSQL and the migrations
    // arrive with the milestone of the database, and the readiness probe
    // answers 503 until then.
    probe: {
      ready: async () => false,
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
    // The clients and the stores of the service are closed here, when the
    // database and the shared store are connected.
  }

  return {
    settings,
    logger,
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
