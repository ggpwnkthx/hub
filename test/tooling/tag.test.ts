import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { compareVersions, decideTag, outputsOf, readTags } from '../../scripts/tag'

/**
 * The tests of the tagger.
 *
 * The tagger cuts the tag of a release when the version of the package
 * goes up. These tests exercise the decision — the part that decides —
 * and the reading of the tags, with small repositories of their own: they
 * need no network, and they prove that the tagger cuts a tag when the
 * version went up, that it does nothing when it did not, and that it
 * refuses a version that went down.
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
function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

/** Creates a repository with one commit and the tags that are named. */
async function repository(tags: string[]): Promise<string> {
  const path = await directory('hub-tag-')
  git(path, ['init', '--quiet'])
  git(path, ['config', 'user.name', 'Hub'])
  git(path, ['config', 'user.email', 'hub@example.com'])
  git(path, ['commit', '--quiet', '--allow-empty', '-m', 'the commit'])
  for (const tag of tags) git(path, ['tag', tag])
  return path
}

describe('the comparison of the versions of a release', () => {
  test('the versions are compared by number and not by text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1)
  })
})

describe('the decision of the tagger', () => {
  test('the tag is cut when the version went up', () => {
    const decision = decideTag({
      version: '1.0.0',
      tagged: [{ tag: 'v0.2.0', version: '0.2.0' }],
    })
    expect(decision.action).toBe('create')
    expect(decision.tag).toBe('v1.0.0')
  })

  test('the tag is cut when the repository carries no tag', () => {
    const decision = decideTag({ version: '0.1.0', tagged: [] })
    expect(decision.action).toBe('create')
    expect(decision.tag).toBe('v0.1.0')
  })

  test('nothing is done when the version did not go up', () => {
    const decision = decideTag({
      version: '0.2.0',
      tagged: [{ tag: 'v0.2.0', version: '0.2.0' }],
    })
    expect(decision.action).toBe('keep')
    expect(decision.tag).toBeNull()
  })

  test('the tag of the version is never cut twice', () => {
    const decision = decideTag({
      version: '0.2.0',
      tagged: [
        { tag: 'v0.2.0', version: '0.2.0' },
        { tag: 'v0.3.0', version: '0.3.0' },
      ],
    })
    expect(decision.action).toBe('keep')
  })

  test('a version that went down is refused', () => {
    const decision = decideTag({
      version: '0.2.0',
      tagged: [{ tag: 'v0.3.0', version: '0.3.0' }],
    })
    expect(decision.action).toBe('refuse')
    expect(decision.tag).toBeNull()
  })

  test('a version that is not the version of a release is refused', () => {
    for (const version of ['1.0', '1.0.0-rc.1', 'v1.0.0', '']) {
      const decision = decideTag({ version, tagged: [] })
      expect(decision.action).toBe('refuse')
    }
  })

  test('the highest tag is the one of the highest version', () => {
    // The tags are sorted by version and not by name: "v0.10.0" is newer
    // than "v0.9.0", and a string would say the opposite.
    const decision = decideTag({
      version: '0.9.0',
      tagged: [
        { tag: 'v0.10.0', version: '0.10.0' },
        { tag: 'v0.8.0', version: '0.8.0' },
      ],
    })
    expect(decision.action).toBe('refuse')
  })
})

describe('the tags of a repository', () => {
  test('the tags that name a version are read', async () => {
    const path = await repository(['v0.1.0', 'v0.2.0', 'not-a-release'])
    const tagged = readTags(path)
    expect(tagged.map((entry) => entry.tag).sort()).toEqual(['v0.1.0', 'v0.2.0'])
  })

  test('a repository without a tag holds none', async () => {
    const path = await repository([])
    expect(readTags(path)).toEqual([])
  })
})

describe('the outputs of the tagger', () => {
  test('the outputs name the tag and say that it was cut', () => {
    // The workflow of the tag reads them: the release is dispatched only
    // when the tagger cut the tag, because a tag that a human pushed
    // already started the release.
    const outputs = outputsOf({
      action: 'create',
      tag: 'v2.0.0',
      reason: 'the version went up',
    })
    expect(outputs).toEqual({ tag: 'v2.0.0', created: true })
  })

  test('the outputs of a tag that was not cut are empty', () => {
    expect(outputsOf({ action: 'keep', tag: null, reason: 'the tag exists' })).toEqual({
      tag: '',
      created: false,
    })
    expect(outputsOf({ action: 'refuse', tag: null, reason: 'the version went down' })).toEqual({
      tag: '',
      created: false,
    })
  })
})
