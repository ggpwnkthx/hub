#!/usr/bin/env bun
/**
 * The compatibility runner of Hub.
 *
 * The compatibility suite runs the **real** gateway of Shuttle, unchanged,
 * against Hub. The gateway is a reference: it is a checkout of another
 * repository, at a commit that is pinned, and it is never modified.
 *
 * This script is the one that prepares the reference and runs the suite.
 * It is used by the CI workflow and by a developer, and both read the
 * same pin: the file `compatibility.json` at the root of this repository.
 *
 *   bun run test:compat
 *
 * The environment:
 *
 *   HUB_SHUTTLE_PATH     a checkout of the gateway that is already
 *                         prepared: it is used as it is, and it is checked
 *                         before the run (its HEAD has to be the pinned
 *                         commit and its tracked files have to be the
 *                         ones of the commit).
 *   SHUTTLE_REPOSITORY   the repository of the gateway: a git url or the
 *                         path of a local repository. It has to hold the
 *                         pinned commit.
 *   COMPAT_MIRROR        a directory that holds a bare repository named
 *                         `shuttle.git`. It is the way to run the suite
 *                         without the network.
 *   COMPAT_WORKSPACE     the directory the checkout is created in. It is
 *                         a temporary directory by default.
 *   COMPAT_KEEP          when it is set, the checkout is kept: the suite
 *                         is then inspected after the run.
 *
 * The order of the sources is the one of the list above: the first one
 * that is set wins. An override that is set and that does not hold the
 * pinned commit is an error: the suite never falls back to another
 * source, because a suite that runs against another revision is a suite
 * that proves nothing.
 */

import { spawn, spawnSync, type Subprocess } from 'bun'
import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The name of the manifest of the references. */
export const MANIFEST_NAME = 'compatibility.json'

/** The version of the format of the manifest. */
export const MANIFEST_VERSION = 1

/** The name of the repository of the gateway, in the manifest. */
export const REFERENCE_NAME = 'shuttle'

/** A commit of a repository: forty hexadecimal characters. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/

/** The reference of the compatibility suite. */
export interface CompatibilityReference {
  /** The url of the repository of the reference. */
  url: string
  /** The commit of the reference: it is immutable. */
  commit: string
}

/** The manifest of the references. */
export interface CompatibilityManifest {
  /** The version of the format of the manifest. */
  version: number
  /** The references, by name. */
  repositories: Record<string, CompatibilityReference>
}

/** A source of the reference, and where it comes from. */
export interface ResolvedSource {
  /** The kind of the source. */
  kind: 'prepared' | 'repository'
  /** The path of the checkout, for a prepared checkout. */
  path?: string
  /** The url or the path of the repository to clone. */
  repository?: string
  /** The name of the source, for the logs. */
  origin: string
}

/** The options of a run of the suite. */
export interface RunnerOptions {
  /** The root of this repository: the directory that holds the manifest. */
  root: string
  /** The environment of the run. */
  env: Record<string, string | undefined>
  /** The directory the checkout is created in. */
  workspace?: string
  /** The command that runs the suite. */
  command?: string[]
  /** The manifest of the references, when it is not read from the root. */
  manifest?: CompatibilityManifest
  /** The logger of the run. */
  log?: (message: string) => void
}

/** The result of a run of the suite. */
export interface RunnerResult {
  /** The status of the suite: it is the status of the test process. */
  status: number
  /** The commit of the reference that was tested. */
  commit: string
  /** The source the reference came from. */
  origin: string
  /** The path of the checkout that was tested. */
  checkout: string
  /** True when the checkout belongs to the runner and is cleaned up. */
  owned: boolean
}

/** The default command of the suite. */
export const DEFAULT_COMMAND = ['bun', 'test', 'test/compatibility']

/** The process of the suite, when it runs: it is killed on a signal. */
let runningChild: Subprocess | null = null

/**
 * Reads the manifest of the references.
 *
 * The manifest is read relatively to the root of the repository: the
 * caller may run the script from anywhere.
 */
export async function readManifest(root: string): Promise<CompatibilityManifest> {
  const path = join(root, MANIFEST_NAME)
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    throw new Error(`the manifest of the references is not there: ${path}`)
  }
  return parseManifest(content)
}

/**
 * Parses the manifest of the references.
 *
 * The format is checked: a manifest that names a branch, a tag or a
 * placeholder is not a pin, and a pin that is not immutable cannot be
 * tested.
 */
export function parseManifest(content: string): CompatibilityManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`the manifest of the references is not a json document: ${String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('the manifest of the references is not an object')
  }
  const manifest = parsed as { version?: unknown; repositories?: unknown }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `the manifest of the references has the version ${String(manifest.version)} and not ${MANIFEST_VERSION}`
    )
  }
  if (typeof manifest.repositories !== 'object' || manifest.repositories === null) {
    throw new Error('the manifest of the references holds no repositories')
  }
  const repositories: Record<string, CompatibilityReference> = {}
  for (const [name, value] of Object.entries(manifest.repositories as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`the reference "${name}" of the manifest is not an object`)
    }
    const reference = value as { url?: unknown; commit?: unknown }
    if (typeof reference.url !== 'string' || reference.url.length === 0) {
      throw new Error(`the reference "${name}" of the manifest holds no url`)
    }
    if (typeof reference.commit !== 'string' || !COMMIT_PATTERN.test(reference.commit)) {
      throw new Error(
        `the reference "${name}" of the manifest holds the commit "${String(reference.commit)}", which is not the identifier of a commit: a full commit id is required`
      )
    }
    repositories[name] = { url: reference.url, commit: reference.commit }
  }
  if (!repositories[REFERENCE_NAME]) {
    throw new Error(`the manifest of the references holds no reference named "${REFERENCE_NAME}"`)
  }
  return { version: MANIFEST_VERSION, repositories }
}

/**
 * Resolves the source of the reference.
 *
 * The order of the sources is the one of the environment: an explicit
 * checkout, then an explicit repository, then a mirror, then the url of
 * the manifest. A source that is set and that cannot be used is an
 * error: the suite never falls back to another source.
 */
export function resolveSource(
  env: Record<string, string | undefined>,
  manifest: CompatibilityManifest
): ResolvedSource {
  const prepared = env.HUB_SHUTTLE_PATH
  if (prepared) {
    const path = resolve(prepared)
    if (!existsSync(path)) {
      throw new Error(`HUB_SHUTTLE_PATH names a directory that is not there: ${path}`)
    }
    return { kind: 'prepared', path, origin: `HUB_SHUTTLE_PATH (${path})` }
  }

  const repository = env.SHUTTLE_REPOSITORY
  if (repository) {
    return { kind: 'repository', repository, origin: `SHUTTLE_REPOSITORY (${repository})` }
  }

  const mirror = env.COMPAT_MIRROR
  if (mirror) {
    const path = join(resolve(mirror), `${REFERENCE_NAME}.git`)
    if (!existsSync(path)) {
      throw new Error(
        `COMPAT_MIRROR names a directory that holds no bare repository named "${REFERENCE_NAME}.git": ${path}`
      )
    }
    return { kind: 'repository', repository: path, origin: `COMPAT_MIRROR (${path})` }
  }

  const reference = manifest.repositories[REFERENCE_NAME]!
  return {
    kind: 'repository',
    repository: reference.url,
    origin: `the manifest (${reference.url})`,
  }
}

/** Runs a command and returns its status and its output. */
function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
): { status: number; output: string } {
  const result = spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`
  return { status: result.exitCode ?? 1, output }
}

/** The commit of the HEAD of a checkout. */
export function headOf(directory: string): string {
  const result = run(['git', 'rev-parse', 'HEAD'], { cwd: directory })
  if (result.status !== 0) {
    throw new Error(`${directory} is not a git checkout: ${result.output.trim()}`)
  }
  return result.output.trim()
}

/**
 * The tracked changes of a checkout.
 *
 * The untracked files are not reported: the dependencies of the reference
 * are installed in it, and they are not tracked.
 */
export function trackedChanges(directory: string): string {
  const result = run(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: directory })
  if (result.status !== 0) {
    throw new Error(`the state of ${directory} could not be read: ${result.output.trim()}`)
  }
  return result.output.trim()
}

/**
 * Checks a checkout that a developer prepared.
 *
 * The checkout is read, never written: a checkout that is not the pinned
 * commit, or that carries changes, is refused. The suite that runs
 * against another revision proves nothing, and a checkout that is
 * modified by the runner is a checkout the developer did not ask for.
 */
export function checkPreparedCheckout(directory: string, commit: string): void {
  const head = headOf(directory)
  if (head !== commit) {
    throw new Error(
      `the prepared checkout ${directory} is at ${head} and the pin is ${commit}: ` +
        'the checkout has to be at the pinned commit'
    )
  }
  const changes = trackedChanges(directory)
  if (changes.length > 0) {
    throw new Error(
      `the prepared checkout ${directory} carries changes to its tracked files:\n${changes}\n` +
        'the reference is read-only: the checkout has to be the one of the pinned commit'
    )
  }
}

/**
 * Clones a repository and checks out the pinned commit.
 *
 * The whole history is cloned: the pinned commit is not always the one
 * of the default branch, and the default branch of a source is not the
 * business of the runner.
 */
export function cloneAt(repository: string, commit: string, directory: string): void {
  const clone = run(['git', 'clone', '--quiet', '--no-checkout', repository, directory])
  if (clone.status !== 0) {
    throw new Error(
      `the clone of ${repository} failed: ${clone.output.trim()}\n` +
        'set SHUTTLE_REPOSITORY to a repository that holds the pinned commit, ' +
        'or COMPAT_MIRROR to a directory that holds the bare mirrors'
    )
  }
  const known = run(['git', 'cat-file', '-e', `${commit}^{commit}`], { cwd: directory })
  if (known.status !== 0) {
    // The commit is not reachable from the branches that were cloned: it
    // is asked for by its identifier.
    const fetch = run(['git', 'fetch', '--quiet', 'origin', commit], { cwd: directory })
    if (fetch.status !== 0) {
      throw new Error(
        `the source ${repository} does not hold the commit ${commit}\n` +
          'the pin has to be a commit of the source'
      )
    }
  }
  const checkout = run(['git', 'checkout', '--quiet', '--detach', commit], { cwd: directory })
  if (checkout.status !== 0) {
    throw new Error(
      `the checkout of ${commit} failed: ${checkout.output.trim()}\n` +
        `the source ${repository} does not hold the pinned commit`
    )
  }
}

/** Installs the dependencies of the reference, in the reference itself. */
export function install(directory: string): void {
  const result = run(['bun', 'install', '--frozen-lockfile'], { cwd: directory })
  if (result.status !== 0) {
    throw new Error(`the installation of the reference failed: ${result.output.trim()}`)
  }
}

/**
 * Runs the suite and waits for it.
 *
 * The process is killed when the runner is interrupted: a gateway that
 * outlives the run is a process that holds a port.
 */
export async function runSuite(
  root: string,
  checkout: string,
  command: string[],
  env: Record<string, string | undefined>
): Promise<number> {
  const child: Subprocess = spawn(command, {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      // The path of the reference is the one the suite reads: the suite
      // never looks for a sibling directory.
      HUB_SHUTTLE_PATH: checkout,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  runningChild = child
  try {
    const code = await child.exited
    // A process that was killed by a signal has no status: it is a
    // failure, and a failure that is not a success.
    return typeof code === 'number' ? code : 1
  } finally {
    runningChild = null
  }
}

/**
 * Runs the compatibility suite against the pinned reference.
 *
 * The function throws when the reference cannot be prepared, and it
 * returns the status of the suite when the suite ran: a failure of the
 * suite is the status of the suite, not an exception.
 */
export async function runCompatibility(options: RunnerOptions): Promise<RunnerResult> {
  const log = options.log ?? ((message: string) => console.log(message))
  const manifest = options.manifest ?? (await readManifest(options.root))
  const reference = manifest.repositories[REFERENCE_NAME]!
  const source = resolveSource(options.env, manifest)

  let checkout: string
  let owned = false
  let workspace: string | undefined
  let workspaceOwned = false

  if (source.kind === 'prepared') {
    checkout = source.path!
    checkPreparedCheckout(checkout, reference.commit)
    log(`the reference is the prepared checkout ${checkout}`)
  } else {
    if (options.workspace) {
      workspace = options.workspace
      await mkdir(workspace, { recursive: true })
    } else {
      workspace = await mkdtemp(join(tmpdir(), 'hub-compatibility-'))
      workspaceOwned = true
    }
    checkout = join(workspace, REFERENCE_NAME)
    log(`the reference is cloned from ${source.origin} at ${reference.commit}`)
    cloneAt(source.repository!, reference.commit, checkout)
    owned = true
  }

  const cleanup = async (): Promise<void> => {
    // A checkout of a developer is never removed: the runner only
    // removes what it owns.
    if (!owned || !workspace) return
    if (options.env.COMPAT_KEEP) {
      log(`the checkout is kept: ${checkout}`)
      return
    }
    await rm(checkout, { recursive: true, force: true })
    if (workspaceOwned) {
      await rm(workspace, { recursive: true, force: true })
    }
  }

  // An interruption removes the checkout of the runner and stops the
  // suite: a temporary directory that is left behind is a directory
  // nobody looks at again, and a gateway that outlives the run is a
  // process that holds a port.
  const interrupted = (): void => {
    try {
      runningChild?.kill('SIGTERM')
    } catch {
      // The process is already gone.
    }
    if (owned && workspace && !options.env.COMPAT_KEEP) {
      rmSync(workspace, { recursive: true, force: true })
    }
    process.exit(130)
  }
  process.on('SIGINT', interrupted)
  process.on('SIGTERM', interrupted)

  try {
    log(`the dependencies of the reference are installed in ${checkout}`)
    install(checkout)

    const head = headOf(checkout)
    const changes = trackedChanges(checkout)
    if (changes.length > 0) {
      throw new Error(`the reference carries changes to its tracked files:\n${changes}`)
    }
    log(`the reference is at ${head} and its tracked files are the ones of the commit`)

    const status = await runSuite(
      options.root,
      checkout,
      options.command ?? DEFAULT_COMMAND,
      options.env
    )

    const after = headOf(checkout)
    const afterChanges = trackedChanges(checkout)
    if (after !== head) {
      throw new Error(`the reference moved from ${head} to ${after} during the suite`)
    }
    if (afterChanges.length > 0) {
      throw new Error(`the suite modified the tracked files of the reference:\n${afterChanges}`)
    }
    log(`the reference is unchanged: it is still ${after}`)

    return { status, commit: head, origin: source.origin, checkout, owned }
  } finally {
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    await cleanup()
  }
}

/** The main of the runner. */
export async function main(): Promise<number> {
  const root = resolve(import.meta.dir, '..')
  const workspace = process.env.COMPAT_WORKSPACE
  try {
    const result = await runCompatibility({
      root,
      env: process.env,
      ...(workspace ? { workspace } : {}),
    })
    if (result.status !== 0) {
      console.error(`the compatibility suite failed with the status ${result.status}`)
      return result.status
    }
    console.log(
      `the compatibility suite passed against the gateway at ${result.commit} (${result.origin})`
    )
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exit(await main())
}
