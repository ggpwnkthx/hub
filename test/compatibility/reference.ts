import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The reference of the compatibility suite.
 *
 * The gateway of the reference is a checkout of another repository, at
 * the commit that `compatibility.json` pins. The suite never looks for
 * it: it is prepared by `bun run test:compat`, which passes its path in
 * the environment.
 *
 * A suite that is run without a prepared reference fails with a message
 * that says how to prepare it: a suite that silently skips the gateway
 * proves nothing.
 */
export function referenceRoot(): string {
  const path = process.env.HUB_SHUTTLE_PATH
  if (!path || path.trim().length === 0) {
    throw new Error(
      'the gateway of the reference is not prepared: run `bun run test:compat`, ' +
        'which prepares the pinned revision of the gateway and runs this suite against it'
    )
  }
  const root = resolve(path)
  if (!existsSync(join(root, 'src', 'main.ts'))) {
    throw new Error(
      `the prepared reference ${root} holds no gateway: the directory does not hold src/main.ts`
    )
  }
  return root
}
