#!/usr/bin/env bun
/**
 * The shadow comparison (the guide of the build, §8.3).
 *
 * The tool asks Hub and the access service that is in production the
 * same decisions, and it reports the answers that differ. It reads the
 * decisions of the old service and it asks Hub: it never writes in Hub.
 *
 * The requests are read from a file, one json per line:
 *
 *   {"subject":"…","workspaceId":"…","routeId":"…","roles":[]}
 *
 *   OLD_ACCESS_URL=https://old-access.example.com \\
 *   OLD_ACCESS_TOKEN=… \\
 *   HUB_URL=https://hub.example.com \\
 *   HUB_ACCESS_TOKEN=… \\
 *   bun run scripts/shadow.ts --requests decisions.jsonl
 */
import { createHash } from 'node:crypto'

/** The file of the requests. */
const file = readOption('requests') ?? 'decisions.jsonl'

/** Reads an option of the command line. */
function readOption(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((argument) => argument.startsWith(flag))
  if (inline) return inline.slice(flag.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

/** A decision of the contract of the gateway. */
interface Decision {
  allow: boolean
  reason: string
}

/** Asks an access service for a decision. */
async function ask(
  baseUrl: string,
  token: string,
  request: Record<string, unknown>
): Promise<Decision | null> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/decisions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    })
    if (!response.ok) return null
    return (await response.json()) as Decision
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const oldUrl = process.env.OLD_ACCESS_URL
  const oldToken = process.env.OLD_ACCESS_TOKEN ?? ''
  const hubUrl = process.env.HUB_URL
  const hubToken = process.env.HUB_ACCESS_TOKEN ?? ''
  if (!oldUrl || !hubUrl) {
    throw new Error(
      'the comparison needs the two access services: OLD_ACCESS_URL and HUB_URL must be set'
    )
  }

  const content = await Bun.file(file).text()
  const requests = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

  let compared = 0
  let different = 0
  const differences: {
    subject: string
    workspaceId: string
    old: Decision | null
    hub: Decision | null
  }[] = []

  for (const request of requests) {
    const [old, hub] = await Promise.all([
      ask(oldUrl, oldToken, request),
      ask(hubUrl, hubToken, request),
    ])
    compared += 1
    if (!old || !hub) {
      different += 1
      differences.push({
        subject: String(request.subject),
        workspaceId: String(request.workspaceId ?? ''),
        old,
        hub,
      })
      continue
    }
    if (old.allow !== hub.allow) {
      different += 1
      differences.push({
        subject: String(request.subject),
        workspaceId: String(request.workspaceId ?? ''),
        old,
        hub,
      })
    }
  }

  console.log(
    JSON.stringify(
      {
        level: 'info',
        msg: 'the shadow comparison is over',
        compared,
        different,
        // The fingerprint of the set of the differences: the same
        // difference on every day is the same difference.
        fingerprint: createHash('sha256')
          .update(JSON.stringify(differences))
          .digest('hex')
          .slice(0, 16),
      },
      null,
      2
    )
  )
  for (const difference of differences.slice(0, 20)) {
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: 'the answers differ',
        subject: difference.subject,
        workspaceId: difference.workspaceId,
        old: difference.old,
        hub: difference.hub,
      })
    )
  }
  // The shadow period does not end before the difference is empty.
  if (different > 0) process.exit(1)
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'the comparison failed', error: String(error) })
  )
  process.exit(1)
})
