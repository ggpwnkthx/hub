#!/usr/bin/env bun
/**
 * The tag of a release.
 *
 * A release of Hub is a tag, and the tag names the version of the
 * package: the workflows of the release refuse a tag that does not name
 * it. This script cuts that tag when the version of the package goes up.
 *
 *   bun run tag
 *
 * The script:
 *
 * 1. reads the version of the package — the version every other file
 *    has to agree with (scripts/version.ts);
 * 2. refuses to cut a tag when the versions of the project disagree: a
 *    tag that names a version the specification does not carry is a
 *    release the workflows of the release would refuse;
 * 3. reads the tags of the repository and finds the highest version they
 *    name;
 * 4. creates the tag `v<version>` when the version of the package is
 *    newer than every tag, and pushes it;
 * 5. does nothing when the version did not go up, and refuses when it
 *    went down: a release does not go backwards.
 *
 * The tag is pushed, not only created: the workflows of the release run
 * on the tag, and they are the ones that publish the image and the
 * binaries.
 *
 * The environment:
 *
 *   --dry-run   the decision is printed and nothing is created.
 */

import { spawnSync } from 'bun'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RELEASE_VERSION } from './version'
import { checkVersions, readPackageVersion } from './version'

/** A tag of the repository, and the version it names. */
export interface TaggedVersion {
  /** The name of the tag. */
  tag: string
  /** The version the tag names. */
  version: string
}

/** What the tagger does. */
export type TagAction = 'create' | 'keep' | 'refuse'

/** The decision of the tagger. */
export interface TagDecision {
  /** What to do. */
  action: TagAction
  /** The tag to create, when the action is to create it. */
  tag: string | null
  /** The reason of the decision, for the log. */
  reason: string
}

/**
 * The outputs of the tagger, for the workflow that runs it.
 *
 * The workflow reads them to know whether it has to start the release.
 * The tag is pushed with the token of the workflow, and GitHub does not
 * start a workflow on a push that carries it: the release is dispatched
 * instead, and the dispatch is the exception to that rule.
 */
export interface TagOutputs {
  /** The tag of the release, empty when the tagger cut no tag. */
  tag: string
  /** True when the tagger cut the tag and pushed it. */
  created: boolean
}

/** The pattern of the tag of a release: "v" and the version. */
const TAG_PATTERN = /^v(\d+\.\d+\.\d+)$/

/**
 * Compares two versions of a release.
 *
 * The comparison is by number and not by text: `1.10.0` is newer than
 * `1.9.0`, and a string would say the opposite.
 *
 * @returns -1 when `left` is older, 1 when it is newer, 0 when they are
 * the same version.
 */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number(part))
  const b = right.split('.').map((part) => Number(part))
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index] ?? 0
    const other = b[index] ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  return 0
}

/**
 * Decides what to do with the version of the package.
 *
 * The decision is a pure function of the version and of the tags: it is
 * the part of the tagger that a test can prove.
 */
export function decideTag(options: {
  /** The version of the package. */
  version: string
  /** The tags of the repository, and the versions they name. */
  tagged: TaggedVersion[]
}): TagDecision {
  const version = options.version
  const tag = `v${version}`

  if (!RELEASE_VERSION.test(version)) {
    return {
      action: 'refuse',
      tag: null,
      reason: `the version "${version}" is not the version of a release: three numbers, "1.0.0"`,
    }
  }

  // The tag of this version may already exist: a version is released
  // once, and a second tag of the same version would publish it twice.
  if (options.tagged.some((candidate) => candidate.tag === tag)) {
    return {
      action: 'keep',
      tag: null,
      reason: `the tag ${tag} already exists: the release of this version is already cut`,
    }
  }

  // The highest version the tags name: the tags are sorted by version
  // and not by name, because "v0.10.0" is newer than "v0.9.0".
  let highest: TaggedVersion | null = null
  for (const candidate of options.tagged) {
    if (!highest || compareVersions(candidate.version, highest.version) > 0) highest = candidate
  }

  if (!highest) {
    return {
      action: 'create',
      tag,
      reason: 'the repository carries no tag: this release is the first one',
    }
  }

  const order = compareVersions(version, highest.version)
  if (order === 0) {
    return {
      action: 'keep',
      tag: null,
      reason: `the version ${version} is the version of the tag ${highest.tag}: nothing to do`,
    }
  }
  if (order < 0) {
    return {
      action: 'refuse',
      tag: null,
      reason:
        `the version ${version} is older than the version ${highest.version} of the tag ${highest.tag}: ` +
        'a release does not go backwards',
    }
  }
  return {
    action: 'create',
    tag,
    reason: `the version ${version} is newer than the version ${highest.version} of the tag ${highest.tag}`,
  }
}

/**
 * The tags of a repository, and the versions they name.
 *
 * A tag that does not name a version of a release is ignored: it is not
 * a release of Hub.
 */
export function readTags(directory: string): TaggedVersion[] {
  const result = spawnSync(['git', 'tag', '--list'], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `the tags of ${directory} could not be read: ${result.stderr?.toString().trim() ?? ''}`
    )
  }
  const tagged: TaggedVersion[] = []
  for (const line of result.stdout?.toString().split('\n') ?? []) {
    const tag = line.trim()
    if (!tag) continue
    const match = TAG_PATTERN.exec(tag)
    if (!match) continue
    tagged.push({ tag, version: match[1]! })
  }
  return tagged
}

/**
 * The outputs of a decision.
 *
 * The tag is empty when the tagger cut none: the tagger does nothing
 * when the version did not go up, and the release of that version is
 * already cut — by a human, whose push started the release by itself.
 */
export function outputsOf(decision: TagDecision): TagOutputs {
  return {
    tag: decision.tag ?? '',
    created: decision.action === 'create',
  }
}

/**
 * Writes the outputs of the tagger, when it runs in a workflow.
 *
 * The file of the outputs is named by the environment of the workflow.
 * The tagger that runs by hand has none, and it prints its decision.
 */
export function writeOutputs(
  outputs: TagOutputs,
  path: string | undefined = process.env.GITHUB_OUTPUT
): void {
  if (!path) return
  appendFileSync(path, `tag=${outputs.tag}\ncreated=${outputs.created}\n`)
}

/**
 * Creates a tag and pushes it.
 *
 * The tag is annotated: it names the release and it says which release it
 * is. The push is of the tag alone: the branch is pushed by the merge
 * that carries the version.
 */
export function createAndPushTag(directory: string, tag: string): void {
  const created = spawnSync(['git', 'tag', '-a', tag, '-m', `Hub ${tag}`], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (created.exitCode !== 0) {
    throw new Error(
      `the tag ${tag} could not be created: ${created.stderr?.toString().trim() ?? ''}`
    )
  }
  const pushed = spawnSync(['git', 'push', 'origin', `refs/tags/${tag}`], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (pushed.exitCode !== 0) {
    throw new Error(`the tag ${tag} could not be pushed: ${pushed.stderr?.toString().trim() ?? ''}`)
  }
}

/** The main of the tagger. */
export async function main(): Promise<number> {
  const root = resolve(import.meta.dir, '..')
  const dryRun = process.argv.includes('--dry-run')

  // The versions of the project have to agree: the workflows of the
  // release check the same thing, and a tag that names a version the
  // specification does not carry is a release they would refuse.
  const findings = await checkVersions(root)
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}: ${finding.message}`)
    }
    console.error('the version of the release is not the same everywhere: no tag is cut')
    return 1
  }

  const version = await readPackageVersion(root)
  if (!version) {
    console.error('the package does not hold a version: no tag is cut')
    return 1
  }

  const tagged = readTags(root)
  const decision = decideTag({ version, tagged })
  // The outputs are written whatever the decision is: the workflow reads
  // them to know that it has nothing to dispatch.
  writeOutputs(outputsOf(decision))

  if (decision.action === 'refuse') {
    console.error(decision.reason)
    return 1
  }
  if (decision.action === 'keep') {
    console.log(decision.reason)
    return 0
  }

  if (dryRun) {
    console.log(`${decision.reason}: the tag ${decision.tag} would be created`)
    return 0
  }

  console.log(decision.reason)
  createAndPushTag(root, decision.tag!)
  console.log(`the tag ${decision.tag} is pushed: the release starts`)
  return 0
}

if (import.meta.main) {
  process.exit(await main())
}
