import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')

/**
 * The routes of the code and the routes of the documentation.
 *
 * The HTTP surface of Hub is a contract of its own: a route that is not
 * documented is a route that nobody knows how to call, and a route that
 * is documented and does not exist is a promise that the service does
 * not keep.
 *
 * The two sets are read from the two sides — the routes the application
 * registers and the routes the documents name — and they have to be the
 * same set. A route that is added is a route that is documented in the
 * same commit, and a route that is removed is a route that is removed
 * from the documents in the same commit.
 */

/** The documents that hold the HTTP surface. */
const DOCUMENTS = ['docs/api.md', 'docs/operations.md']

/** A route of the service. */
interface Route {
  /** The method of the route. */
  method: string
  /** The path of the route, with the parameters in braces. */
  path: string
}

/** The name of a route, for the messages. */
function name(route: Route): string {
  return `${route.method} ${route.path}`
}

/**
 * The routes that the application registers.
 *
 * The path of a route is the first argument of the call of the
 * application, whatever the line it is on: the path of the discovery
 * document is on a line of its own.
 */
async function routesOfTheCode(): Promise<Route[]> {
  const source = await readFile(join(root, 'src', 'app', 'app.ts'), 'utf8')
  const routes: Route[] = []
  for (const match of source.matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) {
    routes.push({
      method: match[1]!.toUpperCase(),
      // The code names the parameter of a path with a colon and the
      // documents name it with braces.
      path: match[2]!.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
    })
  }
  return routes
}

/**
 * The routes that the documents name.
 *
 * A route is named by its method and its path, in the backticks of the
 * documents: `GET /healthz`.
 */
async function routesOfTheDocuments(): Promise<Route[]> {
  const routes: Route[] = []
  for (const document of DOCUMENTS) {
    const content = await readFile(join(root, document), 'utf8')
    for (const match of content.matchAll(/`?(GET|POST|PUT|DELETE|PATCH) (\/[A-Za-z0-9._/{}-]*)/g)) {
      routes.push({ method: match[1]!.toUpperCase(), path: match[2]! })
    }
  }
  return routes
}

describe('the routes of Hub', () => {
  test('every route of the code is documented', async () => {
    const code = await routesOfTheCode()
    const documents = await routesOfTheDocuments()
    const documented = new Set(documents.map(name))
    const missing = code.filter((route) => !documented.has(name(route)))
    expect(missing.map(name)).toEqual([])
  })

  test('every documented route exists', async () => {
    const code = await routesOfTheCode()
    const documents = await routesOfTheDocuments()
    const registered = new Set(code.map(name))
    const missing = documents.filter((route) => !registered.has(name(route)))
    expect(missing.map(name)).toEqual([])
  })

  test('the two sets are not empty', async () => {
    // The test is not vacuous: the application registers its routes and
    // the documents name them.
    expect((await routesOfTheCode()).length).toBeGreaterThan(10)
    expect((await routesOfTheDocuments()).length).toBeGreaterThan(10)
  })

  test('a route is registered once', async () => {
    const code = await routesOfTheCode()
    const names = code.map(name)
    expect(names.length).toBe(new Set(names).size)
  })
})
