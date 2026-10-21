import { describe, expect, test } from 'bun:test'
import { createSilentLogger, type LogFields, type Logger } from '../../observability'
import type { SqlClient } from './database'
import { createTracedClient, SLOW_QUERY_MS } from './trace'

/** A logger that keeps what it was given. */
function recordingLogger(): { logger: Logger; lines: { level: string; fields: LogFields }[] } {
  const lines: { level: string; fields: LogFields }[] = []
  const record = (level: string) => (_message: string, fields?: LogFields) => {
    lines.push({ level, fields: fields ?? {} })
  }
  return {
    lines,
    logger: {
      level: 'debug',
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  }
}

/** A client that answers what it is given. */
function fakeClient(rows: unknown[] = []): SqlClient {
  return {
    driver: 'pglite',
    query: async <T>() => rows as T[],
    exec: async () => undefined,
    transaction: async (fn) => await fn(fakeClient(rows)),
  }
}

describe('the trace of the queries', () => {
  test('every statement is timed and counted', async () => {
    const { logger, lines } = recordingLogger()
    const traced = createTracedClient(fakeClient([{ a: 1 }]), { logger })
    await traced.query('select 1', [])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('debug')
    expect(lines[0]?.fields.durationMs).toBeGreaterThanOrEqual(0)
    expect(lines[0]?.fields.rows).toBe(1)
  })

  test('a statement that is slow is a warning', async () => {
    const { logger, lines } = recordingLogger()
    const slow: SqlClient = {
      ...fakeClient(),
      query: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return []
      },
    }
    const traced = createTracedClient(slow, { logger, thresholdMs: 10 })
    await traced.query('select 1', [])
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.fields.durationMs).toBeGreaterThanOrEqual(30)
  })

  test('a statement that fails is a warning and the failure is the failure', async () => {
    const { logger, lines } = recordingLogger()
    const failing: SqlClient = {
      ...fakeClient(),
      query: async () => {
        throw new Error('the database is down')
      },
    }
    const traced = createTracedClient(failing, { logger })
    expect(traced.query('select 1', [])).rejects.toThrow('the database is down')
    expect(lines[0]?.level).toBe('warn')
  })

  test('the threshold of the trace is the one of the operations', () => {
    expect(SLOW_QUERY_MS).toBe(50)
  })

  test('a silent logger writes nothing', async () => {
    const traced = createTracedClient(fakeClient(), { logger: createSilentLogger() })
    await expect(traced.query('select 1', [])).resolves.toEqual([])
  })
})
