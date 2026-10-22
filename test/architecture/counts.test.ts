import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')

/**
 * The numbers that the documents and the code have to agree on.
 *
 * The administration is a fixed surface: nine endpoints, and the whole
 * session of a tenant is nine calls. A document that says "the eight
 * administrative endpoints" is a lie about the contract of the service,
 * and a reader that counts the routes finds it.
 *
 * The count is read from the code — the routes that the application
 * registers — and the documents are checked against it. A change of the
 * surface changes the code and the documents in the same commit, and
 * this test names the documents that were not changed.
 */

/**
 * The route that reads the audit.
 *
 * The audit is not one of the nine: the nine are the endpoints that
 * create, revoke and list, and the audit is read with a tenth (spec
 * §1.1).
 */
const AUDIT_ROUTE = '/v1/admin/audit'

/** The files that are read. */
async function filesOf(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await filesOf(path)))
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.md')) found.push(path)
  }
  return found
}

/** The number of the routes of the administration that the code registers. */
async function routesOfTheCode(): Promise<number> {
  const source = await readFile(join(root, 'src', 'app', 'app.ts'), 'utf8')
  const routes = source.match(/app\.(get|post|put|delete)\('(\/v1\/admin\/[^']*)'/g) ?? []
  const paths = routes.map((route) => /'([^']*)'/.exec(route)?.[1] ?? '')
  return paths.filter((path) => path !== AUDIT_ROUTE).length
}

/** The number a document says, with the name of the file and the line. */
interface Claim {
  file: string
  line: number
  word: string
}

describe('the numbers of the documentation', () => {
  test('the documents and the code agree on the size of the administration', async () => {
    const routes = await routesOfTheCode()
    expect(routes).toBe(9)

    const claims: Claim[] = []
    const files = [
      ...(await filesOf(join(root, 'src'))),
      ...(await filesOf(join(root, 'test'))),
      ...(await filesOf(join(root, 'scripts'))),
      ...(await filesOf(join(root, 'docs'))),
      join(root, 'README.md'),
      join(root, 'CHANGELOG.md'),
    ]
    for (const file of files) {
      const content = await readFile(file, 'utf8')
      const lines = content.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!
        // The phrases that carry the count of the administration: "the
        // nine administrative endpoints", "the nine calls of the
        // session", "the nine calls of the administration".
        for (const match of line.matchAll(
          /the (seven|eight|nine|ten) (administrative endpoints|calls of the (session|administration))/g
        )) {
          claims.push({
            file: relative(root, file),
            line: index + 1,
            word: match[1]!,
          })
        }
      }
    }

    const findings = claims
      .filter((claim) => claim.word !== 'nine')
      .map(
        (claim) =>
          `${claim.file}:${claim.line} says "${claim.word}" and the code registers ${routes}`
      )
    expect(findings).toEqual([])
    // The documents do mention the count: the test is not vacuous.
    expect(claims.length).toBeGreaterThan(10)
  })
})
