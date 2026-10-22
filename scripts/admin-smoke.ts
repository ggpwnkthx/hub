#!/usr/bin/env bun
/**
 * The nine calls of the administration (spec §10.11).
 *
 * The script is the smoke test of a deployment: it creates a tenant, it
 * lists the tenants, it creates a principal, it lists the principals, it
 * grants a permission, it lists the grants, it creates a group, it lists
 * the groups and it revokes the grant. It reads the environment of the
 * process: it is an operator tool and not part of the service.
 *
 *   HUB_URL=https://hub.example.com HUB_ADMIN_TOKEN=… bun run scripts/admin-smoke.ts
 */
const base = (process.env.HUB_URL ?? 'http://127.0.0.1:8081').replace(/\/$/, '')
const token = process.env.HUB_ADMIN_TOKEN
if (!token) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'the smoke test needs the token of the administration',
      error: 'HUB_ADMIN_TOKEN must be set',
    })
  )
  process.exit(1)
}

/** The slug of the tenant of the smoke test. */
const slug = process.env.HUB_SMOKE_SLUG ?? 'smoke'

/** Calls the administration. */
async function call(
  path: string,
  method: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: (parsed ?? {}) as Record<string, unknown> }
}

/** Fails the smoke test with the reason of the failure. */
function fail(message: string, detail?: unknown): never {
  console.error(JSON.stringify({ level: 'error', msg: message, detail }))
  process.exit(1)
}

async function main(): Promise<void> {
  // 1. the tenant and the registration of its gateway
  const tenant = await call('/v1/admin/tenants', 'POST', {
    slug,
    displayName: 'Smoke Test',
    issuer: 'https://login.smoke.example',
    idpClientId: `hub-${slug}`,
    idpClientSecret: 'the-secret-of-the-provider',
    clientId: `shuttle-${slug}`,
    clientSecret: 'the-secret-of-the-gateway',
    // The url the gateway sends the browser back to. A url that is not
    // registered is refused: the tenant would refuse every login.
    clientRedirectUris: [`https://${slug}.example.com/auth/callback`],
    emailDomain: 'smoke.example',
  })
  if (tenant.status !== 201 && tenant.status !== 200) {
    fail('the tenant could not be created', tenant)
  }
  const tenantId = tenant.body.id as string

  // 2. the tenants, with their counts
  const tenants = await call('/v1/admin/tenants', 'GET')
  if (tenants.status !== 200) fail('the tenants could not be listed', tenants)
  const listed = (tenants.body.tenants ?? []) as { slug: string }[]
  if (!listed.some((row) => row.slug === slug)) {
    fail('the tenant is not in the list', tenants)
  }

  // 3. the principal of the external identity
  const principal = await call('/v1/admin/users', 'POST', {
    tenant: slug,
    externalSubject: 'the-subject-of-the-smoke-test',
    email: 'smoke@smoke.example',
  })
  if (principal.status !== 201 && principal.status !== 200) {
    fail('the principal could not be created', principal)
  }

  // 4. the principals of the tenant
  const principals = await call(`/v1/admin/users?tenant=${slug}`, 'GET')
  if (principals.status !== 200) fail('the principals could not be listed', principals)
  const listedPrincipals = (principals.body.principals ?? []) as { id: string }[]
  if (!listedPrincipals.some((row) => row.id === principal.body.id)) {
    fail('the principal is not in the list', principals)
  }

  // 5. the grant: the permission on the workspace, on the route
  const grant = await call('/v1/admin/grants', 'PUT', {
    tenant: slug,
    userId: principal.body.id,
    permission: 'workspace.read',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    routeId: 'workspace-api',
  })
  if (grant.status !== 200) fail('the grant could not be created', grant)

  // 6. the grants of the tenant
  const grants = await call(`/v1/admin/grants?tenant=${slug}`, 'GET')
  if (grants.status !== 200) fail('the grants could not be listed', grants)
  const listedGrants = (grants.body.grants ?? []) as { id: string }[]
  if (!listedGrants.some((row) => row.id === grant.body.id)) {
    fail('the grant is not in the list', grants)
  }

  // 7. the group and its membership: a grant of the group holds for every
  // member of the group
  const group = await call('/v1/admin/groups', 'POST', {
    tenant: slug,
    key: 'smoke-team',
    displayName: 'The team of the smoke test',
    members: ['the-subject-of-the-smoke-test'],
  })
  if (group.status !== 201 && group.status !== 200) {
    fail('the group could not be created', group)
  }

  // 8. the groups of the tenant
  const groups = await call(`/v1/admin/groups?tenant=${slug}`, 'GET')
  if (groups.status !== 200) fail('the groups could not be listed', groups)
  const listedGroups = (groups.body.groups ?? []) as { key: string }[]
  if (!listedGroups.some((row) => row.key === 'smoke-team')) {
    fail('the group is not in the list', groups)
  }

  // 9. the revocation, when the access has to end
  const revoked = await call(`/v1/admin/grants/${grant.body.id}`, 'DELETE')
  if (revoked.status !== 204) fail('the grant could not be revoked', revoked)

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'the nine calls of the administration answered',
      tenant: tenantId,
      principal: principal.body.id,
      grant: grant.body.id,
      revoked: true,
    })
  )
}

main().catch((error) => {
  console.error(
    JSON.stringify({ level: 'error', msg: 'the smoke test failed', error: String(error) })
  )
  process.exit(1)
})
