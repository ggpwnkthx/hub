import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { openTestDatabase } from './database'
import { decide, type DecisionFacts } from '../../src/domains/authorization'
import { DecisionRepository } from '../../src/platform/postgres'
import type { Database } from '../../src/platform/postgres'

/**
 * The rule of the decision, against a random policy (spec §8.3).
 *
 * The rule of a decision is the one place where a mistake is a hole: a
 * grant that is not live and that is read as live is an access that
 * nobody granted. The examples of the other tests prove the cases that
 * were thought of; the test of this file proves the cases that were not.
 *
 * The policy is built at random and the answer is compared to the answer
 * of a second implementation of the rule, written here and written
 * differently: the storage returns the facts, and the facts are compared
 * to the facts that the policy describes.
 */
let database: Database

/**
 * The generator of the test.
 *
 * The seed is fixed: a failure of this test is a failure that can be
 * read again, and it is the same failure on every machine.
 */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A choice of the generator. */
function choice<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

/** A grant of the policy that is built at random. */
interface RandomGrant {
  /** The permission of the grant. */
  permission: string
  /** The group of the grant, or null when it names the principal. */
  group: string | null
  /** The workspace of the grant, or null when it is every workspace. */
  workspace: string | null
  /** The route of the grant, or null when it is every route. */
  route: string | null
  /** True when the grant is revoked. */
  revoked: boolean
  /** True when the grant has expired. */
  expired: boolean
  /** True when the permission of the grant is disabled. */
  disabled: boolean
  /** The members of the group of the grant. */
  members: string[]
}

beforeAll(async () => {
  database = await openTestDatabase()
})

afterAll(async () => {
  await database.close()
})

describe('the rule of the decision, against a random policy', () => {
  test('the facts of a decision are the facts of the policy', async () => {
    const random = generator(20261021)
    const repository = new DecisionRepository(database, 5_000)

    for (let round = 0; round < 40; round += 1) {
      // The tenant, the principal and the groups of the round.
      const tenant = await database.query<{ id: string }>(
        `insert into tenants (slug, display_name, idp_issuer, idp_client_id, idp_client_secret,
           idp_redirect_uri, client_id, client_secret)
         values ($1, $1, 'https://login.example.com', $2, $3, 'https://hub.example.com/cb', $4, $3)
         returning id`,
        [
          `property-${round}`,
          `hub-property-${round}`,
          Buffer.from('secret'),
          `shuttle-property-${round}`,
        ]
      )
      const tenantId = tenant[0]!.id
      const principal = await database.query<{ id: string }>(
        `insert into users (tenant_id, external_subject) values ($1, $2) returning id`,
        [tenantId, `subject-${round}`]
      )
      const subject = principal[0]!.id

      // The groups of the round and their members.
      const groups: { key: string; members: string[] }[] = []
      const groupCount = Math.floor(random() * 4)
      for (let index = 0; index < groupCount; index += 1) {
        const key = `group-${index}`
        const members: string[] = []
        if (random() < 0.6) members.push(subject)
        groups.push({ key, members })
        await database.query(`insert into groups (tenant_id, key, members) values ($1, $2, $3)`, [
          tenantId,
          key,
          members,
        ])
      }

      // The grants of the round.
      const grants: RandomGrant[] = []
      const grantCount = Math.floor(random() * 6)
      // Two live grants of the same scope are refused by the schema: the
      // generator does not build one.
      const scopes = new Set<string>()
      // The permission of the platform is one row per key: the last grant
      // that names it decides whether it is enabled.
      const enabled = new Map<string, boolean>()
      for (let index = 0; index < grantCount; index += 1) {
        const group = groups.length > 0 && random() < 0.5 ? choice(random, groups) : null
        const grant: RandomGrant = {
          permission: choice(random, ['workspace.read', 'workspace.write']),
          group: group?.key ?? null,
          workspace: choice(random, ['the-workspace', 'the-other-workspace', null]),
          route: choice(random, ['the-route', null]),
          revoked: random() < 0.25,
          expired: random() < 0.25,
          disabled: random() < 0.15,
          members: group?.members ?? [],
        }
        const scope = [
          grant.group ?? 'the-principal',
          grant.permission,
          grant.workspace ?? 'every-workspace',
          grant.route ?? 'every-route',
        ].join('|')
        if (!grant.revoked && scopes.has(scope)) continue
        if (!grant.revoked) scopes.add(scope)
        grants.push(grant)
        enabled.set(grant.permission, !grant.disabled)
        const permission = await database.query<{ id: string }>(
          `insert into permissions (tenant_id, key, enabled)
             select $1, $2, not $3
             on conflict (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
             do update set enabled = not $3
           returning id`,
          [tenantId, grant.permission, grant.disabled]
        )
        const groupId = grant.group
          ? (
              await database.query<{ id: string }>(
                `select id from groups where tenant_id = $1 and key = $2`,
                [tenantId, grant.group]
              )
            )[0]!.id
          : null
        await database.query(
          `insert into grants (tenant_id, user_id, group_id, permission_id, workspace_id, route_id,
             expires_at, revoked_at)
           values ($1, $2, $3, $4, $5, $6,
             case when $7 then now() - interval '1 hour' else null end,
             case when $8 then now() else null end)`,
          [
            tenantId,
            groupId ? null : subject,
            groupId,
            permission[0]!.id,
            grant.workspace,
            grant.route,
            grant.expired,
            grant.revoked,
          ]
        )
      }

      // The request of the decision, and the workspace and the route it
      // asks about.
      const workspace = choice(random, ['the-workspace', 'the-other-workspace'])
      const route = choice(random, ['the-route', 'the-other-route'])
      const request = { subject, workspaceId: workspace, routeId: route, roles: [] }

      // The answer of the second implementation of the rule: it reads the
      // policy that was built, and not the storage.
      const matching = grants.filter(
        (grant) =>
          !grant.revoked &&
          (grant.workspace === null || grant.workspace === workspace) &&
          (grant.route === null || grant.route === route) &&
          (grant.group === null || grant.members.includes(subject))
      )
      const live = matching.some(
        (grant) => enabled.get(grant.permission) === true && !grant.expired
      )
      // The reason of the refusal is the expiry only when there is no
      // live grant: a grant of a disabled permission is not a grant.
      const expired =
        !live && matching.some((grant) => enabled.get(grant.permission) === true && grant.expired)

      const facts: DecisionFacts = await repository.decide(request)
      expect(facts.principalExists).toBe(true)
      expect(facts.principalActive).toBe(true)
      expect(facts.tenantEnabled).toBe(true)
      expect(facts.liveGrant).toBe(live)
      expect(facts.expiredGrant).toBe(expired)

      const answer = decide(facts)
      expect(answer.allow).toBe(live)
      // The rule never allows without a live grant: this is the property
      // that a hole of the statement would break.
      if (answer.allow) {
        expect(live).toBe(true)
      }
    }
  })

  test('a principal of another tenant is a denial', async () => {
    const repository = new DecisionRepository(database, 5_000)
    const tenant = await database.query<{ id: string }>(
      `insert into tenants (slug, display_name, idp_issuer, idp_client_id, idp_client_secret,
         idp_redirect_uri, client_id, client_secret)
       values ('other-tenant', 'Other', 'https://login.example.com', 'hub-other', $1,
         'https://hub.example.com/cb', 'shuttle-other', $1)
       returning id`,
      [Buffer.from('secret')]
    )
    const principal = await database.query<{ id: string }>(
      `insert into users (tenant_id, external_subject) values ($1, 'the-subject') returning id`,
      [tenant[0]!.id]
    )
    const facts = await repository.decide({
      subject: principal[0]!.id,
      workspaceId: 'the-workspace',
      routeId: 'the-route',
      roles: [],
    })
    expect(facts.principalExists).toBe(true)
    expect(facts.liveGrant).toBe(false)
    expect(decide(facts).allow).toBe(false)
  })
})
