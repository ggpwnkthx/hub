/**
 * The outbound calls of Hub.
 *
 * The platform owns the network: the calls of the providers of the tenants
 * go through here, with a timeout and without a redirect that a provider
 * could use to send the credentials of the deployment somewhere else.
 */

import type { HttpTransport, TransportResponse } from '../../domains/identity'

/**
 * The transport of the outbound calls.
 *
 * A call that takes too long is a failure: a provider that is slow must
 * not hold a login forever.
 */
export function createFetchTransport(): HttpTransport {
  return {
    call: async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string; timeoutMs: number }
    ): Promise<TransportResponse> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), init.timeoutMs)
      timer.unref?.()
      try {
        const response = await fetch(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
          redirect: 'error',
        })
        return { status: response.status, body: await response.text() }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
