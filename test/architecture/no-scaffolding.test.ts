import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..', '..')

/**
 * The features that are deferred (spec §13).
 *
 * A deferred feature has no column, no table, no flag, no endpoint and no
 * code: a half built feature in a service that carries a customer is a
 * liability. The test fails the build when one of them appears.
 */
const DEFERRED: { name: string; pattern: RegExp }[] = [
  { name: 'SAML', pattern: /\bsaml\b/i },
  { name: 'SCIM', pattern: /\bscim\b/i },
  { name: 'the console', pattern: /['"`]\/console/i },
  { name: 'the directory sync', pattern: /directory[-_ ]?sync/i },
  { name: 'the linking of the accounts', pattern: /account[-_ ]?link/i },
]

/** The files of the source tree. */
async function sourcesOf(directory: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await sourcesOf(path)))
      continue
    }
    if (entry.name.endsWith('.ts')) found.push(path)
  }
  return found
}

describe('the deferred features of Hub', () => {
  test('the code holds none of them', async () => {
    const findings: string[] = []
    for (const file of await sourcesOf(join(root, 'src'))) {
      const content = await readFile(file, 'utf8')
      for (const feature of DEFERRED) {
        if (feature.pattern.test(content)) {
          findings.push(`${file}: ${feature.name}`)
        }
      }
    }
    expect(findings).toEqual([])
  })

  test('the dependencies hold none of them', async () => {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const names = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    })
    const findings = names.filter((name) => DEFERRED.some((feature) => feature.pattern.test(name)))
    expect(findings).toEqual([])
  })
})
