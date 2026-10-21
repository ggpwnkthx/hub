import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

const root = resolve(import.meta.dir, '..', '..')

/** The token of the administration of the tests. */
const TOKEN = 'the-admin-token'

let runtime: HubRuntime
let base: string

beforeAll(async () => {
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
      HUB_ADMIN_TOKEN: TOKEN,
      HUB_SECRET_ENCRYPTION_KEY: 'a'.repeat(64),
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`
})

afterAll(async () => {
  await runtime.listener.stop(true)
  await runtime.database.close()
})

describe('the smoke test of the administration', () => {
  test('the eight calls of the specification answer', async () => {
    const proc = Bun.spawn(['bun', 'run', 'scripts/admin-smoke.ts'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        HUB_URL: base,
        HUB_ADMIN_TOKEN: TOKEN,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('the eight calls of the administration answered')
    // The secrets never reach the output of the tool.
    expect(stdout).not.toContain('the-secret-of-the-provider')
    expect(stdout).not.toContain('the-secret-of-the-gateway')
  }, 30_000)

  test('the state of the smoke test is in the database', async () => {
    const tenants = await runtime.database.query<{ slug: string; enabled: boolean }>(
      'select slug, enabled from tenants where slug = $1',
      ['smoke']
    )
    expect(tenants).toHaveLength(1)
    const users = await runtime.database.query<{ external_subject: string }>(
      'select external_subject from users'
    )
    expect(users.map((row) => row.external_subject)).toContain('the-subject-of-the-smoke-test')
    const grants = await runtime.database.query<{ revoked_at: Date | null }>(
      'select revoked_at from grants'
    )
    expect(grants).toHaveLength(1)
    expect(grants[0]?.revoked_at).toBeInstanceOf(Date)
  })

  test('the tool refuses to run without a token', async () => {
    const proc = Bun.spawn(['bun', 'run', 'scripts/admin-smoke.ts'], {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', HUB_URL: base },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await proc.exited).toBe(1)
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain('HUB_ADMIN_TOKEN')
  }, 30_000)
})
