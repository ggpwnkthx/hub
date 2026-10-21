#!/usr/bin/env bun
/**
 * The capacity of the decision (docs/operations.md, "The capacity").
 *
 * The script measures the latency of the decision and the number of
 * decisions per second, on the shape of the production: one principal
 * with a hundred grants, the decisions of a workspace and of a route.
 *
 * The measurement runs the statement of the production: the repository
 * of the decisions is the one of the service, and the deadline of the
 * deployment is the one of the service. A measurement of a copy of the
 * statement is a measurement of the copy.
 *
 *   HUB_DATABASE_URL=postgres://… bun run scripts/load.ts --requests 20000 --concurrency 100
 */
import {
  createDatabase,
  DecisionRepository,
  MIGRATIONS_DIRECTORY,
  runMigrations,
} from '../src/platform/postgres'
import { createLogger } from '../src/observability'

/** The number of requests of the run. */
const requests = Number(readOption('requests') ?? '20000')
/** The number of the requests that are in flight at the same time. */
const concurrency = Number(readOption('concurrency') ?? '100')
/** The number of grants of the principal of the measurement. */
const grants = Number(readOption('grants') ?? '100')
/** The deadline of a decision, in milliseconds. */
const timeoutMs = Number(readOption('timeout') ?? '2000')
/** True when the measurement is the one of the decision of a tenant. */
const scoped = process.argv.includes('--scoped')

/** Reads an option of the command line: `--name=value` or `--name value`. */
function readOption(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((argument) => argument.startsWith(flag))
  if (inline) return inline.slice(flag.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

/** The percentile of a list of durations. */
function percentile(values: number[], share: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * share))
  return sorted[index]!
}

async function main(): Promise<void> {
  const url = process.env.HUB_DATABASE_URL ?? 'pglite://memory://'
  const logger = createLogger({ level: 'info', bindings: { service: 'hub', tool: 'load' } })
  const database = await createDatabase(
    url.startsWith('pglite://')
      ? { driver: 'pglite', path: url.slice('pglite://'.length) }
      : { driver: 'postgres', url }
  )
  try {
    await runMigrations({ database, directory: MIGRATIONS_DIRECTORY, logger })
    await database.exec(`
      insert into tenants (slug, display_name, idp_issuer, idp_client_id, idp_client_secret,
        idp_redirect_uri, client_id, client_secret)
      values ('load', 'Load', 'https://login.load.example', 'hub-load', '\\x01',
        'https://hub.example.com/oauth/tenant/callback', 'shuttle-load', '\\x01')
      on conflict (slug) do nothing;
    `)
    await database.exec(`
      insert into permissions (tenant_id, key)
      select (select id from tenants where slug = 'load'), 'workspace.read'
      on conflict do nothing;
    `)
    await database.exec(`
      insert into users (tenant_id, external_subject)
      select (select id from tenants where slug = 'load'), 'the-subject-of-the-load'
      on conflict do nothing;
    `)
    await database.exec(`
      insert into grants (tenant_id, user_id, permission_id, workspace_id, route_id)
      select (select id from tenants where slug = 'load'),
             (select id from users where external_subject = 'the-subject-of-the-load'),
             (select id from permissions where key = 'workspace.read' limit 1),
             'workspace-' || w,
             'workspace-api'
      from generate_series(1, ${grants}) w
      on conflict do nothing;
    `)

    const subject = await database.query<{ id: string }>(
      `select id from users where external_subject = 'the-subject-of-the-load' limit 1`
    )
    const subjectId = subject[0]?.id ?? ''
    const tenant = await database.query<{ id: string }>(
      `select id from tenants where slug = 'load' limit 1`
    )
    const tenantId = tenant[0]?.id ?? null

    // The repository of the service: the statement of the production and
    // the deadline of the deployment.
    const repository = new DecisionRepository(database, timeoutMs)
    // The scope of a tenant is a transaction: the scope of the statement
    // is local to it. The measurement of the scoped decision is the one
    // of the deployments whose gateway holds the credentials of a tenant.
    const request = {
      subject: subjectId,
      workspaceId: 'workspace-1',
      routeId: 'workspace-api',
      roles: [],
      tenantId: scoped ? tenantId : null,
    }

    // The warm-up: the first calls pay for the caches of the server.
    for (let index = 0; index < 100; index += 1) {
      await repository.decide(request)
    }

    const durations: number[] = []
    let completed = 0
    const started = Date.now()

    const worker = async (): Promise<void> => {
      while (completed < requests) {
        const begin = performance.now()
        await repository.decide(request)
        durations.push(performance.now() - begin)
        completed += 1
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()))
    const elapsed = (Date.now() - started) / 1000

    console.log(
      JSON.stringify(
        {
          level: 'info',
          msg: 'the capacity of the decision',
          environment: url.startsWith('pglite://') ? 'pglite' : 'postgres',
          scope: scoped ? 'tenant' : 'platform',
          requests,
          concurrency,
          grants,
          seconds: Number(elapsed.toFixed(2)),
          perSecond: Math.round(completed / elapsed),
          p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
          p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
          p99Ms: Number(percentile(durations, 0.99).toFixed(3)),
          maxMs: Number(Math.max(...durations).toFixed(3)),
        },
        null,
        2
      )
    )
  } finally {
    await database.close()
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'the measurement failed', error: String(error) })
  )
  process.exit(1)
})
