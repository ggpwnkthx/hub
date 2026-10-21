/**
 * The pieces the application is built with.
 *
 * The application knows the interfaces of the domains and the observation
 * interfaces, never a concrete adapter: the runtime assembles the pieces
 * and hands them over here.
 */

import type { Logger } from '../observability'

/**
 * The probe of the readiness.
 *
 * The readiness of Hub is the health of its dependencies: the database has
 * to answer and the migrations have to be applied. The port is implemented
 * by the platform of the database, and the runtime hands it over.
 */
export interface ReadinessProbe {
  /** True when the dependencies of the service answer. */
  ready: () => Promise<boolean>
}

/** Everything the application needs to answer a request. */
export interface HubDependencies {
  /** The version of Hub, as the health endpoint reports it. */
  version: string
  /** The logger of the service. */
  logger: Logger
  /** The probe of the readiness. */
  probe: ReadinessProbe
  /** True while the service is draining: it does not accept new work. */
  isDraining: () => boolean
}
