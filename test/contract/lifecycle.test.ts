import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')

/** The port the process of the tests listens on. */
const port = 18_099

/** Starts the process of Hub and waits for its health. */
async function startHub(env: Record<string, string>): Promise<{
  proc: ReturnType<typeof Bun.spawn>
  base: string
}> {
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`)
      if (response.ok) return { proc, base }
    } catch {
      // The process is not listening yet.
    }
    await Bun.sleep(50)
  }
  proc.kill('SIGKILL')
  throw new Error('the process of Hub did not start')
}

describe('the lifecycle of the process of Hub', () => {
  test('a signal drains the process and the process exits', async () => {
    const { proc, base } = await startHub({
      HUB_DATABASE_URL: 'postgres://localhost:5432/hub',
      HUB_HOST: '127.0.0.1',
      HUB_PORT: String(port),
      HUB_ENVIRONMENT: 'development',
    })

    const started = Date.now()
    proc.kill('SIGTERM')
    const exited = await Promise.race([
      proc.exited,
      Bun.sleep(6_000).then(() => 'timeout' as const),
    ])
    const elapsed = Date.now() - started
    expect(exited).not.toBe('timeout')
    expect(elapsed).toBeLessThan(5_000)
    expect(exited).toBe(0)
    expect(base).toContain('127.0.0.1')
  }, 30_000)

  test('a production environment without a secret stops the process', async () => {
    const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        HUB_ENVIRONMENT: 'production',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(1)
    const stderr = await new Response(proc.stderr).text()
    const line = JSON.parse(stderr.trim().split('\n').pop() ?? '{}') as {
      msg?: string
      error?: string
    }
    expect(line.msg).toBe('the service failed to start')
    expect(line.error).toContain('HUB_ADMIN_TOKEN')
    expect(line.error).toContain('HUB_DATABASE_URL')
  }, 30_000)
})
