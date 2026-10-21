# The readiness of Hub

The checklist of production readiness of the build
([IMPLEMENTATION.md](../IMPLEMENTATION.md) §11), item by item, with the
answer that is known today.

Every answer is a fact: a test, a measurement or a document. The items
that need a deployment are marked as such: they are checked during the
cutover of the first tenant, by a person who did not write the service.

## 11.1 The correctness

| Item | Answer |
| --- | --- |
| Every rule of the specification has a test | The map of the coverage is in [IMPLEMENTATION.md](../IMPLEMENTATION.md) §6.2. `bun test` runs 254 tests. |
| The compatibility suite passes and the diff of the gateway is empty | `test/compatibility/gateway.test.ts` runs the gateway of the reference, unchanged, against Hub. The CI checks that the tree of the reference is the one of `shuttle.ref`. |
| The migration applies on an empty database and on a database of the previous release | `test/integration/migrations.test.ts` — the migration applies on an empty database, it is idempotent and it refuses a database that holds a migration the code does not know. |
| A failure of every dependency is a denial, and it was tested with the dependency really down | The database that is down (a contract test), the decision that does not answer in time, the provider that is not reachable, the store that is down. |
| The reason of a denial reaches neither the caller nor a log line that a caller can read | The reason is in the log of the decision and in the answer of the contract; the gateway hides it from the caller (the contract of the gateway does not change). |

## 11.2 The security

| Item | Answer |
| --- | --- |
| The tokens are compared in constant time | `src/observability/secrets.ts` — the two values are hashed first. |
| The client secrets are encrypted at rest and are never returned, never logged | `src/platform/postgres/secrets.ts`, `test/integration/tenants.test.ts`. |
| The issuer of a tenant is an https url | The guard of the addresses: a production deployment refuses the private addresses and the addresses that are not http (`src/platform/bun/address.ts`). |
| The `idp_issuer` cannot reach an internal address | The host is resolved before the call and every address it resolves to has to be a public one. |
| The refusal pages escape what they show | `src/app/pages.ts`. |
| The state of the login is encrypted, is single use and expires | `src/domains/identity/state.ts`, `test/contract/login.test.ts`. |
| The authorization code is single use and is bound | `src/domains/provider/exchange.ts`, `test/contract/login.test.ts`. |
| The password of the database is not in the image | The environment of the deployment; the image carries no secret. |
| The image runs as a non-root user, has no shell and is scanned | `Dockerfile`, the job `image` of the CI. |
| The security review has no open finding above "low" | [security.md](security.md). |
| The rotation of the keys of a provider does not lock the logins out | The keys are read again when a token names a key that the cache does not have (spec §6.6); the test is `test/contract/rotation.test.ts`. |

## 11.3 The data

| Item | Answer |
| --- | --- |
| The five tables are the only domain tables, and the schema of the production is the schema of the migrations | The migrations of the platform; the bookkeeping of the migrations (`hub_schema_migrations`) is a table of the infrastructure and not of the domain. |
| The backup is automatic, the restore is rehearsed, and the time of the recovery is written down | [backup.md](backup.md). The rehearsal of the quarter is the moment where the times are measured. |
| The migration that removes a column is two releases after the one that stops using it | No migration removes a column: the five tables are the model (spec §13). |
| The audit log of the administration is shipped somewhere that is not the database | The audit is a log line of the service (`the administrative call`): it is shipped with the logs of the deployment. |
| The tenants are isolated by the database, and not only by the application | The row level security of the five tables, the scope of a statement (`src/platform/postgres/scope.ts`) and the refusal of a production deployment whose role bypasses the policies (spec §3.9). The test is `test/integration/isolation.test.ts`. |
| The membership of a group never names a principal of another tenant | The foreign keys of the schema and the check of the domain: a member that is not a principal of the tenant is a `404` (spec §9.9). |

## 11.4 The availability

| Item | Answer |
| --- | --- |
| The service is stateless: two replicas, one image, one digest | The state of a login is in the cookie of the browser and the code of a login is in the store; the image is promoted by its digest ([delivery.md](delivery.md)). |
| The drain of a replica does not break a login in flight | Five seconds of grace; the logins that are in flight finish (spec §11.4). |
| The store of the codes is a shared one, or the deployment is a single node that says so | `HUB_ALLOW_MEMORY_STATE` is the switch: a production deployment without a Redis refuses to start. |
| The provider of a tenant that is down degrades the tenant, not the service | The provider is called per tenant; the other tenants keep working ([runbooks.md](runbooks.md)). |
| The alerts are wired to a channel somebody reads | [alerts.md](alerts.md). The wiring is done with the platform of the deployment. |
| The runbooks exist and were walked through once | [runbooks.md](runbooks.md). The rehearsal is the moment of the cutover of the first tenant. |

## 11.5 The observability

| Item | Answer |
| --- | --- |
| The logs are structured, carry the request id and redact the secrets | `src/observability/logging.ts`; the request id is in every line of a request and in the answer. |
| The metrics of the specification are exposed, with the bounded labels | `src/observability/metrics.ts`; the label of the tenant is bounded at a hundred values. |
| A dashboard shows the rate of the decisions, the latency, the rate of the refusals of the login and the failures by dependency | The metrics exist; the dashboard is made with the platform of the deployment. |
| The log of a decision can be found from the request id of the gateway, through the subject and the workspace | The line of the decision carries the request id, the subject, the workspace and the route. |

## 11.6 The delivery

| Item | Answer |
| --- | --- |
| The image is built once and promoted by digest | [delivery.md](delivery.md). |
| The CI runs the type check, the lint, the tests, the architecture test, the compatibility test and the scan | The jobs `check`, `compatibility` and `image` of `.github/workflows/ci.yml`. |
| The rollback of the image is rehearsed | The rehearsal is the moment of the cutover: [cutover.md](cutover.md). |
| The version of the service is in the answer of `/healthz` and in the log of the start | `src/app/endpoints.ts` and the log `the listener started`. |

## The items that need a deployment

| Item | When it is checked |
| --- | --- |
| The capacity on the hardware of the production | During the cutover, with `scripts/load.ts` against the server of the deployment. |
| The saturation of the pool and the memory of the process | During the cutover, with the dashboard of the deployment. |
| The rehearsal of the restore and the time of the recovery | Once a quarter, with the environment of the rehearsal. |
| The wiring of the alerts and the rehearsal of the rollback | During the cutover of the first tenant, by a person who did not write the service. |
