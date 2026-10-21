import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  checkArchitecture,
  findForbiddenDirectories,
  loadSources,
  unlocatedFiles,
  type SourceFile,
} from '../../scripts/architecture'

const root = resolve(import.meta.dir, '..', '..')

/** Builds the source of a file of the project. */
function source(path: string, content: string): SourceFile {
  return { path, content }
}

describe('the import boundaries of the project', () => {
  test('the source tree respects them', async () => {
    const sources = await loadSources(root)
    const violations = checkArchitecture(sources)
    expect(violations).toEqual([])
  })

  test('every file of the tree belongs to a known layer', async () => {
    const sources = await loadSources(root)
    expect(unlocatedFiles(sources)).toEqual([])
  })

  test('there is no directory that collects unrelated behaviour', async () => {
    expect(await findForbiddenDirectories(root)).toEqual([])
  })
})

describe('the rules of the import boundaries', () => {
  test('a domain is imported through its public entry point', () => {
    const violations = checkArchitecture([
      source('src/domains/administration/audit.ts', "import { audit } from '../provider/audit'\n"),
      source('src/domains/provider/audit.ts', 'export const audit = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toContain('domain-import-not-public')
  })

  test('the public entry point of a domain is enough', () => {
    const violations = checkArchitecture([
      source('src/app/app.ts', "import { tokens } from '../domains/provider'\n"),
      source('src/domains/provider/index.ts', 'export const tokens = 1\n'),
    ])
    expect(violations).toEqual([])
  })

  test('a domain may only use the domains it is allowed to use', () => {
    const violations = checkArchitecture([
      source(
        'src/domains/identity/mapping.ts',
        "import { tokens } from '../provider'\nimport { policy } from '../authorization'\n"
      ),
      source('src/domains/provider/index.ts', 'export const tokens = 1\n'),
      source('src/domains/authorization/index.ts', 'export const policy = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'domain-dependency-not-allowed',
      'domain-dependency-not-allowed',
    ])
  })

  test('a core domain file imports no framework and no boundary layer', () => {
    const violations = checkArchitecture([
      source('src/domains/identity/mapping.ts', "import { Hono } from 'hono'\n"),
      source('src/domains/identity/adapter.ts', "import { app } from '../../app/app'\n"),
      source('src/app/app.ts', 'export const app = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'domain-core-imports-framework',
      'domain-core-imports-boundary',
      'hono-outside-app',
    ])
  })

  test('the framework of the application belongs to the application', () => {
    const violations = checkArchitecture([
      source('src/platform/bun/listener.ts', "import { Hono } from 'hono'\n"),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual(['hono-outside-app'])
  })

  test('the api of the runtime belongs to the platform', () => {
    const violations = checkArchitecture([
      source('src/domains/identity/mapping.ts', 'const server = Bun.serve({})\n'),
      source('src/app/app.ts', 'export const app = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual(['bun-api-outside-platform'])
  })

  test('the platform may use the api of the runtime', () => {
    const violations = checkArchitecture([
      source('src/platform/bun/listener.ts', 'const server = Bun.serve({})\n'),
      source('src/platform/redis/client.ts', 'const client = new Bun.RedisClient(url)\n'),
    ])
    expect(violations).toEqual([])
  })

  test('a core domain file may use the observation interfaces', () => {
    const violations = checkArchitecture([
      source(
        'src/domains/identity/mapping.ts',
        "import type { Logger } from '../../observability'\n"
      ),
      source('src/observability/index.ts', 'export type Logger = unknown\n'),
    ])
    expect(violations).toEqual([])
  })

  test('an adapter of a domain may use a library', () => {
    const violations = checkArchitecture([
      source('src/domains/identity/adapters/postgres.ts', "import { parse } from 'jose'\n"),
    ])
    expect(violations).toEqual([])
  })

  test('the application uses no concrete adapter', () => {
    const violations = checkArchitecture([
      source('src/app/app.ts', "import { store } from '../domains/identity/adapters/memory'\n"),
      source('src/domains/identity/adapters/memory.ts', 'export const store = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'domain-import-not-public',
      'app-imports-adapter',
    ])
  })

  test('the platform knows neither the application nor the runtime', () => {
    const violations = checkArchitecture([
      source('src/platform/bun/listener.ts', "import { app } from '../../app/app'\n"),
      source('src/platform/bun/other.ts', "import { runtime } from '../../runtime/composition'\n"),
      source('src/app/app.ts', 'export const app = 1\n'),
      source('src/runtime/composition.ts', 'export const runtime = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'platform-imports-boundary',
      'platform-imports-boundary',
    ])
  })

  test('the observation layer is independent', () => {
    const violations = checkArchitecture([
      source('src/observability/metrics.ts', "import { decide } from '../domains/authorization'\n"),
      source('src/domains/authorization/index.ts', 'export const decide = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual([
      'observability-imports-boundary',
    ])
  })

  test('the composition root may use the adapters of a domain', () => {
    const violations = checkArchitecture([
      source(
        'src/runtime/composition.ts',
        "import { store } from '../domains/identity/adapters'\n"
      ),
      source('src/domains/identity/adapters/index.ts', 'export const store = 1\n'),
    ])
    expect(violations).toEqual([])
  })

  test('an import cycle is refused', () => {
    const violations = checkArchitecture([
      source('src/domains/provider/a.ts', "import { b } from './b'\n"),
      source('src/domains/provider/b.ts', "import { a } from './a'\n"),
    ])
    expect(violations.map((violation) => violation.rule)).toContain('import-cycle')
  })

  test('a type only import is a dependency as well', () => {
    const violations = checkArchitecture([
      source('src/app/app.ts', "import type { Audit } from '../domains/provider/audit'\n"),
      source('src/domains/provider/audit.ts', 'export type Audit = unknown\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual(['domain-import-not-public'])
  })

  test('the public entry point of a domain holds no adapter', () => {
    const violations = checkArchitecture([
      source('src/domains/identity/index.ts', "import { store } from './adapters/memory'\n"),
      source('src/domains/identity/adapters/memory.ts', 'export const store = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toContain('domain-entry-uses-adapter')
  })

  test('the environment is read in the runtime only', () => {
    const violations = checkArchitecture([
      source('src/domains/identity/mapping.ts', 'const url = process.env.HUB_DATABASE_URL\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual(['process-env-outside-runtime'])
  })

  test('the runtime may read the environment', () => {
    const violations = checkArchitecture([
      source('src/runtime/env.ts', 'const url = process.env.HUB_DATABASE_URL\n'),
    ])
    expect(violations).toEqual([])
  })
})

describe('the location of a file', () => {
  test('a domain file is located in its domain', () => {
    const violations = checkArchitecture([
      source('src/domains/authorization/decision.ts', "import { policy } from '../identity'\n"),
      source('src/domains/identity/index.ts', 'export const policy = 1\n'),
    ])
    expect(violations.map((violation) => violation.rule)).toEqual(['domain-dependency-not-allowed'])
  })
})

test('the forbidden directories are found', async () => {
  expect(await findForbiddenDirectories(root)).toEqual([])
})
