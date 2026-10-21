# Hub — Operations

Running Hub: what a deployment needs, how it is configured, how it is
watched, and what to do when it breaks. The contract is in
[spec.md](spec.md); the endpoints are in [api.md](api.md).

The names used below: **the deployment** is the set of the replicas of
Hub behind the ingress; **the database** is the PostgreSQL of the five
tables; **the store** is the Redis of the authorization codes; **the
provider of a tenant** is the identity provider of a tenant, outside of
the deployment; **the operator** is the person who runs the deployment.

---

## What a deployment needs

| What | Why | The variable |
| --- | --- | --- |
| A PostgreSQL | The five tables of the platform. | `HUB_DATABASE_URL` |
| A Redis | The authorization codes of the logins, shared by the replicas. | `HUB_REDIS_URL` |
| An issuer | The url the browser and the gateway use to reach Hub. | `HUB_ISSUER` |
| A signing key | The key of the tokens of Hub, in PEM. | `HUB_SIGNING_KEY`, `HUB_SIGNING_KID` |
| A secret of the state | It signs and encrypts the state of a login. | `HUB_STATE_SECRET` |
| A key of the secrets | It encrypts the client secrets of the tenants at rest. | `HUB_SECRET_ENCRYPTION_KEY` |
| A token of the administration | It guards the eight administrative endpoints. | `HUB_ADMIN_TOKEN` |
| A token of the access service | The gateway presents it on the decisions. | `HUB_ACCESS_TOKEN` |

The full list of the variables is in §4 of the spec; `.env.example` holds
the same list with the values of a development machine.

A **production** deployment (`HUB_ENVIRONMENT=production`) refuses to
start when one of the nine required variables is missing, and it reports
every problem at once, with the names of the variables.

### The role of the database

The isolation of the tenants is enforced by the database, and the policies
of the tables are only policies for a role that is subject to them. A
**production** deployment refuses to start with a superuser and with a
role that has `BYPASSRLS` (spec §3.9).

The role of the deployment therefore owns the tables of the platform and
is not a superuser:

```sql
create role hub_app login password '…';
alter database hub owner to hub_app;
grant usage, create on schema public to hub_app;
```

The migrations are applied by that role, so it owns the tables it creates.

### The environment of a replica

```
HUB_ENVIRONMENT=production
HUB_HOST=0.0.0.0
HUB_PORT=8081
HUB_ISSUER=https://hub.example.com
HUB_PUBLIC_URL=https://hub.example.com
HUB_DATABASE_URL=postgres://hub_app:…@postgres:5432/hub
HUB_REDIS_URL=redis://redis:6379/0
HUB_ADMIN_TOKEN=…
HUB_ACCESS_TOKEN=…
HUB_METRICS_TOKEN=…
HUB_STATE_SECRET=…            # 32 bytes at least, the same on every replica
HUB_SECRET_ENCRYPTION_KEY=…   # 32 bytes at least
HUB_SIGNING_KEY=…             # PEM
HUB_SIGNING_KID=hub-1
HUB_LOG_LEVEL=info
```

### The image

The image runs as a user that is not `root` and it writes nothing: the
file system of the container can be read-only, apart from the temporary
directory of the runtime. The logs go to the standard output.

```bash
docker build -f Dockerfile -t hub:$(git rev-parse --short HEAD) \
  --build-arg REVISION=$(git rev-parse HEAD) \
  --build-arg VERSION=$(node -p "require('./package.json').version") .
```

The base image is pinned by digest: a tag is a name that moves, and the
image of a release has to be the image that was built, scanned and
promoted. The delivery of the image is in [release.md](release.md) §5.

### The first tenant

1. **The tenant** — the registration of its provider and of its gateway:
   ```bash
   curl -sS -X POST $HUB/v1/admin/tenants \
     -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
     -H "content-type: application/json" \
     -d '{"slug":"acme","displayName":"Acme Inc","issuer":"https://login.acme.example",
          "idpClientId":"hub-acme","idpClientSecret":"…",
          "idpRedirectUri":"https://hub.example.com/oauth/tenant/callback",
          "emailDomain":"acme.example","clientId":"shuttle-acme","clientSecret":"…"}'
   ```
2. **The principals** — one call per external identity:
   ```bash
   curl -sS -X POST $HUB/v1/admin/users \
     -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
     -H "content-type: application/json" \
     -d '{"tenant":"acme","externalSubject":"00u1a2b3c4d5","email":"alice@acme.example"}'
   ```
3. **The grants** — one call per permission, on a workspace, on a route:
   ```bash
   curl -sS -X PUT $HUB/v1/admin/grants \
     -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
     -H "content-type: application/json" \
     -d '{"tenant":"acme","userId":"b1c2…","permission":"workspace.read",
          "workspaceId":"11111111-1111-4111-8111-111111111111","routeId":"workspace-api"}'
   ```
4. **The gateway** — the configuration of the deployment of Shuttle:
   ```
   SHUTTLE_OIDC_ISSUER=https://hub.example.com
   SHUTTLE_OIDC_CLIENT_ID=shuttle-acme
   SHUTTLE_OIDC_CLIENT_SECRET=the-secret-of-the-gateway
   SHUTTLE_OIDC_REDIRECT_URI=https://shuttle-acme.example.com/auth/callback
   SHUTTLE_ACCESS_URL=https://hub.example.com
   SHUTTLE_ACCESS_TOKEN=the-access-token-of-hub
   ```
   The two sides have to agree character for character (spec §12.2).
5. **The check** — the eight calls of the session:
   ```bash
   HUB_URL=https://hub.example.com HUB_ADMIN_TOKEN=… bun run scripts/admin-smoke.ts
   ```

---

## The probes of the deployment

| Probe | What it is for |
| --- | --- |
| `GET /healthz` | The process answers. It is the liveness probe: `200` as long as the process is alive. |
| `GET /readyz` | The service can serve the traffic: the database answers and the migrations are applied. It is `503 {"status":"draining"}` during a drain: it is the gate of the rolling replacement. |

---

## The metrics

The metrics are at `/metrics` and they need `HUB_METRICS_TOKEN`.

| Metric | Type | Labels |
| --- | --- | --- |
| `hub_decisions_total` | counter | `result` (`allow`, `deny`), `tenant` |
| `hub_decision_duration_seconds` | histogram | `tenant` |
| `hub_logins_total` | counter | `result` (`success`, `refused`, `error`), `tenant` |
| `hub_admin_requests_total` | counter | `endpoint`, `status` |
| `hub_store_errors_total` | counter | `store` (`redis`, `postgres`) |

The label of the tenant is bounded: a hundred tenants and then
`overflow`. Neither a caller nor a provider can grow the number of the
series without limit.

## The alerts

An alert is a question that somebody has to answer. Every one of them is
answered by a metric of the service.

| # | The alert | The expression | For how long | What it means |
| --- | --- | --- | --- | --- |
| 1 | **The rate of the denials** | `rate(hub_decisions_total{result="deny"}[5m]) / rate(hub_decisions_total[5m]) > 0.2` | 10 min | A fifth of the requests are denied. It is either a tenant that grants nothing, or an attack. The reason is in the log of the decision. |
| 2 | **The latency of the decision** | `histogram_quantile(0.99, rate(hub_decision_duration_seconds_bucket[5m])) > 0.02` | 5 min | The decision is on the path of every request of the gateway. The target is 20 ms at the `p99`. |
| 3 | **The failures of the login** | `rate(hub_logins_total{result!="success"}[10m]) > 0.1` | 10 min | The logins of the tenants fail: the provider of a tenant is down, the tenant is disabled, or the state of the login is refused. |
| 4 | **The failures of the stores** | `rate(hub_store_errors_total[5m]) > 0` | 5 min | The database or the store is not reachable. The readiness turns `503` and the deployment is taken out of the rotation. |
| 5 | **The saturation of the pool** | `pg_stat_activity_count{application_name='hub'} > 7` | 5 min | The pool of the database is at 70 % (10 connections per replica). |
| 6 | **The schema of the database is older than the code** | The readiness of the new replicas stays `503 not-ready` and the log of the start names a migration that the code does not know | 5 min | Hub refuses to start against a schema it does not understand (spec §3.7), and the migration is applied before the listener accepts. Hub does not expose the age of the schema as a metric: the readiness is the observable. |
| 7 | **The refusals of the administration** | `rate(hub_admin_requests_total{status="401"}[5m]) > 0` | 5 min | Somebody tries to guess the token of the administration. The limiter refuses the address after five failures (`429`). |
| 8 | **The readiness** | `probe_success{job="hub"} == 0` | 2 min | The replicas do not answer their readiness: the database does not answer, or the deployment is draining. |

Four more need a metric of the platform: the replicas that are not ready
(the probe of `/readyz`), the memory of the pod (200 MB), the certificate
of the ingress, and the age of the last dump of the database.

**An alert never restarts a replica by itself**: a replica that cannot
reach the database restarts and fails again, and the restarts hide the
cause. The alert is read by a person, and the person follows the runbook.

---

## The runbooks

### The provider of a tenant is down

**What the operator sees.** The logins of that tenant are refused with
`502 upstream_unavailable` and `hub_logins_total{result="refused"}` grows.
The other tenants keep working: the provider is called per tenant.

**What to do.**

1. Check that the provider answers:
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://login.acme.example/.well-known/openid-configuration
   ```
2. Check that the deployment reaches it: the same call from the pod of a
   replica.
3. If the provider is down, there is nothing to do: Hub fails the login of
   that tenant and the other tenants are untouched.
4. When the provider answers again, the logins resume by themselves: the
   discovery document and the keys are cached for ten minutes.

**What not to do.** Do not raise the timeout of the provider: a provider
that is slow must not hold the logins (the deadline is
`HUB_IDP_TIMEOUT_MS`, 5 s by default).

### The database is down

**What the operator sees.** The readiness answers `503 not-ready` and the
deployment is taken out of the rotation. The decisions answer `503
service_unavailable` and the gateway denies the requests — it fails
closed.

**What to do.**

1. Check the database:
   ```bash
   pg_isready -h "$HUB_DATABASE_HOST" -p 5432 -U hub -d hub
   ```
2. Check the pool of the replicas: `hub_store_errors_total{store="postgres"}`
   grows and the readiness is `503`.
3. **The replicas do not start** against a database they cannot reach: the
   migrations run before the listener accepts. This is on purpose — Hub
   does not start against a schema it does not understand.
4. When the database answers, the replicas start and the readiness turns
   green by itself.

**The decisions are not cached.** There is no decision to serve while the
database is down: a decision that cannot be computed is a denial.

### The store is down

**What the operator sees.** The logins that reach the exchange fail: the
code cannot be stored. `hub_store_errors_total{store="redis"}` grows. The
decisions keep working: they do not touch the store.

**What to do.**

1. Check the store:
   ```bash
   redis-cli -u "$HUB_REDIS_URL" ping
   ```
2. **A store that is down is an error and never a silent allowance**: the
   login does not succeed without the code. A caller who sees the failure
   retries the login.
3. If the deployment is a single node, it can be started with
   `HUB_ALLOW_MEMORY_STATE=true`: the codes then live in the process and
   they are lost when it restarts. A deployment with several replicas
   cannot: the codes of one replica are unknown to the others.

### The deployment refuses to start: the role of the database bypasses the isolation

**What the operator sees.** The process stops with the message `the role
"<role>" of the database bypasses the isolation of the tenants`. The
deployment never accepts a request.

**Why.** The isolation of the tenants is enforced by the policies of the
five tables, and the policies are only policies for a role that is subject
to them (spec §3.9).

**What to do.**

1. Look at the role of the deployment:
   ```bash
   psql "$HUB_DATABASE_URL" -c "select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user"
   ```
2. Create a role that owns the tables and that is not a superuser (the
   SQL is in §"The role of the database" above).
3. Point `HUB_DATABASE_URL` at that role and roll the deployment.

**What not to do.** Do not add `BYPASSRLS` to the role and start the
service again: the isolation of the tenants would be a promise and not a
rule.

### The deployment of a tenant is wrong

A tenant is registered with the wrong issuer, the wrong client id or the
wrong redirect uri: the logins of that tenant fail and the other tenants
are untouched.

1. Find the tenant:
   ```bash
   curl -sS https://hub.example.com/v1/admin/tenants \
     -H "authorization: Bearer $HUB_ADMIN_TOKEN"
   ```
2. Correct it with the same call (the slug is the key, the call is an
   upsert) — see [api.md](api.md) §`POST /v1/admin/tenants`.
3. The discovery document and the keys of the provider are cached for ten
   minutes: a corrected tenant that still fails is a cache. Wait ten
   minutes or roll the deployment.

**A tenant that names a client id of another tenant is a `409 conflict`**:
the client id of a gateway belongs to one tenant (spec §3.1).

### The signing key of the deployment is missing

**What the operator sees.** The service starts and it warns: `the service
cannot issue a token: it has no signing key`. The logins fail at the
exchange and the JWKS is empty.

**What to do.** Set `HUB_SIGNING_KEY` and `HUB_SIGNING_KID` and roll the
deployment. In production the environment refuses to start without them.

### The deployment of Hub is slow

1. The readiness: `503 not-ready` means the database does not answer.
2. The metrics: `hub_decision_duration_seconds` shows the latency of the
   decisions by tenant; `hub_store_errors_total` shows the failures of the
   stores.
3. The log of the statements: a statement that is slower than 50 ms is a
   warning (`the statement is slow`).
4. The pool: the number of the connections of the database that are used
   by Hub is in `pg_stat_activity`.

---

## The rotation of the secrets

Three secrets are rotated, and they are rotated in different ways.

### The key of the client secrets (`HUB_SECRET_ENCRYPTION_KEY`)

1. Generate the new key: `openssl rand -base64 32`.
2. Re-encrypt the stored secrets, in one transaction:
   ```bash
   HUB_DATABASE_URL=postgres://… \
   HUB_SECRET_ENCRYPTION_KEY=the-old-key \
   HUB_NEW_SECRET_ENCRYPTION_KEY=the-new-key \
   bun run scripts/rotate-secrets.ts
   ```
   The script prints the number of tenants it re-encrypted and never a
   secret. A failure leaves the stored secrets exactly as they were.
3. Change `HUB_SECRET_ENCRYPTION_KEY` in the deployment and roll it.
4. Check that the logins of the tenant still work:
   `scripts/admin-smoke.ts` against the deployment.

### The key of the signing (`HUB_SIGNING_KEY`)

1. Generate the new key:
   `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.
2. Put the **old** key in `HUB_PREVIOUS_SIGNING_KEY` (with its
   `HUB_PREVIOUS_SIGNING_KID`) and the **new** one in `HUB_SIGNING_KEY`.
3. Roll the deployment. The JWKS publishes the two keys: the tokens that
   were signed with the old key are still valid.
4. When the last token signed with the old key has expired (five
   minutes), remove `HUB_PREVIOUS_SIGNING_KEY` and roll again.

### The secret of the state (`HUB_STATE_SECRET`)

The logins that are in flight are lost: the browser has to start a login
again. Change the value and roll the deployment.

### The tokens of the service (`HUB_ADMIN_TOKEN`, `HUB_ACCESS_TOKEN`)

The rotation is a **rolling** change: the value that is in use and the
value it replaced are both accepted, and the value that is replaced is
removed at the end (spec §4.3.1).

1. Put the current value in `HUB_PREVIOUS_ADMIN_TOKEN` and in
   `HUB_PREVIOUS_ACCESS_TOKEN`, and roll the deployment. Nothing changes:
   the two variables are accepted.
2. Change the value of `HUB_ADMIN_TOKEN` and of `HUB_ACCESS_TOKEN`, and
   roll the deployment. **The gateway is configured with the same value
   (spec §12.2): change it on the gateway first.**
3. Remove the two `HUB_PREVIOUS_*` variables, and roll the deployment
   again. The old values are refused from that moment.

The window between the second step and the third is the window of the
rotation. It is the time it takes to change the environment of every
gateway of the deployment, and it is not a window in which a call is
refused.

---

## The backup and the restore

The data of Hub is the five tables. Everything else is derived: the state
of a login lives in the cookie of the browser, the code of a login lives
in the store for sixty seconds, and the tokens are signed. **A backup of
the database is a backup of Hub.** The store of the codes is not backed
up: a code that is lost is a login that has to start again.

### The dump

```bash
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --file "hub-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$HUB_DATABASE_URL"
```

The dump is written outside of the pod, and it is kept where the backups
of the platform are kept.

### The restore

```bash
createdb --owner=hub hub_restore
pg_restore --dbname=hub_restore --no-owner --no-privileges \
  --exit-on-error hub-20260108T100000Z.dump
```

The restore is rehearsed, in an environment that is not the production,
once a quarter and before every change of the process of the backup. The
rehearsal answers three questions:

1. Does the dump restore without an error? (`pg_restore --exit-on-error`)
2. Are the five tables there, with their constraints and their indexes?
   ```sql
   select count(*) from tenants;
   select count(*) from users;
   select count(*) from permissions;
   select count(*) from grants;
   select count(*) from groups;
   select indexname from pg_indexes where tablename = 'grants';
   ```
3. Does the restored database accept the code of the current release? Run
   the service against it with `HUB_ENVIRONMENT=development` and the
   probes: the migrations are applied on a database that is already up to
   date and nothing changes.

| Measurement | Target |
| --- | --- |
| The time of the recovery point | 24 h |
| The time of the recovery | 2 h |
| The rehearsal | Once a quarter, on the environment of the rehearsal |

**The migrations and the backup.** The migrations of Hub are backward
compatible for one release: a rollback of the image does not need a
rollback of the schema. The migration that removes a column is two
releases after the one that stops using it. A dump that is taken before a
migration is restored into a database whose schema is the old one: the
runner applies the migrations that are missing — the bookkeeping of the
migrations is in the database itself (`hub_schema_migrations`).

---

## The capacity

The numbers below are **measured**, not estimated. Every one of them was
produced by a script of the repository, on the environment that is named
under it. A number that is not measured is not published here.

```
HUB_DATABASE_URL=postgres://… bun run scripts/load.ts --requests 20000 --concurrency 100
```

The script measures the **statement of the production**: it calls the
repository of the decisions of the service, with the deadline of the
deployment. The measurement runs on every build of the CI, against the
PostgreSQL of the job, and its numbers are in the log of the build.

### The targets

| Measurement | Target | Shape |
| --- | --- | --- |
| The decision, `p50` | ≤ 3 ms | One principal, a hundred grants. |
| The decision, `p99` | ≤ 20 ms | The same. |
| The decision under load | ≤ 50 ms at `p99` | 500 decisions per second, two replicas. |
| The pool of the database | ≤ 70 % used at the peak | 10 connections per replica. |
| The login, the extra latency of the broker | ≤ 150 ms | The time of Hub around the redirect to the provider and back. |
| The memory of the process | ≤ 200 MB | 1 000 concurrent logins. |
| The decisions per second per replica | ≥ 500 | The shape above. |

### What was measured

**Against a PostgreSQL server.** PostgreSQL 15 over the loopback of a
development machine of sixteen cores, with a load average of nine at the
time of the measurement, five thousand requests, twenty in flight, and a
principal that holds a hundred grants. The numbers are the median of
three runs:

| Measurement | The decision of the platform | The decision of a tenant |
| --- | --- | --- |
| The `p50` | 1.94 ms | 2.82 ms |
| The `p95` | 3.44 ms | 5.08 ms |
| The `p99` | 5.32 ms | 6.88 ms |
| The decisions per second | 9 060 | 6 321 |

The two columns are the two paths of §8.8: the **decision of the
platform** is the bearer token of the deployment, the one of the gateway
of the reference, and the **decision of a tenant** is the credentials of
a tenant, whose scope is a transaction because the scope of a statement
is local to it. The second path costs a transaction and it is a third
slower.

The targets of the table above are met on this machine, on a machine
that was busy. The numbers of a deployment are measured by the same
script, against the server of the deployment, and they are published here
when they are measured.

**On the embedded PostgreSQL of a development machine** (one connection,
so the requests are serialized by it), with 1 000 requests and a principal
that holds a hundred grants:

| Measurement | Value |
| --- | --- |
| The `p50` | 0.45 ms |
| The `p95` | 0.57 ms |
| The `p99` | 0.64 ms |
| The maximum | 0.71 ms |
| The decisions per second | 2 146 |

With twenty requests in flight, the `p50` is 42.7 ms and the `p99` is
48.9 ms, and the throughput does not change: the queue of the single
connection of the embedded database is the limit. This is a property of
the **measurement environment**, not of the query.

The plan of the statement, with a data set of 1 000 principals and
1 000 000 grants, and a principal that holds a thousand of them:

| Measurement | Value |
| --- | --- |
| The plan | `Bitmap Index Scan on grants_user_live`, `Index Cond: (user_id = u.id)` |
| The execution time | 2.0 ms |

The index of the specification is the one the planner chooses: the
decision does not scan the table of the policy.

### What is not measured here

The numbers of a deployment are **not** the numbers of this document: the
embedded database of a development machine is not a PostgreSQL server, and
the process of the runner of the CI is not the hardware of a deployment.The numbers of a deployment are measured by the same script, against the
server of the deployment, and they are published here when they are
measured.

The measurements that are missing — the saturation of the pool, the
memory of the process under a thousand logins and the extra latency of the
broker — need the hardware of a deployment. They are measured during the
cutover of the first tenant ([release.md](release.md) §4).

### The knobs

| Knob | Effect | Limit |
| --- | --- | --- |
| `HUB_DECISION_TIMEOUT_MS` | The ceiling of a decision, and the deadline of the statements of the pool | 2 000 ms |
| `HUB_PREVIOUS_ADMIN_TOKEN` | The token that the current one replaced, during a rotation | — |
| `HUB_PREVIOUS_ACCESS_TOKEN` | The token that the current one replaced, during a rotation | — |
| The size of the pool | The concurrency of the database | 10 per replica |
| The cache of the JWKS of the provider | The calls to the provider of a tenant | 10 minutes |
| The cache of the discovery of the provider | The calls to the discovery of a tenant | 10 minutes |
| The life of the code | The window of a replay | 60 s |
