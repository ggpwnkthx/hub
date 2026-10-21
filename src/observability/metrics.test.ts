import { describe, expect, test } from 'bun:test'
import { BoundedLabel, LABEL_LIMIT, MetricsStore, OVERFLOW_LABEL } from './metrics'

describe('the metrics of Hub', () => {
  test('the decisions are counted with their tenant', async () => {
    const store = new MetricsStore()
    store.recordDecision('allow', 'acme', 3)
    store.recordDecision('deny', 'acme', 12)
    const text = await store.render()
    expect(text).toContain('hub_decisions_total')
    expect(text).toContain('hub_decision_duration_seconds')
    expect(text).toContain('acme')
  })

  test('the label of a tenant is bounded', async () => {
    const store = new MetricsStore()
    for (let index = 0; index < LABEL_LIMIT + 10; index += 1) {
      store.recordDecision('allow', `tenant-${index}`, 1)
    }
    const text = await store.render()
    expect(text).toContain(OVERFLOW_LABEL)
  })

  test('the bounded label keeps the values it has seen', () => {
    const label = new BoundedLabel(2)
    expect(label.of('a')).toBe('a')
    expect(label.of('b')).toBe('b')
    expect(label.of('c')).toBe(OVERFLOW_LABEL)
    expect(label.of('a')).toBe('a')
    expect(label.size).toBe(2)
  })

  test('the calls of the administration are counted', async () => {
    const store = new MetricsStore()
    store.recordAdminRequest('/v1/admin/tenants', 201)
    const text = await store.render()
    expect(text).toContain('hub_admin_requests_total')
  })

  test('the failures of the stores are counted', async () => {
    const store = new MetricsStore()
    store.recordStoreError('postgres')
    const text = await store.render()
    expect(text).toContain('hub_store_errors_total')
    expect(text).toContain('postgres')
  })

  test('the logins are counted', async () => {
    const store = new MetricsStore()
    store.recordLogin('success', 'acme')
    const text = await store.render()
    expect(text).toContain('hub_logins_total')
  })

  test('the content type is the one of Prometheus', () => {
    expect(new MetricsStore().contentType).toContain('text/plain')
  })
})
