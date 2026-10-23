/**
 * The listener of Hub.
 *
 * The platform owns the socket: it starts the listener, it knows the
 * address of the peer of a request and it stops accepting when the runtime
 * drains.
 */

/**
 * The application, as the listener sees it.
 *
 * The platform does not know the application and it does not know the
 * framework of the application: it knows that something answers a request.
 */
interface RequestHandler {
  handle(request: Request, env: never): Response | Promise<Response>
}

export interface ListenerOptions {
  /** The application that answers the requests. */
  app: RequestHandler
  /** The address the listener binds to. */
  host: string
  /** The port the listener binds to. */
  port: number
  /** Called when the runtime of the server reports an error. */
  onError?: (error: unknown) => void
}

export interface StartedListener {
  /** The port the listener listens on. */
  port: number
  /** The url of the listener. */
  url: string
  /**
   * The address of the peer of a request.
   *
   * It is the address of the socket: Hub needs it to know the address of a
   * caller, which is the key of the rate limit of the administration.
   */
  peerAddress: (request: Request) => string
  /** Stops the listener; `force` closes the connections that are open. */
  stop: (force: boolean) => Promise<void>
}

/**
 * Starts the listener of Hub.
 *
 * The peer address of a request is the address of the socket: the address
 * of the peer is not the one of a forwarding header, which a caller
 * controls.
 */
export function startListener(options: ListenerOptions): StartedListener {
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    // The idle timeout of the connections of the runtime.
    idleTimeout: 120,
    fetch(request) {
      return options.app.handle(request, undefined as never)
    },
    error(error) {
      options.onError?.(error)
    },
  } as Parameters<typeof Bun.serve>[0])

  return {
    port: server.port ?? 0,
    url: `http://${options.host}:${server.port}`,
    peerAddress: (request: Request) => {
      const address = server.requestIP(request)
      return address?.address ?? '0.0.0.0'
    },
    stop: async (force: boolean) => {
      await server.stop(force)
    },
  }
}
