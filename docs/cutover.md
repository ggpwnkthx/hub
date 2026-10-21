# The cutover of a tenant

The cutover is the moment where a tenant of a Shuttle deployment starts
to live in Hub. It is a change of the configuration of the gateway of the
tenant: the issuer, the client id, the client secret and the access url.
The browser is redirected to Hub, the sessions of the gateway are new, and
the callers log in again. That is the only interruption of the cutover,
and it is a login, not an outage.

The phases and their gates are in [IMPLEMENTATION.md](../IMPLEMENTATION.md) §12.

## The gate of every phase

| The gate | How it is checked |
| --- | --- |
| The compatibility suite is green | `bun test test/compatibility` — the gateway of the reference, unchanged, against Hub. |
| The alerts are silent | The dashboards of the alerts of [alerts.md](alerts.md) show nothing for the period of the phase. |
| The difference of the answers is empty | `bun run scripts/shadow.ts --requests decisions.jsonl` answers zero difference. |

## Phase 2 — the first tenant, in the staging environment

1. **The tenant is registered** in the environment of the staging:
   the calls of [deployment.md](deployment.md) §"the first tenant".
2. **The principals are registered**: one call per external identity of
   the tenant. The external identity is the `sub` of the provider of the
   tenant — it is the key of the mapping (spec §6.2).
3. **The grants are registered**: one call per permission, on a workspace,
   on a route. The first ones are copied from the access service that is
   in production, so the shadow comparison has something to compare.
4. **The shadow runs for a day**: the tool of the comparison asks the two
   services the same decisions. The expected difference is one: the
   decisions of the old service are the ones that are hard-coded in it,
   and they are replaced by the grants. Every other difference is a bug
   of Hub.
5. **The gateway of the staging is switched**: the issuer, the client id,
   the client secret and the access url become the ones of Hub.
6. **The check**: a browser logs in at the provider of the tenant and
   reaches an upstream of the staging. The metrics of the gateway count
   the decisions of Hub.

## Phase 3 — the first tenant, in production

1. The same sequence, with the production environment.
2. The **rehearsal of the rollback** is done before the switch: the
   previous configuration of the gateway is written down, and it is
   applied once on a deployment of the staging to prove that it works.
3. The switch of the gateway of the tenant.
4. The monitoring of the first day: the rate of the refusals of the
   login, the latency of the decision, the rate of the denials.
5. **The way back**: the configuration of the gateway is put back and the
   tenant is served by the old access service again. The data of Hub
   stays: the principals and the grants are not lost, and the tenant can
   be switched again without registering anything.

## What is not done during the cutover

- **No change in the gateway.** The gateway of the tenant is configured,
  it is not modified. The compatibility suite is the proof.
- **No migration of the data of the old service.** The old service has
  its own data; Hub has its own. The principals are registered one by one
  and the grants are created one by one.
- **No change of the sessions of the gateway.** The callers log in
  again: it is a login, not an outage.
- **No change of the schema in the middle of the cutover.** The
  migrations are backward compatible for one release: a rollback of the
  image does not need a rollback of the schema.

## The checklist of the cutover

- [ ] The tenant, its principals and its grants are registered in the
      environment of the target.
- [ ] The shadow comparison answers zero difference for a day.
- [ ] The compatibility suite is green.
- [ ] The eight calls of the session answer (`scripts/admin-smoke.ts`).
- [ ] The signing key of Hub is the one of the environment of the target,
      and the gateway is configured with the same issuer.
- [ ] The rollback of the configuration of the gateway is written down.
- [ ] The dashboards of the tenant are watched for the first day.
