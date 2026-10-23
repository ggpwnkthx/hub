/**
 * The outbound calls of Hub.
 *
 * The platform owns the network: the calls of the providers of the tenants
 * go through here, with a timeout, without a redirect that a provider
 * could use to send the credentials of the deployment somewhere else, and
 * to the address that the guard of the addresses checked.
 */

import type { CallTarget, HttpTransport, TransportResponse } from '../../domains/identity'

/**
 * The largest body of an answer that Hub reads.
 *
 * The answers of a provider are the discovery document and the keys: they
 * are small. A provider that answers with a body of several megabytes
 * would fill the memory of the process, and the process that answers a
 * login would die with it.
 */
const MAX_RESPONSE_BYTES = 1_048_576

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
      init: {
        method: string
        headers: Record<string, string>
        body?: string
        timeoutMs: number
        target?: CallTarget
      }
    ): Promise<TransportResponse> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), init.timeoutMs)
      timer.unref?.()
      try {
        const target = init.target
        // The call is made to the address that the guard checked: the name
        // of the host does not resolve it a second time. The name is still
        // in the `Host` header, and the certificate of a secure call is
        // checked against it.
        const headers = target ? { ...init.headers, host: target.host } : init.headers
        const response = await fetch(target?.url ?? url, {
          method: init.method,
          headers,
          body: init.body,
          signal: controller.signal,
          redirect: 'error',
          ...(target?.secure && target.servername
            ? { tls: { serverName: target.servername } }
            : {}),
        })
        return { status: response.status, body: await readBounded(response) }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Reads the body of an answer, up to its ceiling.
 *
 * A body that goes beyond the ceiling is a failure: the answer is not
 * read, and the provider is not reachable.
 */
async function readBounded(response: Response): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error('the answer of the provider is too large')
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks).toString('utf8')
}
