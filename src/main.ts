#!/usr/bin/env bun
/**
 * The entry point of Hub.
 *
 * The runtime reads the environment, starts the listener and waits for a
 * termination signal. Everything else lives in the runtime and in the
 * domains.
 */
import { readEnv } from './runtime/env'
import { createRuntime } from './runtime/composition'
import { VERSION } from './runtime/version'

async function main(): Promise<void> {
  // The environment is read in one place, and it is validated as a whole.
  const settings = readEnv()
  const runtime = await createRuntime(settings)

  runtime.logger.info('the listener started', {
    version: VERSION,
    environment: settings.environment,
    hub: `http://${settings.network.host}:${runtime.listener.port}`,
    issuer: settings.public.issuer,
  })

  let stopping = false
  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    void runtime.drain(signal).then(async () => {
      await runtime.close()
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'the service failed to start', error: String(error) })
  )
  process.exit(1)
})
