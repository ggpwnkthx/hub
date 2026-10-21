import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { againstServer } from './database'
import { createDatabase, MIGRATION_STATEMENT_TIMEOUT_MS } from '../../src/platform/postgres'
import type { Database } from '../../src/platform/postgres'

/**
 * The deadline of a statement (spec §8.3).
 *
 * The deadline of a decision is a deadline of the server and not of the
 * process: a statement that takes too long is stopped by PostgreSQL, the
 * transaction is rolled back and the connection of the pool is given
 * back at once. A deadline that lives only in the memory of the process
 * lets a statement keep a connection of the pool for as long as the
 * server takes to answer it.
 *
 * The deadline of the pool is the deadline of its connections: it is set
 * when the connection is opened, and it is the deadline of every
 * statement of that connection.
 *
 * The embedded PostgreSQL of a development machine does not interrupt a
 * statement: the deadline of the server is the one of the deployment,
 * and the whole suite of this file is the one of the tests that run
 * against a server.
 */
let database: Database

beforeAll(async () => {
  if (!againstServer) return
  database = await createDatabase({
    driver: 'postgres',
    url: process.env.HUB_TEST_DATABASE_URL ?? '',
    statementTimeoutMs: 1_000,
  })
})

afterAll(async () => {
  if (!database) return
  await database.close()
})

describe.skipIf(!againstServer)('the deadline of a statement', () => {
  test('the deadline of the pool is the deadline of its connections', async () => {
    const rows = await database.query<{ timeout: string }>(
      `select current_setting('statement_timeout') as timeout`
    )
    expect(rows[0]!.timeout).toBe('1s')
  })

  test('a statement that takes too long is stopped by the server', async () => {
    const started = Date.now()
    let failure: unknown = null
    try {
      await database.query('select pg_sleep(10)')
    } catch (error) {
      failure = error
    }
    const elapsed = Date.now() - started
    expect(failure).not.toBeNull()
    // The server stopped the statement at its deadline: it did not wait
    // for the ten seconds of the sleep.
    expect(elapsed).toBeLessThan(5_000)
  })

  test('the connection of the migrations raises its own deadline', async () => {
    const lock = await database.lockMigrations()
    try {
      const rows = await database.query<{ timeout: number }>(
        `select setting::int as timeout from pg_settings where name = 'statement_timeout'`
      )
      expect(rows[0]!.timeout).toBe(MIGRATION_STATEMENT_TIMEOUT_MS)
    } finally {
      await lock.release()
    }
  })
})
