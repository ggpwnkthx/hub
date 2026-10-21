/**
 * The state of a request of Hub.
 *
 * The state travels with the request: the identifier of the request and the
 * moment it arrived. The identifier is in every log line of the request and
 * in the answer, so a caller can follow its request.
 */

export interface HubState {
  /** The identifier of the request; it is in every log line of the request. */
  requestId: string
  /** The moment the request arrived, in milliseconds. */
  startedAt: number
}

/**
 * The environment of the application.
 *
 * The bindings are the capabilities of the runtime. Hub has none for now:
 * the probes and the endpoints of the protocol are answered by the
 * application itself.
 */
export interface HubEnv {
  Bindings: Record<string, never>
  Variables: HubState
}
