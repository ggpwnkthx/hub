/**
 * The application of Hub.
 *
 * The application is thin on purpose: it holds the order of the pipeline,
 * it maps the failures of the domains to the answers of the protocol and it
 * writes the headers of the answers. Every rule lives in a domain.
 */

import { randomUUID } from 'node:crypto'
import { Hono, type ExecutionContext } from 'hono'
import type { HubDependencies } from './dependencies'
import {
  grantHandler,
  principalHandler,
  revokeGrantHandler,
  tenantHandler,
  tenantsHandler,
} from './administration'
import { healthHandler, readyHandler } from './endpoints'
import { jsonError } from './errors'
import type { HubEnv, HubState } from './state'

/** The shape of the identifier of a request. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * The identifier of a request.
 *
 * The identifier of the request is reused when it is valid: a client that
 * sends one can follow its request in the logs. An identifier that is not
 * valid is replaced by a generated one: the identifier ends up in a log
 * line and in a header, so it may not carry anything else.
 */
function resolveRequestId(request: Request): string {
  const incoming = request.headers.get('x-request-id')
  if (incoming && REQUEST_ID_PATTERN.test(incoming)) return incoming
  return randomUUID()
}

/** The state of a request that has just arrived. */
function initialState(request: Request): HubState {
  return {
    requestId: resolveRequestId(request),
    startedAt: Date.now(),
  }
}

/**
 * The application, as the listener of the platform sees it.
 *
 * The platform does not know the framework of the application: the
 * application answers the requests itself and hands the platform the
 * capabilities it needs.
 */
export interface HubHandler {
  handle(request: Request, env: HubEnv['Bindings']): Response | Promise<Response>
}

/** Wraps the application of Hub for the listener of the platform. */
export function createHubHandler(app: Hono<HubEnv>): HubHandler {
  const executionCtx: ExecutionContext = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  }
  return {
    handle: (request, env) => app.fetch(request, env, executionCtx),
  }
}

/** Builds the application of Hub. */
export function createHubApp(dependencies: HubDependencies): Hono<HubEnv> {
  const app = new Hono<HubEnv>()

  // The identifier of the request is the first thing: it is in every log
  // line of the request and in the answer.
  app.use('*', async (context, next) => {
    const state = initialState(context.req.raw)
    context.set('requestId', state.requestId)
    context.set('startedAt', state.startedAt)
    await next()
    try {
      context.res.headers.set('x-request-id', state.requestId)
    } catch {
      // The headers of the answer are immutable, there is nothing to do.
    }
    dependencies.logger.debug('the request was answered', {
      requestId: state.requestId,
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Date.now() - state.startedAt,
    })
  })

  // The probes of the service.
  app.get('/healthz', (context) => healthHandler(context, dependencies))
  app.get('/readyz', async (context) => await readyHandler(context, dependencies))

  // The administration of the platform: five endpoints, and they are the
  // whole surface.
  app.post('/v1/admin/tenants', async (context) => await tenantHandler(context, dependencies))
  app.get('/v1/admin/tenants', async (context) => await tenantsHandler(context, dependencies))
  app.post('/v1/admin/users', async (context) => await principalHandler(context, dependencies))
  app.put('/v1/admin/grants', async (context) => await grantHandler(context, dependencies))
  app.delete('/v1/admin/grants/:id', async (context) => revokeGrantHandler(context, dependencies))

  // Every other path is refused: Hub has a fixed surface and the paths
  // that are not part of it are not part of it.
  app.all('*', () => jsonError(404, 'not_found', 'unknown path'))

  app.onError((error, context) => {
    dependencies.logger.error('the service failed to handle the request', {
      requestId: context.get('requestId'),
      error,
    })
    return jsonError(500, 'internal_error', 'the service failed to handle the request')
  })

  return app
}
