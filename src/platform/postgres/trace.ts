/**
 * The trace of the queries (HUB-015).
 *
 * Every statement of the database is timed: the duration and the number
 * of the rows are written in the log, and a statement that is slower than
 * the threshold is a warning. The decision of the gateway is on the path
 * of every request of a deployment: a query that slows down is a fact
 * the operator has to see before it is a page of the postmortem.
 */

import type { Logger } from '../../observability'
import type { SqlClient } from './database'

/** The statements that are slower than this are a warning. */
export const SLOW_QUERY_MS = 50

export interface TraceOptions {
  /** The logger of the service. */
  logger: Logger
  /** The threshold above which a statement is a warning. */
  thresholdMs?: number
  /** The name of the statement, when it is not the same for every one. */
  name?: string
}

/**
 * Wraps a client of the database with the trace of its statements.
 *
 * The trace never changes the result of a statement and never changes
 * its failures: a statement that fails is a failure, with its error.
 */
export function createTracedClient(client: SqlClient, options: TraceOptions): SqlClient {
  const thresholdMs = options.thresholdMs ?? SLOW_QUERY_MS
  const name = options.name ?? 'query'

  const trace = async <T>(text: string, run: () => Promise<T>): Promise<T> => {
    const started = Date.now()
    try {
      const result = await run()
      const durationMs = Date.now() - started
      const rows = Array.isArray(result) ? result.length : undefined
      // The statement is written, the values are not: the values of a
      // statement may be a secret.
      const fields = {
        statement: name,
        sql: text.replace(/\s+/g, ' ').trim().slice(0, 200),
        durationMs,
        ...(rows === undefined ? {} : { rows }),
      }
      if (durationMs > thresholdMs) {
        options.logger.warn('the statement is slow', fields)
      } else {
        options.logger.debug('the statement was answered', fields)
      }
      return result
    } catch (error) {
      const durationMs = Date.now() - started
      options.logger.warn('the statement failed', { statement: name, durationMs, error })
      throw error
    }
  }

  return {
    driver: client.driver,
    query: (text, params = []) => trace(text, async () => await client.query(text, params)),
    exec: (text) => trace(text, async () => await client.exec(text)),
    transaction: async (fn) => await client.transaction(async (inner) => await fn(inner)),
  }
}
