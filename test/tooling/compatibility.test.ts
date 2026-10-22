import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  checkPreparedCheckout,
  cloneAt,
  parseManifest,
  readManifest,
  resolveSource,
  runCompatibility,
} from '../../scripts/compatibility'

/**
 * The tests of the compatibility runner.
 *
 * The runner prepares the reference of the compatibility suite and runs
 * the suite against it. These tests exercise the runner with small
 * repositories of their own: they need no network, and they prove that
 * the runner pins a commit, that it refuses a checkout that is not the
 * pinned one, that it never modifies the tree of a source and that it
 * propagates the failure of the suite.
 */

const workspaces: string[] = []

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true })
  }
})

/** Creates a directory that is removed at the end of the test. */
async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  workspaces.push(path)
  return path
}

/** Runs a git command in a directory. */
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

/**
 * Creates a repository with two commits.
 *
 * The first commit is the one that is not the HEAD: a runner that pins
 * the HEAD of a source does not pin anything.
 */
async function repository(): Promise<{ path: string; first: string; second: string }> {
  const path = await directory('hub-tooling-repository-')
  git(path, 'init', '--quiet', '--initial-branch=main')
  git(path, 'config', 'user.email', 'tooling@hub.test')
  git(path, 'config', 'user.name', 'the tooling of the tests')
  await writeFile(
    join(path, 'package.json'),
    JSON.stringify({ name: 'fake-shuttle', version: '0.0.0', private: true })
  )
  await writeFile(join(path, 'src.ts'), 'export const version = 1\n')
  git(path, 'add', '--all')
  git(path, 'commit', '--quiet', '-m', 'the first commit')
  const first = git(path, 'rev-parse', 'HEAD')
  await writeFile(join(path, 'src.ts'), 'export const version = 2\n')
  git(path, 'add', '--all')
  git(path, 'commit', '--quiet', '-m', 'the second commit')
  const second = git(path, 'rev-parse', 'HEAD')
  return { path, first, second }
}

/** The manifest of the tests. */
function manifest(commit: string): string {
  return JSON.stringify({
    version: 1,
    repositories: { shuttle: { url: 'https://github.com/ggpwnkthx/shuttle.git', commit } },
  })
}

describe('the manifest of the references', () => {
  test('the manifest of the repository is a valid pin', async () => {
    const root = resolve(import.meta.dir, '..', '..')
    const parsed = await readManifest(root)
    expect(parsed.version).toBe(1)
    expect(parsed.repositories.shuttle?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(parsed.repositories.shuttle?.url).toMatch(/^https:\/\/github\.com\//)
  })

  test('a commit that is not the identifier of a commit is refused', () => {
    for (const commit of ['main', 'v0.4.0', '1199d6d', '1199d6d350be86b0081cb367e02272264982554']) {
      expect(() => parseManifest(manifest(commit))).toThrow(/full commit id is required/)
    }
  })

  test('a manifest of another version is refused', () => {
    expect(() =>
      parseManifest(
        JSON.stringify({
          version: 2,
          repositories: {
            shuttle: { url: 'https://example.test/shuttle.git', commit: 'a'.repeat(40) },
          },
        })
      )
    ).toThrow(/version 2/)
  })

  test('a manifest without the gateway is refused', () => {
    expect(() =>
      parseManifest(
        JSON.stringify({
          version: 1,
          repositories: { depot: { url: 'https://example.test', commit: 'a'.repeat(40) } },
        })
      )
    ).toThrow(/no reference named "shuttle"/)
  })
})

describe('the source of the reference', () => {
  const parsed = parseManifest(manifest('b'.repeat(40)))

  test('the prepared checkout has the first place', async () => {
    const checkout = await directory('hub-tooling-checkout-')
    const source = resolveSource(
      { HUB_SHUTTLE_PATH: checkout, SHUTTLE_REPOSITORY: 'https://example.test/x.git' },
      parsed
    )
    expect(source.kind).toBe('prepared')
    expect(source.path).toBe(checkout)
  })

  test('the repository comes before the mirror and the manifest', () => {
    const source = resolveSource(
      { SHUTTLE_REPOSITORY: 'https://example.test/x.git', COMPAT_MIRROR: '/tmp/mirror' },
      parsed
    )
    expect(source.kind).toBe('repository')
    expect(source.repository).toBe('https://example.test/x.git')
  })

  test('the mirror holds a bare repository named after the reference', async () => {
    const mirror = await directory('hub-tooling-mirror-')
    const source = await repository()
    git(mirror, 'clone', '--quiet', '--bare', source.path, join(mirror, 'shuttle.git'))
    const resolved = resolveSource({ COMPAT_MIRROR: mirror }, parsed)
    expect(resolved.kind).toBe('repository')
    expect(resolved.repository).toBe(join(mirror, 'shuttle.git'))
  })

  test('a mirror without the bare repository is an error, not a fallback', () => {
    expect(() => resolveSource({ COMPAT_MIRROR: '/tmp/the-mirror-of-nothing' }, parsed)).toThrow(
      /holds no bare repository/
    )
  })

  test('the url of the manifest is the last resort', () => {
    const source = resolveSource({}, parsed)
    expect(source.kind).toBe('repository')
    expect(source.repository).toBe('https://github.com/ggpwnkthx/shuttle.git')
  })
})

describe('the checkout of the reference', () => {
  test('the pinned commit is checked out, and not the head of the source', async () => {
    const source = await repository()
    const target = await directory('hub-tooling-checkout-')
    const checkout = join(target, 'shuttle')
    cloneAt(source.path, source.first, checkout)
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(source.first)
    expect(git(checkout, 'status', '--porcelain')).toBe('')
  })

  test('a source that does not hold the commit is an error', async () => {
    const source = await repository()
    const target = await directory('hub-tooling-checkout-')
    expect(() => cloneAt(source.path, 'c'.repeat(40), join(target, 'shuttle'))).toThrow(
      /does not hold the commit/
    )
  })

  test('a prepared checkout at another commit is refused', async () => {
    const source = await repository()
    expect(() => checkPreparedCheckout(source.path, source.first)).toThrow(
      /the checkout has to be at the pinned commit/
    )
    expect(() => checkPreparedCheckout(source.path, source.second)).not.toThrow()
  })

  test('a prepared checkout with changes is refused', async () => {
    const source = await repository()
    await writeFile(join(source.path, 'src.ts'), 'export const version = 3\n')
    expect(() => checkPreparedCheckout(source.path, source.second)).toThrow(
      /carries changes to its tracked files/
    )
  })
})

describe('the run of the suite', () => {
  test('a local source is used as it is and the suite runs against the pin', async () => {
    const source = await repository()
    const workspace = await directory('hub-tooling-workspace-')
    const before = await readFile(join(source.path, 'src.ts'), 'utf8')

    const result = await runCompatibility({
      root: process.cwd(),
      env: { SHUTTLE_REPOSITORY: source.path },
      manifest: parseManifest(manifest(source.second)),
      workspace,
      command: ['bun', '-e', 'if (process.env.HUB_SHUTTLE_PATH) process.exit(0); process.exit(7)'],
    })

    expect(result.status).toBe(0)
    expect(result.commit).toBe(source.second)
    // The source is not touched by the runner.
    expect(await readFile(join(source.path, 'src.ts'), 'utf8')).toBe(before)
    expect(git(source.path, 'status', '--porcelain')).toBe('')
  })

  test('a failure of the suite is propagated and the checkout is cleaned up', async () => {
    const source = await repository()
    const workspace = await directory('hub-tooling-workspace-')

    const result = await runCompatibility({
      root: process.cwd(),
      env: { SHUTTLE_REPOSITORY: source.path },
      manifest: parseManifest(manifest(source.second)),
      workspace,
      command: ['bun', '-e', 'process.exit(3)'],
    })

    expect(result.status).toBe(3)
    // The checkout of the runner is removed: it is not the tree of a
    // developer.
    expect(await Bun.file(join(workspace, 'shuttle', 'src.ts')).exists()).toBe(false)
  })

  test('a mirror is a source of the reference', async () => {
    const source = await repository()
    const mirror = await directory('hub-tooling-mirror-')
    git(mirror, 'clone', '--quiet', '--bare', source.path, join(mirror, 'shuttle.git'))
    const result = await runCompatibility({
      root: process.cwd(),
      env: { COMPAT_MIRROR: mirror },
      manifest: parseManifest(manifest(source.second)),
      workspace: await directory('hub-tooling-workspace-'),
      command: ['bun', '-e', 'process.exit(0)'],
    })
    expect(result.status).toBe(0)
    expect(result.commit).toBe(source.second)
  })

  test('a prepared checkout is not modified by the runner', async () => {
    const source = await repository()
    const before = await readFile(join(source.path, 'src.ts'), 'utf8')

    const result = await runCompatibility({
      root: process.cwd(),
      env: { HUB_SHUTTLE_PATH: source.path },
      manifest: parseManifest(manifest(source.second)),
      workspace: await directory('hub-tooling-workspace-'),
      command: ['bun', '-e', 'process.exit(0)'],
    })

    expect(result.status).toBe(0)
    expect(result.owned).toBe(false)
    expect(result.commit).toBe(source.second)
    expect(await readFile(join(source.path, 'src.ts'), 'utf8')).toBe(before)
    expect(git(source.path, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  test('a prepared checkout at another commit is refused before the suite runs', async () => {
    const source = await repository()
    await expect(
      runCompatibility({
        root: process.cwd(),
        env: { HUB_SHUTTLE_PATH: source.path },
        manifest: parseManifest(manifest(source.first)),
        workspace: await directory('hub-tooling-workspace-'),
        command: ['bun', '-e', 'process.exit(0)'],
      })
    ).rejects.toThrow(/the checkout has to be at the pinned commit/)
  })
})
