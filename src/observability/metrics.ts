/**
 * The metrics of Hub (spec §12.2).
 *
 * The observation layer measures and writes: it knows nothing about the
 * domains, the application or the runtime. The labels are bounded: a
 * caller and a provider cannot grow the number of the series without
 * limit.
 */

import { Counter, Histogram, Registry } from 'prom-client'

/** The label that collects everything that did not fit. */
export const OVERFLOW_LABEL = 'overflow'

/** The number of values a bounded label holds. */
export const LABEL_LIMIT = 100

/**
 * A label whose values are bounded.
 *
 * The values that are seen are kept; the ones that come after the limit
 * are collected under `overflow`. The label of a tenant is bounded the
 * same way the label of a route is bounded in the gateway.
 */
export class BoundedLabel {
  private readonly seen = new Set<string>()

  constructor(private readonly limit: number = LABEL_LIMIT) {}

  /** The value of the label for a given name. */
  of(value: string): string {
    if (this.seen.has(value)) return value
    if (this.seen.size >= this.limit) return OVERFLOW_LABEL
    this.seen.add(value)
    return value
  }

  /** The number of the values that are kept. */
  get size(): number {
    return this.seen.size
  }
}

/** The observation of the service. */
export interface Observer {
  /** Records a decision of the gateway. */
  recordDecision(result: 'allow' | 'deny', tenant: string, durationMs: number): void
  /** Records a call of the administration. */
  recordAdminRequest(endpoint: string, status: number): void
  /** Records the failure of a store. */
  recordStoreError(store: 'redis' | 'postgres'): void
  /** Records a login. */
  recordLogin(result: 'success' | 'refused' | 'error', tenant: string): void
  /** The metrics in the text format of Prometheus. */
  render(): Promise<string>
  /** The type of the content of the metrics. */
  readonly contentType: string
}

/** The store of the metrics of Hub. */
export class MetricsStore implements Observer {
  private readonly registry = new Registry()
  private readonly tenants = new BoundedLabel()
  private readonly decisions: Counter<'result' | 'tenant'>
  private readonly duration: Histogram<'tenant'>
  private readonly adminRequests: Counter<'endpoint' | 'status'>
  private readonly storeErrors: Counter<'store'>
  private readonly logins: Counter<'result' | 'tenant'>

  constructor() {
    this.decisions = new Counter({
      name: 'hub_decisions_total',
      help: 'The decisions the service answered.',
      labelNames: ['result', 'tenant'],
      registers: [this.registry],
    })
    this.duration = new Histogram({
      name: 'hub_decision_duration_seconds',
      help: 'The duration of the decisions.',
      labelNames: ['tenant'],
      buckets: [0.001, 0.003, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5, 1],
      registers: [this.registry],
    })
    this.adminRequests = new Counter({
      name: 'hub_admin_requests_total',
      help: 'The calls of the administration.',
      labelNames: ['endpoint', 'status'],
      registers: [this.registry],
    })
    this.storeErrors = new Counter({
      name: 'hub_store_errors_total',
      help: 'The failures of the stores.',
      labelNames: ['store'],
      registers: [this.registry],
    })
    this.logins = new Counter({
      name: 'hub_logins_total',
      help: 'The logins of the callers.',
      labelNames: ['result', 'tenant'],
      registers: [this.registry],
    })
  }

  recordDecision(result: 'allow' | 'deny', tenant: string, durationMs: number): void {
    const label = this.tenants.of(tenant)
    this.decisions.inc({ result, tenant: label })
    this.duration.observe({ tenant: label }, durationMs / 1000)
  }

  recordAdminRequest(endpoint: string, status: number): void {
    this.adminRequests.inc({ endpoint, status: String(status) })
  }

  recordStoreError(store: 'redis' | 'postgres'): void {
    this.storeErrors.inc({ store })
  }

  recordLogin(result: 'success' | 'refused' | 'error', tenant: string): void {
    this.logins.inc({ result, tenant: this.tenants.of(tenant) })
  }

  async render(): Promise<string> {
    return await this.registry.metrics()
  }

  get contentType(): string {
    return this.registry.contentType
  }
}

/** An observer that measures nothing; it is used by the tests. */
export function createSilentObserver(): Observer {
  return {
    recordDecision: () => undefined,
    recordAdminRequest: () => undefined,
    recordStoreError: () => undefined,
    recordLogin: () => undefined,
    render: async () => '',
    contentType: 'text/plain; version=0.0.4',
  }
}
