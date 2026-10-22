# Hub — Release

What has to be true before Hub carries a customer's traffic, how a tenant
is moved onto it, how the image is delivered, and what this release does
**not** do.

---

## 1. The readiness checklist

It is checked, item by item, by a person who did not write the service.
Every item is answered with a fact: a test, a measurement, a document. "It
should be fine" is not an answer.

### The correctness

| Item | Answer |
| --- | --- |
| Every rule of the specification has a test | The kinds of tests are in [architecture.md](architecture.md) §"The tests". `bun run test` runs the tests of this repository, and `bun run test:compat` runs the compatibility suite. |
| The compatibility suite passes and the diff of the gateway is empty | `test/compatibility/gateway.test.ts` runs the gateway of the reference, unchanged, against Hub. The runner (`bun run test:compat`) prepares the revision that [`compatibility.json`](../compatibility.json) pins, and the CI checks that the tree of the reference is the one of that commit. The release runs the suite **again**, against the published image of the release and not against the source. |
| The migration applies on an empty database and on a database of the previous release | `test/integration/migrations.test.ts`: the migration applies on an empty database, it is idempotent and it refuses a database that holds a migration the code does not know. |
| A failure of every dependency is a denial, and it was tested with the dependency really down | The database that is down (a contract test), the decision that does not answer in time, the provider that is not reachable, the store that is down. |
| The reason of a denial reaches neither the caller nor a log line that a caller can read | The reason is in the log of the decision and in the answer of the contract; the gateway hides it from the caller. |

### The security

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
| The security review has no open finding above "low" | [security.md](security.md). One finding is "medium" and its plan is a migration of the deployments, not a change of the service. |
| The rotation of the keys of a provider does not lock the logins out | The keys are read again when a token names a key that the cache does not have (spec §6.6); the test is `test/contract/rotation.test.ts`. |

### The data

| Item | Answer |
| --- | --- |
| The five tables are the only domain tables, and the schema of the production is the schema of the migrations | The migrations of the platform; the bookkeeping of the migrations (`hub_schema_migrations`) is a table of the infrastructure and not of the domain. |
| The backup is automatic, the restore is rehearsed, and the time of the recovery is written down | [operations.md](operations.md) §"The backup and the restore". The rehearsal of the quarter is the moment where the times are measured. |
| The migration that removes a column is two releases after the one that stops using it | No migration removes a column: the five tables are the model (spec §14). |
| The audit of the administration is durable and is not in the logs alone | The audit is the table `admin_audit`: every change writes a row that names the action, the thing that changed, the tenant, the operator, the address and the request. The row is written by the statement that writes the change, so the two are committed together and a change that is not audited does not exist. It is read with `GET /v1/admin/audit`. |
| The tenants are isolated by the database, and not only by the application | The row level security of the five tables, the scope of a statement (`src/platform/postgres/scope.ts`) and the refusal of a production deployment whose role bypasses the policies (spec §3.9). The test is `test/integration/isolation.test.ts`. |
| The membership of a group never names a principal of another tenant | The foreign keys of the schema and the check of the domain: a member that is not a principal of the tenant is a `404` (spec §10.9). |

### The availability

| Item | Answer |
| --- | --- |
| The service is stateless: two replicas, one image, one digest | The state of a login is in the cookie of the browser and the code of a login is in the store; the image is promoted by its digest. |
| The drain of a replica does not break a login in flight | Five seconds of grace; the logins that are in flight finish (spec §12.4). |
| The store of the codes is a shared one, or the deployment is a single node that says so | `HUB_ALLOW_MEMORY_STATE` is the switch: a production deployment without a Redis refuses to start. |
| The provider of a tenant that is down degrades the tenant, not the service | The provider is called per tenant; the other tenants keep working. |
| The alerts are wired to a channel somebody reads | [operations.md](operations.md) §"The alerts". The wiring is done with the platform of the deployment. |
| The runbooks exist and were walked through once | [operations.md](operations.md) §"The runbooks". The rehearsal is the moment of the cutover of the first tenant. |

### The observability

| Item | Answer |
| --- | --- |
| The logs are structured, carry the request id and redact the secrets | `src/observability/logging.ts`; the request id is in every line of a request and in the answer. |
| The metrics of the specification are exposed, with the bounded labels | `src/observability/metrics.ts`; the label of the tenant is bounded at a hundred values. |
| A dashboard shows the rate of the decisions, the latency, the rate of the refusals of the login and the failures by dependency | The metrics exist; the dashboard is made with the platform of the deployment. |
| The log of a decision can be found from the request id of the gateway, through the subject and the workspace | The line of the decision carries the request id, the subject, the workspace and the route. |

### The delivery

| Item | Answer |
| --- | --- |
| The image is built once and promoted by digest | §5 below. The workflow of the release builds it once, publishes it, and every gate of the release runs against its digest. |
| The CI runs the type check, the lint, the tests, the architecture test, the compatibility test, the check of the version of the release and the scan | The jobs `check`, `compatibility` and `image` of `.github/workflows/ci.yml`. |
| The rollback of the image is rehearsed | The rehearsal is the moment of the cutover. |
| The version of the service is in the answer of `/healthz` and in the log of the start | `src/app/endpoints.ts` and the log `the listener started`. |

### The items that need a deployment

| Item | When it is checked |
| --- | --- |
| The capacity on the hardware of the production | During the cutover, with `scripts/load.ts` against the server of the deployment. |
| The saturation of the pool and the memory of the process | During the cutover, with the dashboard of the deployment. |
| The rehearsal of the restore and the time of the recovery | Once a quarter, on the environment of the rehearsal. |
| The wiring of the alerts and the rehearsal of the rollback | During the cutover of the first tenant, by a person who did not write the service. |

---

## 2. The rollout

| Phase | What is true | What is done | How it goes back |
| --- | --- | --- | --- |
| 0 — Dark | Hub runs, nobody calls it. | The deployment, the probes, the metrics, the alerts. | Stop the deployment. |
| 1 — Shadow | Hub answers the decisions in parallel with the service in production. | The comparison of §3, every day. | Stop the shadow. |
| 2 — The first tenant, in staging | A whole tenant lives on Hub. | The tenant is created, the principals are created, the grants are created, the gateway of the tenant is switched. | The gateway of the tenant goes back to the old access service. The data of Hub stays. |
| 3 — The first tenant, in production | The same, with real traffic. | A week of monitoring, then the second tenant. | The same. |
| 4 — The last tenant | The old access service is empty. | It is decommissioned. | The data is kept for the retention of the audit. |

The switch of a tenant is one change of the configuration of its gateway:
the issuer, the client id, the client secret and the access url. The
browser is redirected to Hub, the sessions of the gateway are new, and the
callers log in again. That is the only interruption of the cutover, and
it is a login, not an outage.

**The gate of every phase**: the compatibility suite is green, the alerts
are silent, and the difference between the answers of Hub and the ones of
the old service is empty.

---

## 3. The shadow comparison

Before the cutover, Hub answers the decisions in parallel with the access
service that is in production, and a tool compares the two answers on the
same requests.

```
OLD_ACCESS_URL=https://old-access.example.com \
OLD_ACCESS_TOKEN=… \
HUB_URL=https://hub.example.com \
HUB_ACCESS_TOKEN=… \
bun run scripts/shadow.ts --requests decisions.jsonl
```

The requests are read from a file, one json per line:

```
{"subject":"…","workspaceId":"…","routeId":"…","roles":[]}
```

The tool reports, per subject and per workspace, the answers that differ,
and it prints a fingerprint of the set of the differences, so the same
difference on every day is recognisable. **It exits non-zero while there
is a difference**: the shadow period does not end before the difference is
empty.

The expected difference is one: the decisions of the old service are the
ones that are hard-coded in it, and they are replaced by the grants. Every
other difference is a bug of Hub.

The tool reads the decisions of the old service and asks Hub; **it never
writes in Hub**.

---

## 4. The cutover of a tenant

The cutover is the moment where a tenant of a Shuttle deployment starts
to live in Hub.

### The gate of every phase

| The gate | How it is checked |
| --- | --- |
| The compatibility suite is green | `bun run test:compat` — the gateway of the reference, unchanged, against Hub. |
| The alerts are silent | The dashboards of [operations.md](operations.md) §"The alerts" show nothing for the period of the phase. |
| The difference of the answers is empty | `bun run scripts/shadow.ts --requests decisions.jsonl` answers zero difference. |

### Phase 2 — the first tenant, in the staging environment

1. **The tenant is registered** in the environment of the staging: the
   calls of [operations.md](operations.md) §"The first tenant".
2. **The principals are registered**: one call per external identity of
   the tenant. The external identity is the `sub` of the provider of the
   tenant — it is the key of the mapping (spec §6.2).
3. **The grants are registered**: one call per permission, on a workspace,
   on a route. The first ones are copied from the access service that is
   in production, so the shadow comparison has something to compare.
4. **The shadow runs for a day**: the tool of the comparison asks the two
   services the same decisions.
5. **The gateway of the staging is switched**: the issuer, the client id,
   the client secret and the access url become the ones of Hub.
6. **The check**: a browser logs in at the provider of the tenant and
   reaches an upstream of the staging. The metrics of the gateway count
   the decisions of Hub.

### Phase 3 — the first tenant, in production

1. The same sequence, with the production environment.
2. The **rehearsal of the rollback** is done before the switch: the
   previous configuration of the gateway is written down, and it is applied
   once on a deployment of the staging to prove that it works.
3. The switch of the gateway of the tenant.
4. The monitoring of the first day: the rate of the refusals of the
   login, the latency of the decision, the rate of the denials.
5. **The way back**: the configuration of the gateway is put back and the
   tenant is served by the old access service again. The data of Hub stays:
   the principals and the grants are not lost, and the tenant can be
   switched again without registering anything.

### What is not done during the cutover

- **No change in the gateway.** The gateway of the tenant is configured, it
  is not modified. The compatibility suite is the proof.
- **No migration of the data of the old service.** The old service has its
  own data; Hub has its own. The principals are registered one by one and
  the grants are created one by one.
- **No change of the sessions of the gateway.** The callers log in again:
  it is a login, not an outage.
- **No change of the schema in the middle of the cutover.** The migrations
  are backward compatible for one release: a rollback of the image does not
  need a rollback of the schema.

### The checklist of the cutover

- [ ] The tenant, its principals and its grants are registered in the
      environment of the target.
- [ ] The shadow comparison answers zero difference for a day.
- [ ] The compatibility suite is green.
- [ ] The eight calls of the session answer (`scripts/admin-smoke.ts`).
- [ ] The signing key of Hub is the one of the environment of the target,
      and the gateway is configured with the same issuer.
- [ ] The rollback of the configuration of the gateway is written down.
- [ ] The dashboards of the tenant are watched for the first day.

---

## 5. The delivery

The image of Hub is built once and promoted by its digest. Nothing is
rebuilt between the environments: the image that was tested is the image
that runs.

### The build

```bash
docker build -f Dockerfile -t hub:$(git rev-parse --short HEAD) \
  --build-arg REVISION=$(git rev-parse HEAD) \
  --build-arg VERSION=$(node -p "require('./package.json').version") .
```

The labels of the image carry the version and the revision, so an
operator knows what is running without reading the logs:

```bash
docker image inspect hub:<tag> --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

The base image is pinned by digest (`oven/bun:1.4.3-alpine@sha256:…`): a
tag is a name that moves, and the image of a release has to be the image
that was built, scanned and promoted.

### The release

A release is a tag. The tag names the version of the package, and the
workflows refuse a tag that does not.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

Two workflows run on the tag, and both of them check that the version of
the package, the version of the image, the version of the service and the
status of the specification are the same (`bun run versions`):

| Workflow | What it does |
| --- | --- |
| `release.yml` | It **builds the image of the release once** and publishes it with its provenance and its SBOM. Every gate of the release then runs against the **digest** of that build: it starts it with the configuration of a deployment, proves that it answers the decisions of a gateway and that it refuses to start without a secret and with a role that bypasses the isolation, drains it, scans it, and runs the **gateway of the reference against it**. It exports the published image as an artifact of the run, and it withdraws the image from the registry when a gate fails. |
| `release-binaries.yml` | It compiles the service for every supported platform, proves that the binary of the runner starts, applies the schema of the release and serves, and publishes the archives on the release of the tag. |

The image of the release is published with two tags, the tag of the
release (`v0.2.0`) and the version itself (`0.2.0`), and it is promoted by
its digest.

**The image is built once.** The build is published, and every gate of
the release — the probes, the decisions, the refusals, the drain, the
scan and the gateway of the reference — runs against the **digest** of
that build, never against a tag and never against a second build. The
image that was tested is the image that runs: the digest that the gates
proved is the digest that the deployment pins.

The image is published **before** the gates run, because the gates have
to run against the bytes that ship. A release whose gates failed does
not ship: the job `withdraw` removes the image from the registry, and
the tag of the release points at nothing.

The binaries are the service and nothing else: the runtime of the release
is inside the binary. **The schema of the release travels with the
binary**: the directory `migrations/` is deployed next to the executable,
and the binary finds it there. An archive holds the two, and the archive
of a platform is extracted in the directory of the deployment:

```bash
tar -xzf hub-0.2.0-linux-x64.tar.gz -C /opt/hub
/opt/hub/hub-0.2.0-linux-x64
```

The embedded PostgreSQL of a development machine is not part of a binary:
it is a development dependency, and it is not in the image of a
deployment either. A binary names a PostgreSQL server with
`HUB_DATABASE_URL`, and a service that does not find the schema refuses
to start and says where it looked: a service that starts against a
schema it does not understand is worse than a service that does not
start.

### The scan and the SBOM

The CI builds the image, scans it and writes its SBOM. A finding of a
severity above "high" fails the build:

```bash
trivy image --severity HIGH,CRITICAL --exit-code 1 hub:ci
syft hub:ci -o spdx-json > hub.spdx.json
```

The SBOM is published with the image: the deployment knows what it runs.

### The promotion

| Stage | What happens |
| --- | --- |
| The commit | The branch is merged when the CI is green and the specification is changed if the change moved a rule. |
| The review | One reviewer other than the author. |
| The image | The image is built once, tagged with the commit and pushed with its digest. **The digest is what is deployed.** |
| The promotion | The same digest goes from the development environment to the staging one and from the staging one to the production one. Nothing is rebuilt in between. |
| The deployment | A rolling replacement of the replicas, with the readiness probe as the gate. The drain of a replica takes the logins in flight with it. |
| The rollback | The previous digest is deployed again. The service is stateless except for the database, and the migrations are backward compatible for one release. |

### The drain

On `SIGTERM` the replica answers `503 draining` to its readiness, stops
accepting new work, gives the running logins five seconds and exits. The
replacement of a replica waits for it: the deployment gives it the grace
period of the drain (10 s) and the rollout waits for the pod to be gone.

### The rollback

```bash
kubectl -n hub rollout undo deployment/hub
kubectl -n hub rollout status deployment/hub
```

The rollback is rehearsed: a deployment that was never rolled back is a
deployment that does not know how to roll back.

### The CI

The CI of the repository runs, on every push:

| Job | What it runs |
| --- | --- |
| `check` | The types, the lint, the format, the import boundaries, the version of the release, the tests of this repository (`bun run test`), and the integration tests on a PostgreSQL server. |
| `compatibility` | `bun run test:compat`: the gateway of the reference, unchanged, against Hub, and the proof that the tree of the reference is the one of the commit that [`compatibility.json`](../compatibility.json) pins. |
| `image` | The build of the image, the scan, the SBOM, the user it runs as, its size, its refusal to start without a secret, its refusal to start with a role that bypasses the isolation, its start with a deployment and its drain. |

The `compatibility` job is the one that may never be skipped: a red
compatibility job is a red build, whatever the rest says.


---

## 6. What this release does not do

The deferred features are in [spec.md](spec.md) §14: SAML, the console,
SCIM, the directory sync and the linking of the accounts. There is no
column, no table, no flag and no endpoint for any of them, and a test
asserts that they are absent.

The limits that are **known** and that a deployment has to know about:

| The limit | What it means |
| --- | --- |
| **One gateway per tenant.** | A Shuttle deployment holds one client id, so one deployment serves one tenant of Hub. The shared client (`shared_client`) is the escape hatch and it is refused by default (spec §1.4, §5.2). |
| **The membership of a group is a list, not a table.** | `groups.members` is a `uuid[]`, so there is no foreign key on the membership: a member id outlives its principal, and the membership of a group is replaced in one statement. The membership is **indexed** (a GIN index), so the decision does not walk the groups of the tenant; a tenant with a large number of groups still pays the price of the containment on every decision. |
| **The deadline of a decision is the deadline of the pool.** | The `statement_timeout` of the connections of the pool is the tightest deadline of the service (`HUB_DECISION_TIMEOUT_MS`). A statement that takes too long is stopped by PostgreSQL and the connection is given back at once. The embedded database of a development machine does not interrupt a statement: on a development machine the deadline of the process is the only one, and the statement keeps the connection until the server answers it. |
| **The bearer token of the decisions is platform-wide.** | It is the scheme of the gateway of the reference, and it is not scoped. The credentials of a tenant are scoped and can replace it gateway by gateway (spec §8.8, and the third open finding of [security.md](security.md)). The rotation of the token is a rolling change now (spec §4.3.1). |
| **There is no refresh token.** | The tokens of Hub live five minutes and the gateway re-authenticates the caller after that (spec §7.2). |
| **The audit of the administration is a table, not a report.** | The audit is durable and it is queryable (`GET /v1/admin/audit`), but it has no report and no export: an operator reads it with `curl` and with SQL. |
| **The capacity numbers are measured on a development machine.** | The numbers of [operations.md](operations.md) §"The capacity" are the numbers of a development machine, against a PostgreSQL server over the loopback. The numbers of a deployment are measured during the cutover. |
| **The compatibility suite needs the reference.** | It clones the repository of the gateway from the network. An environment without the network gives it a mirror (`COMPAT_MIRROR`) or a local repository (`SHUTTLE_REPOSITORY`): the sources and the refusals are in [compatibility.md](compatibility.md). |
