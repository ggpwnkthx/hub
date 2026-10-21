import { describe, expect, test } from 'bun:test'
import { TimeoutError, withTimeout } from './decisions'

describe('the deadline of a statement', () => {
  test('a statement that answers in time is its answer', async () => {
    expect(await withTimeout(Promise.resolve('the answer'), 1_000)).toBe('the answer')
  })

  test('a statement that does not answer in time is a failure', async () => {
    let message = ''
    try {
      await withTimeout(new Promise((resolve) => setTimeout(resolve, 500)), 10)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('TimeoutError')
  })

  test('the failure of the deadline names the time it had', async () => {
    const error = new TimeoutError(2_000)
    expect(error.message).toContain('2000')
  })
})
