import { describe, expect, test } from 'bun:test'
import { createLogger, redactFields, redactUrl } from './logging'

describe('the logs of Hub', () => {
  test('a credential never reaches a log line', () => {
    const lines: string[] = []
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) })
    logger.info('the request was answered', {
      authorization: 'Bearer the-token',
      cookie: 'hub_login_state=the-state',
      token: 'the-token',
      nested: { 'set-cookie': 'a=b', plain: 'value' },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('the-token')
    expect(lines[0]).not.toContain('the-state')
    expect(lines[0]).toContain('[redacted]')
  })

  test('a bearer token is removed from a message', () => {
    const lines: string[] = []
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) })
    logger.error('the call failed with Bearer the-secret-value')
    expect(lines[0]).not.toContain('the-secret-value')
  })

  test('the sensitive query parameters of an url are redacted', () => {
    expect(redactUrl('/oauth/authorize?client_id=hub&code=the-code')).toBe(
      '/oauth/authorize?client_id=hub&code=%5Bredacted%5D'
    )
    expect(redactUrl('https://hub.example.com/callback?state=the-state&code=the-code')).toContain(
      'state=%5Bredacted%5D'
    )
    expect(redactUrl('/oauth/authorize?client_id=hub')).toBe('/oauth/authorize?client_id=hub')
  })

  test('the fields are redacted before they are logged', () => {
    const redacted = redactFields({ authorization: 'Bearer the-token', tenant: 'acme' })
    expect(redacted.authorization).toBe('[redacted]')
    expect(redacted.tenant).toBe('acme')
  })
})
