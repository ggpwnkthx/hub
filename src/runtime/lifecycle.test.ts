import { describe, expect, test } from 'bun:test'
import { createSilentLogger } from '../observability'
import { drain } from './lifecycle'

describe('the drain of Hub', () => {
  test('the admission stops first and the resources are closed', async () => {
    const calls: string[] = []
    await drain(
      {
        logger: createSilentLogger(),
        stopListener: async (force) => {
          calls.push(`stop:${force}`)
        },
        closeResources: async () => {
          calls.push('close')
        },
        setDraining: (draining) => {
          calls.push(`draining:${draining}`)
        },
      },
      'SIGTERM'
    )
    expect(calls).toEqual(['draining:true', 'stop:false', 'close'])
  })

  test('a listener that does not stop is closed when the deadline is reached', async () => {
    const calls: string[] = []
    await drain(
      {
        logger: createSilentLogger(),
        timeoutMs: 20,
        stopListener: async (force) => {
          calls.push(`stop:${force}`)
          if (!force) await new Promise((resolve) => setTimeout(resolve, 200))
        },
        closeResources: async () => {
          calls.push('close')
        },
        setDraining: () => undefined,
      },
      'SIGTERM'
    )
    expect(calls).toEqual(['stop:false', 'stop:true', 'close'])
  })
})
