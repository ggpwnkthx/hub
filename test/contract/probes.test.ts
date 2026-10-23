import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createRuntime, type HubRuntime } from '../../src/runtime/composition'
import { readEnv } from '../../src/runtime/env'

/** The runtime the probes are asked on. */
let runtime: HubRuntime
/** The base url of the runtime. */
let base: string

beforeAll(async () => {
  runtime = await createRuntime(
    readEnv({
      HUB_HOST: '127.0.0.1',
      HUB_PORT: '0',
      HUB_DATABASE_URL: 'pglite://memory://',
    })
  )
  base = `http://127.0.0.1:${runtime.listener.port}`
})

afterAll(async () => {
  await runtime.listener.stop(true)
})

describe('the probes of Hub', () => {
  test('the health says that the process answers', async () => {
    const response = await fetch(`${base}/healthz`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'hub',
      version: '1.0.0',
    })
  })

  test('the readiness is ready when the database answers', async () => {
    const response = await fetch(`${base}/readyz`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready' })
  })

  test('the readiness is not ready when the database is down', async () => {
    await runtime.database.close()
    try {
      const response = await fetch(`${base}/readyz`)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'not-ready' })
    } finally {
      // The database is closed for the rest of the file: the other probes
      // do not need it.
      await runtime.database.close().catch(() => undefined)
    }
  })

  test('the readiness is draining while the service drains', async () => {
    runtime.setDraining(true)
    try {
      const response = await fetch(`${base}/readyz`)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ status: 'draining' })
    } finally {
      runtime.setDraining(false)
    }
  })

  test('every answer carries the identifier of the request', async () => {
    const generated = await fetch(`${base}/healthz`)
    expect(generated.headers.get('x-request-id')).toBeTruthy()

    const reused = await fetch(`${base}/healthz`, { headers: { 'x-request-id': 'the-request' } })
    expect(reused.headers.get('x-request-id')).toBe('the-request')
  })

  test('an unknown path is refused', async () => {
    const response = await fetch(`${base}/v1/unknown`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'not_found',
      message: 'unknown path',
    })
  })
})
