# Hub — Implementation guide

How the service described in [SPEC.md](SPEC.md) is built, in what order,
and what has to be true before it carries a customer's traffic.

This document is **not** normative. The behavior of the service is in
[SPEC.md](SPEC.md), and a change of behavior is a change of the spec
first. This document is a plan: it moves, it is re-ordered, it grows
tasks. The parts of it that must not move are the rules of §2.

Status: 0.1.0 (plan of the first release). Target: the first tenant in
production.

---

## 1. How to read this document

| | |
| --- | --- |
| **Milestone** | A unit of work with an exit criterion that can be checked by a person other than the author. |
| **Task** | A numbered piece of work (`HUB-###`). A task that is not in this document does not exist. |
| **Exit criterion** | The list of things that are true when the milestone is done. Every criterion is observable: a test that passes, a measurement that was taken, a document that was written. |
| **Spike** | A bounded piece of research whose output is a document, not code. |

A task that turns out to need a decision is not decided in the code. The
decision is written in the spec (§16 of the spec) or in the decisions file
of the Shuttle reference, with the evidence, **before** the behavior it decides
is implemented. The repository has the same rule for the gateway
(`docs/decisions.md`), and it is the reason the two code bases agree
today.

---

## 2. The rules of the work

They are the rules of the gateway (`docs/architecture.md`, "The rules of
the work"), and they are not negotiable for a task of this size.

1. **One rule, one domain, one test file next to it.** A rule that has no
   test is a rule that is not implemented.
2. **The boundaries are checked by the build, not by a review.** The
   architecture checker of the gateway (`scripts/architecture.ts`) is
   copied and extended for Hub in the first milestone.
3. **Shuttle is not modified.** Not for a feature, not for a bug, not for
   a test. The compatibility suite (§8) is the proof, and a failure of it
   is a failure of Hub.
4. **The schema does not reserve anything for a future.** No column that
   is always `null`, no table that is empty, no flag that is never read.
   A feature that needs a fifth table is a feature that has to be paid for
   (spec §13).
5. **The measurements are taken before the code depends on them.** The
   capacity numbers of §10 are measured on the first implementation, not
   estimated in a document.
6. **A failure is a denial.** Everywhere: a database that is down, a
   store that is down, a provider that is slow, a secret that is missing.
   The service never guesses in the direction of allowing.
7. **A decision is written down with its evidence.** The evidence is a
   measurement, a test, or a document of the provider — never an
   intuition.

### 2.1 What this plan does not do

It does not schedule the features of spec §13 (SAML, the console, SCIM,
the directory sync, the linking of the accounts). Those are not in the
backlog of the first release and they are not "phase 2" either: they are
deferred until a named customer pays for them.

---

## 3. The shape of the build

Eight milestones. The order is not arbitrary: every milestone produces
something that can be run, and the last one is the only one that touches
a customer's traffic.

```
 M0  the skeleton          the process starts, the probes answer
 M1  the database          the four tables, the migrations, the secrets at rest
 M2  the administration    the five endpoints, the audit log
 M3  the decisions         the rule of the grants, the contract of the gateway
 M4  the tokens            the signing key, the JWKS, the discovery document
 M5  the login             the broker: the state, the provider, the mapping
 M6  the exchange          the authorization code, the token endpoint
 M7  the compatibility     Shuttle against Hub, unchanged
 M8  the hardening         the capacity, the security, the runbooks, the rollout
```

M1 → M2 → M3 are the "platform" of the service and can be built by two
people at the same time from M1 onwards. M4 → M5 → M6 are a single chain:
they are the protocol, and the protocol is understood by one pair of
eyes. M7 and M8 need everybody.

---

## 4. The milestones

### M0 — The skeleton

**Goal**: a process that starts, validates its environment, answers the
probes and is deployed like the gateway.

| Task | Description | Size |
| --- | --- | --- |
| HUB-001 | The layout of the project: `package.json`, `tsconfig.json`, `biome.json`, the `src/` tree of spec §15. | S |
| HUB-002 | The environment: the schema of `HUB_*`, the defaults, the validation, the refusal to start in production without the required secrets (spec §4). The only place that reads `process.env`. | M |
| HUB-003 | The listener, the request id, the structured logs with the redaction, the lifecycle and the drain (spec §11.3, §11.4). | M |
| HUB-004 | `GET /healthz` and `GET /readyz`. The readiness checks the database and the state of the migrations — the connection is opened in M1, so the probe answers `503` until then. | S |
| HUB-005 | The architecture checker, copied from `scripts/architecture.ts` and extended with the matrix of Hub. | M |
| HUB-006 | The CI workflow: the type check, the lint, the unit tests, the architecture test, the build of the image. | S |
| HUB-007 | The Dockerfile: the image of the gateway as a model, a non-root user, no build tools in the final image, the pinned base image by digest. | S |

**State**: the seven tasks are done. The image is built by the CI workflow
(the runner of the repository does not run a container engine), the
readiness answers `503 not-ready` until the database is connected in M1 and
the metrics endpoint is not part of this milestone: it arrives with the
metrics of the decision (HUB-034).

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| Which variables stop a production deployment? | The nine of spec §4.4, and every problem of the environment is reported at once. The level of the log is the only value that falls back. | spec §4.4, `src/runtime/env.ts` |
| What is the size of a secret? | 32 bytes, counted the way the secret is read: 64 hexadecimal characters or 44 base64 characters. | spec §4.4, `src/runtime/env.ts` |
| Where is the environment read? | In `src/runtime/env.ts` only. The architecture checker refuses `process.env` anywhere else. | `scripts/architecture.ts` |
| What is the deadline of the drain? | Five seconds, and it is not a variable: spec §11.4 fixes it. | `src/runtime/lifecycle.ts` |
| What does the readiness answer while the database is absent? | `503 {"status":"not-ready"}`: the service is honest about what it cannot do. | spec §11.1, `src/app/endpoints.ts` |
| May the four domains of Hub depend on each other? | No. They are independent and they share the four tables, which are read through the platform. | `scripts/architecture.ts` |

**Exit criteria**

- `bun run typecheck`, `bun run lint` and `bun test` pass in the CI.
- The architecture checker fails the build on a forbidden import.
- The image starts with an empty environment and refuses to start in
  production with `{"level":"error","msg":"…"}` on the missing secret.
- `SIGTERM` produces a drain: the readiness answers `503 draining`, the
  process exits within five seconds.
- The image is under 200 MB and runs as a user that is not `root`.

**Demo**: the image is started with a wrong environment, the refusal is
read, the environment is fixed, the probes answer.

---

### M1 — The database

**Goal**: the four tables exist, the migrations are safe, the secrets are
encrypted at rest.

| Task | Description | Size |
| --- | --- | --- |
| HUB-010 | The migration runner: the plain SQL files, the order, the advisory lock, the table of the applied migrations, the refusal to start against a schema it does not understand (spec §3.6). | M |
| HUB-011 | The first migration: the four tables, the constraints, the indexes of spec §3, the `coalesce` of the unique indexes. | M |
| HUB-012 | The client of PostgreSQL: the pool, the timeouts, the statement timeout, the TLS, the reconnection, the disposal at the drain. | M |
| HUB-013 | The encryption of the client secrets at rest: AES-256-GCM under `HUB_SECRET_ENCRYPTION_KEY`, the version of the format in the ciphertext, the rotation (spec §4.3). | M |
| HUB-014 | The repositories of the four tables: one method per rule, no SQL in the application layer. | L |
| HUB-015 | The trace of the queries: the duration of every statement, the number of the rows, a warning above a threshold. | S |

**State**: the six tasks are done and the milestone is closed. The
criteria about the plan of the decision query are checked with the
milestone of the decisions (HUB-031), which writes it.

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| Which database does a development machine run? | The embedded PostgreSQL of the process (`pglite`), by default. It is the same PostgreSQL as the one of a deployment, so the migrations are the same. | spec §3.7, `src/platform/postgres/` |
| When is the database of a deployment a server? | When the environment is a production one. The embedded database lives in one process and the replicas share their tables. | spec §3.7, `src/runtime/env.ts` |
| How does the runner know what the schema is? | A table of the infrastructure, `hub_schema_migrations`, that holds the name of the applied migrations. It is not a table of the domain model. | spec §3.6, `src/platform/postgres/migrations.ts` |
| Which client of PostgreSQL? | `pg` for the server and `pglite` for the embedded one, behind one port. `bun:sql` is not available in the runtime of the release (1.4.3), so the driver of the server is a dependency. | `src/platform/postgres/` |
| Where does the embedded database of a development machine live? | In `./.hub/pglite`, so the tenants and the principals survive the restarts of the process. `pglite://memory://` keeps it in the memory. | spec §3.7, `src/runtime/env.ts` |
| What is the format of the stored secret? | The version (one byte), the nonce (twelve bytes), the body and the tag. The key is derived with HKDF-SHA256, so the secret of the deployment may be of any form. | spec §4.3, `src/platform/postgres/secrets.ts` |
| How is the key of the secrets rotated? | By `scripts/rotate-secrets.ts`: the two columns of every tenant are re-encrypted in one transaction, and the deployment is restarted with the new key. | spec §4.3, `scripts/rotate-secrets.ts` |
| Where do the repositories of the four tables live? | In the platform, one file per table. They are the storage of the rows and they hold no policy: the rules live in the domains that use them. | `src/platform/postgres/` |
| Which statements are traced? | Every one of them: the duration and the number of the rows are written, and a statement that is slower than 50 ms is a warning. The values of a statement are never written. | `src/platform/postgres/trace.ts` |

**Exit criteria**

- The migration applies on an empty database, is idempotent, and two
  runners that start at the same time do not apply it twice.
- A migration that fails leaves the process refusing to start, with the
  name of the migration in the log.
- The client secret of a tenant is not readable in the table: the
  ciphertext is stored, and the round trip through the repository gives
  the clear value back.
- The constraints of the spec are enforced by the database and not only by
  the code: a grant that names a principal of another tenant is refused
  by the foreign key.
- The decision query of the spec §8.3 is written as one statement and its
  plan is checked (`EXPLAIN`) against a data set of a million grants.

**Demo**: the four tables are created, a grant of another tenant is
refused, a secret is written and is not readable.

---

### M2 — The administration

**Goal**: the five endpoints work, with the exact bodies of spec §9, and
every change is audited.

| Task | Description | Size |
| --- | --- | --- |
| HUB-020 | The authentication of the administration: the bearer token, the constant time comparison, the rate limit per address (spec §9.1). | S |
| HUB-021 | The validation of the bodies: the schemas, the error codes, the `400` before the database is touched. | M |
| HUB-022 | `POST /v1/admin/tenants`: the upsert on the slug, the conflicts of the client id and of the default, the encryption of the two secrets, the answer without the secrets. | M |
| HUB-023 | `GET /v1/admin/tenants`: the list with the counts of the principals and of the grants. | S |
| HUB-024 | `POST /v1/admin/users`: the upsert on `(tenant, externalSubject)`, the status, the answer. | M |
| HUB-025 | `PUT /v1/admin/grants`: the upsert, the permission created on demand, the rules of the scope of a permission, the answer. | M |
| HUB-026 | `DELETE /v1/admin/grants/{id}`: the revocation, the idempotence, the `204`. | S |
| HUB-027 | The audit log of the administration: the endpoint, the status, the address, the identifier of the thing that changed. The secrets are never in it. | S |
| HUB-028 | The script of the five calls of spec §9.7, as a smoke test of a deployment. | S |

**State**: the nine tasks are done and the milestone is closed.

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| Where does the rate limit of the administration live? | In the domain, with the window of the process: the replicas of a deployment have one window each. | `src/domains/administration/limiter.ts` |
| Is an address that used up its budget refused even with the right token? | Yes. A caller that hammers the endpoint is refused whatever it presents. | `src/domains/administration/service.ts` |
| What is the body of a refusal? | `{"error": <code>, "message": <text>}` with the codes of the specification: `unauthorized`, `invalid_request`, `not_found`, `conflict`, `forbidden`, `too_many_requests`. | `src/app/administration.ts` |
| What is the size of a body? | 64 KiB. A body that is larger is a `413`. | `src/app/administration.ts` |
| Where does the audit live? | The domain names what changed and the thing that changed; the application writes the line of the call with the endpoint, the status and the address. | `src/domains/administration/service.ts`, `src/app/administration.ts` |
| How are the repositories adapted to the ports of the domain? | In the composition root: the rows are translated and the failures of the driver become the failures of the domain. | `src/runtime/adapters.ts` |

**Exit criteria**

- The five endpoints answer exactly the bodies of the spec, and the
  contract tests assert them.
- The five calls of the spec §9.7 run against a deployment and leave the
  expected state in the database.
- A wrong token is `401` and is counted; a burst of wrong tokens is
  `429`.
- A secret that was sent is not in the answer, not in the log and not in
  the table in clear.
- The audit log of a change names the thing that changed.

**Demo**: the five calls, the answers, the audit log, the absence of the
secret in the table.

---

### M3 — The decisions

**Goal**: the contract of the gateway, implemented exactly.

| Task | Description | Size |
| --- | --- | --- |
| HUB-030 | `POST /v1/decisions`: the body, the bearer token, the `400`, the `401`, the `503` (spec §8.1). | S |
| HUB-031 | The rule of the decision (spec §8.3): the principal, the tenant, the grant, the expiry, the permission, the workspace, the route. One statement. | M |
| HUB-032 | The reasons (spec §8.7) and their mapping on the metric of the gateway: the word *role* in the two reasons that are a missing role. | S |
| HUB-033 | The timeout of the decision: `HUB_DECISION_TIMEOUT_MS`, the cancellation of the query, the denial on the timeout. | M |
| HUB-034 | The metrics of the decision: the counter, the histogram, the bounded label of the tenant (spec §11.2). | S |
| HUB-035 | The log of the decision: the subject, the workspace, the route, the answer, the reason, the duration. | S |
| HUB-036 | The endpoint of the metrics: the `404` without a token, the `401` with a wrong one, the Prometheus text (spec §5.1, §11.2). | S |

**State**: the seven tasks are done and the milestone is closed.

**The evidence of the milestone**

| Measurement | Result |
| --- | --- |
| The plan of the statement of the decision, with a million grants and a principal that holds a thousand of them | `Bitmap Index Scan on grants_user_live`, `Index Cond: (user_id = u.id)`, 2.0 ms of execution time (`scripts/explain-decision.ts`). |
| A database that is down | The decision is a `503` and the gateway denies the request. |
| A decision that does not answer in time | The decision is a `503`, never an allowance. |

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| How is the rule of the decision read? | One statement that returns the facts of the rule (the principal, the tenant, a live grant, an expired grant) and a domain that turns the facts into the answer and the reason. | `src/platform/postgres/decisions.ts`, `src/domains/authorization/decision.ts` |
| What is the reason of a grant that has expired? | `the role of the workspace has expired`: it carries the word *role*, so the gateway counts it as `missing_role`. | `src/domains/authorization/decision.ts` |
| What happens when the decision does not answer in time? | A `503`. The gateway fails closed on anything that is not a successful answer. | `src/platform/postgres/decisions.ts` |
| How is the token of the gateway compared? | In constant time, with the digests of the two values: the length of the token is not leaked by the time of the answer. | `src/observability/secrets.ts` |
| Where are the metrics of the decision counted? | In the observation layer, with a bounded label of the tenant: a hundred tenants and then `overflow`. | `src/observability/metrics.ts` |

**Exit criteria**

- The contract suite of the gateway is run against Hub for the decisions
  alone: the suite asks the access service directly for the decisions of
  its fixtures, and Hub answers them. The proof that involves the login
  comes after M4 and is the compatibility suite of M7.
- A decision whose database is down is a `503`, and the gateway refuses
  the request (`403 workspace_forbidden`), never a `500`.
- The `EXPLAIN` of the query of a principal with a thousand grants uses
  the index of `grants (user_id) where revoked_at is null`.

**Demo**: the decisions of a principal with a grant, without a grant, of
a disabled principal, of an unknown subject, and of a database that is
down.

---

### M4 — The tokens

**Goal**: Hub is an OpenID Connect provider that the gateway accepts.

| Task | Description | Size |
| --- | --- | --- |
| HUB-040 | The signing key: the loading of the PEM, the `kid`, the publication in the JWKS, the rotation with the overlap (spec §4.2). | M |
| HUB-041 | The JWKS and the discovery document (spec §7.5), with the fields the gateway reads and the ones it refuses to work without. | M |
| HUB-042 | The issuance of the id token and of the access token (spec §7.1, §7.2): the claims, the life, the `nonce`, the `roles`. | M |
| HUB-043 | The `roles` claim (spec §7.3): the live grants, the sort, the cap of 64, the count of the rest in the log. | M |
| HUB-044 | The userinfo endpoint. | S |
| HUB-045 | The fixture of a provider that signs with the wrong key, the wrong issuer, the wrong audience and a wrong nonce, for the tests of M5. | M |

**State**: the six tasks are done and the milestone is closed. HUB-045 is
the fixture of the broken provider: it is built with the milestone of the
login, which is the one that uses it.

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| How is the rotation of the signing key done? | The previous key stays in the environment (`HUB_PREVIOUS_SIGNING_KEY`) and stays published in the JWKS; the tokens are signed with the current one. | spec §4.2, `src/domains/provider/keys.ts` |
| Where do the claims of the userinfo come from? | From the principal row and from its live grants, not from the token: the userinfo is read at the moment of the call. | `src/domains/provider/service.ts` |
| What does a deployment without a signing key do? | It starts and it says so: it cannot issue a token. The key is required in production (§4.4). | `src/runtime/composition.ts` |

**Exit criteria**

- The gateway, configured with the issuer of Hub, discovers Hub, reads
  its JWKS and accepts a token that Hub signed.
- A token that is signed with another key, that carries another issuer,
  another audience or an expired moment is refused by the gateway.
- The `roles` claim of the token is the list of the live grants of the
  principal, and it is empty when there is no grant.

**Demo**: the gateway accepts a token of Hub; the four broken tokens are
refused.

---

### M5 — The login

**Goal**: the broker. A browser logs in at the provider of a tenant and
comes back with a principal.

| Task | Description | Size |
| --- | --- | --- |
| HUB-050 | The resolution of the tenant (spec §5.2): the client, the parameter, the hint, the default; the `400` and the `403`. | M |
| HUB-051 | The state cookie (spec §5.3): the encrypted state, the attributes, the single use, the ten minutes. | M |
| HUB-052 | The client of the provider of a tenant: the discovery, the authorization url, the exchange, the JWKS, the cache of ten minutes, the timeout. | L |
| HUB-053 | The validation of the token of a provider (spec §6.1), with the four fixtures of HUB-045. | M |
| HUB-054 | The mapping (spec §6.2): the lookup by `(tenant, subject)`, the creation by the auto-provisioning, the refusal of an unknown identity. | M |
| HUB-055 | The refusal pages of the login (spec §5.6): the provider unreachable, the token refused, the identity unknown, the principal disabled, the state invalid. | M |
| HUB-056 | The multi-tenant fixture: two providers with two issuers, two tenants, two principals. The fixture of the Shuttle reference (`services/oidc-provider.ts`) is reused with a second issuer. | M |

**State**: the seven tasks are done. The multi-tenant fixture is the one of
the refusals and of the login: two providers, two issuers and two tenants
are exercised by the same fixture with two issuers.

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| How is the state of the provider bound to the state cookie? | The state of the provider is derived from the fields of the cookie and from the secret of the deployment: it is bound to the cookie without being carried by it. | `src/domains/identity/service.ts` |
| What does the state cookie carry? | The tenant, the client id, the redirect uri, the state of the gateway, the nonce, the verifier of the PKCE of the provider, the challenge of the PKCE of the gateway and the moment the login started. | `src/domains/identity/state.ts` |
| Which provider does Hub talk to? | The one of the tenant, with the client id and the secret of the tenant. The url of the callback is the one of the registration of the tenant. | `src/runtime/composition.ts` |
| Where does the client of the provider of a tenant live? | In the identity domain: it is the client of the provider of a tenant, not the provider of Hub. | `src/domains/identity/provider-client.ts` |
| What does a provider that cannot be reached answer? | `502 upstream_unavailable`: the reason of the failure of the network never reaches the caller. | `src/domains/identity/provider-client.ts` |

**Exit criteria**

- A browser logs in at the provider of the tenant and reaches the
  callback of the gateway with a code.
- The four broken tokens of HUB-045 are refused with the right reason and
  the right page.
- An identity that is not registered is refused with `403 identity_unknown`
  when the tenant does not auto-provision, and is created with **no
  grant** when it does.
- A login that is replayed — the same state cookie, a second time — is
  refused.
- The state cookie carries nothing readable and nothing durable.

**Demo**: the login of the two tenants, the four refusals, the replay.

---

### M6 — The exchange

**Goal**: the gateway turns the code into a token.

| Task | Description | Size |
| --- | --- | --- |
| HUB-060 | The authorization code: the opaque value, the hash, the store, the sixty seconds, the single use (spec §5.5). | M |
| HUB-061 | The token endpoint: the client authentication (`client_secret_basic`), the code, the redirect uri, the PKCE verifier against the challenge, the `invalid_grant`. | M |
| HUB-062 | The answer of the token endpoint: the `id_token`, the `access_token`, the `expires_in`, the `token_type`. | M |
| HUB-063 | The store of the codes: Redis, the failure of the store is an error and never a silent allowance. | M |

**State**: the four tasks are done and the milestone is closed.

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| Where does the code live? | In the shared store, under a hash of itself: the store never holds a code that a reader could redeem. | `src/domains/provider/code.ts` |
| How is the code single use? | The read and the delete are one operation (`GETDEL` in Redis): a code that is redeemed twice finds nothing. | `src/platform/redis/store.ts` |
| How is the client of the token endpoint authenticated? | With `client_secret_basic` and a comparison in constant time; a client without a secret is refused. | `src/app/oauth.ts` |
| What does the exchange refuse? | A code that is unknown, a code of another client, a code of another redirect uri and a verifier that does not match the challenge: `invalid_grant` in the four cases. | `src/domains/provider/exchange.ts` |

**Exit criteria**

- The gateway exchanges the code and receives a token it accepts.
- The same code exchanged twice is `invalid_grant`.
- A code exchanged with another redirect uri, another client or another
  verifier is `invalid_grant`.
- A store that is down fails the exchange, and the login does not
  succeed without the state.

**Demo**: the exchange, the replay, the three mismatches.

---

### M7 — The compatibility

**Goal**: the claim of spec §12 is proven, not asserted.

| Task | Description | Size |
| --- | --- | --- |
| HUB-070 | The compatibility suite: the gateway, unchanged, with its own configuration, against Hub. The five assertions of spec §14.1. | L |
| HUB-071 | The comparison in shadow: a tool that asks Hub and the fixture of the access service the same decision and reports the differences. It is run before the cutover. | M |
| HUB-072 | The runbook of the cutover (§12 of this guide). | M |

**State**: the three tasks are done and the milestone is closed.

**The evidence of the milestone**

| Assertion of the specification | Result |
| --- | --- |
| §14.1 (1) A browser logs in at the provider of the tenant and comes back with a session | The gateway, unchanged, opens the browser at Hub, Hub brokers the login at the provider of the tenant and the gateway gets its session. |
| §14.1 (2) The gateway writes `x-shuttle-user`, `x-shuttle-email` and `x-shuttle-roles` | The upstream of the test receives the three headers with the values of the principal. |
| §14.1 (3) A request with a grant is forwarded, a request without one is `403 workspace_forbidden` | The decision of Hub denies the principal that has no grant and the gateway fails closed. |
| §14.1 (4) A grant that is revoked is refused within the TTL of the cache | The cache of the gateway is at zero in the test: the revocation is immediate. |
| §14.1 (5) The metrics of the gateway count the denial as `missing_role` | The reason of Hub carries the word *role* and the gateway counts it as `missing_role`. |

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| How is the gateway run against Hub? | As a process of the reference, with its own configuration: the tree of the reference is read-only and it is never modified. The CI checks that the tree is the one of `shuttle.ref`. | `test/compatibility/gateway.test.ts`, `.github/workflows/ci.yml` |
| How is the principal that has no grant tested? | The fixture of the provider authenticates the callers as another subject: the fixture is the only thing that changes. | `test/fixtures/provider.ts` |

**Exit criteria**

- The contract suite of the gateway passes with Hub in place of the two
  fixtures, **without a change in the gateway**. The diff of the
  repository over the milestone is empty on `src/`, `test/`, `config/`
  and `services/`.
- The revocation of a grant is observed by the gateway within
  `SHUTTLE_ACCESS_CACHE_TTL_MS`.
- The shadow tool reports no difference on a day of traffic.

**Demo**: the suite, the empty diff, the shadow report.

---

### M8 — The hardening

**Goal**: the service can carry a customer.

| Task | Description | Size |
| --- | --- | --- |
| HUB-080 | The capacity: the measurement of the decision and of the login, the pool, the limits of the process (spec §10 of this guide). | L |
| HUB-081 | The security review: the enumeration of the ids, the timing of the answers, the injection of SQL, the SSRF of the `idp_issuer`, the redirect of the provider, the XSS of the refusal pages, the secrets in the logs. | L |
| HUB-082 | The runbooks: the provider that is down, the database that is down, the store that is down, the secret that is rotated, the bad deployment of a tenant. | M |
| HUB-083 | The alerts: the rate of the denials, the latency of the decision, the failures of the login, the saturation of the pool, the age of the migrations. | M |
| HUB-084 | The backup and the restore: the dump, the restore, the rehearsal, the target of the recovery time. | M |
| HUB-085 | The delivery: the image by digest, the scan, the SBOM, the promotion between the environments, the rollback of the image. | M |
| HUB-086 | The documentation of the operator: the README of Hub, the `.env.example`, the page of the deployment. | S |

**State**: the seven tasks are done and the milestone is closed.

**The decisions of the milestone**

| Question | Decision | Where |
| --- | --- | --- |
| Where are the numbers of the capacity published? | In `docs/capacity.md`, with the environment of the measurement. The numbers of a deployment are measured by the same script against the server of the deployment. | `scripts/load.ts`, `docs/capacity.md` |
| How is the address of a provider of a tenant checked? | Before the call: the host is resolved and every address it resolves to has to be a public one. A production deployment refuses the private addresses; a development machine accepts them. | `src/platform/bun/address.ts` |
| What does an alert do? | Nothing by itself: it is read by a person, and the person follows a runbook. | `docs/alerts.md` |
| What is backed up? | The database. The store of the codes is not backed up: a code that is lost is a login that starts again. | `docs/backup.md` |

**Exit criteria**

- The checklist of §11 is checked, item by item, by a person who did not
  write the service.
- The load test reaches the targets of §10 on the shape of the
  production hardware, and the resources settle after the traffic.
- The restore of the database is rehearsed and the time is measured.
- The security review has no open finding of a severity above "low".

**Demo**: the load test, the rehearsal of the restore, the review.

---

## 5. The tasks, in one table

| Id | Milestone | Task | Size | Depends on |
| --- | --- | --- | --- | --- |
| HUB-001 | M0 | The layout of the project | S | — |
| HUB-002 | M0 | The environment and its validation | M | HUB-001 |
| HUB-003 | M0 | The listener, the logs, the drain | M | HUB-001 |
| HUB-004 | M0 | The probes | S | HUB-003 |
| HUB-005 | M0 | The architecture checker | M | HUB-001 |
| HUB-006 | M0 | The CI workflow | S | HUB-002, HUB-005 |
| HUB-007 | M0 | The image | S | HUB-003 |
| HUB-010 | M1 | The migration runner | M | HUB-001 |
| HUB-011 | M1 | The migration of the four tables | M | HUB-010 |
| HUB-012 | M1 | The client of PostgreSQL | M | HUB-002 |
| HUB-013 | M1 | The encryption of the secrets at rest | M | HUB-002 |
| HUB-014 | M1 | The repositories | L | HUB-011, HUB-012 |
| HUB-015 | M1 | The trace of the queries | S | HUB-014 |
| HUB-020 | M2 | The authentication of the administration | S | HUB-003 |
| HUB-021 | M2 | The validation of the bodies | M | HUB-020 |
| HUB-022 | M2 | `POST /v1/admin/tenants` | M | HUB-014, HUB-021 |
| HUB-023 | M2 | `GET /v1/admin/tenants` | S | HUB-014 |
| HUB-024 | M2 | `POST /v1/admin/users` | M | HUB-014, HUB-021 |
| HUB-025 | M2 | `PUT /v1/admin/grants` | M | HUB-014, HUB-021 |
| HUB-026 | M2 | `DELETE /v1/admin/grants/{id}` | S | HUB-014 |
| HUB-027 | M2 | The audit log | S | HUB-020 |
| HUB-028 | M2 | The script of the five calls | S | HUB-026 |
| HUB-030 | M3 | `POST /v1/decisions` | S | HUB-014 |
| HUB-031 | M3 | The rule of the decision | M | HUB-030 |
| HUB-032 | M3 | The reasons | S | HUB-031 |
| HUB-033 | M3 | The timeout of the decision | M | HUB-031 |
| HUB-034 | M3 | The metrics of the decision | S | HUB-031 |
| HUB-035 | M3 | The log of the decision | S | HUB-031 |
| HUB-036 | M3 | The endpoint of the metrics | S | HUB-034 |
| HUB-040 | M4 | The signing key | M | HUB-002 |
| HUB-041 | M4 | The JWKS and the discovery | M | HUB-040 |
| HUB-042 | M4 | The issuance of the tokens | M | HUB-040, HUB-054 |
| HUB-043 | M4 | The `roles` claim | M | HUB-014, HUB-042 |
| HUB-044 | M4 | The userinfo endpoint | S | HUB-042 |
| HUB-045 | M4 | The fixtures of the broken provider | M | HUB-040 |
| HUB-050 | M5 | The resolution of the tenant | M | HUB-014 |
| HUB-051 | M5 | The state cookie | M | HUB-002 |
| HUB-052 | M5 | The client of the provider | L | HUB-040 |
| HUB-053 | M5 | The validation of the token of a provider | M | HUB-045, HUB-052 |
| HUB-054 | M5 | The mapping of the identity | M | HUB-014, HUB-053 |
| HUB-055 | M5 | The refusal pages | M | HUB-054 |
| HUB-056 | M5 | The multi-tenant fixture | M | HUB-052 |
| HUB-060 | M6 | The authorization code | M | HUB-051, HUB-054 |
| HUB-061 | M6 | The token endpoint | M | HUB-060, HUB-042 |
| HUB-062 | M6 | The answer of the token endpoint | M | HUB-061 |
| HUB-063 | M6 | The store of the codes | M | HUB-060 |
| HUB-070 | M7 | The compatibility suite | L | HUB-063 |
| HUB-071 | M7 | The shadow comparison | M | HUB-070 |
| HUB-072 | M7 | The runbook of the cutover | M | HUB-070 |
| HUB-080 | M8 | The capacity | L | HUB-070 |
| HUB-081 | M8 | The security review | L | HUB-070 |
| HUB-082 | M8 | The runbooks | M | HUB-070 |
| HUB-083 | M8 | The alerts | M | HUB-080 |
| HUB-084 | M8 | The backup and the restore | M | HUB-012 |
| HUB-085 | M8 | The delivery | M | HUB-007 |
| HUB-086 | M8 | The documentation of the operator | S | HUB-080 |

A task of size `L` that is not started within a week is split, not
carried.

---

## 6. The tests

### 6.1 The kinds

| Kind | Where | What it proves |
| --- | --- | --- |
| Unit | `src/domains/*/*.test.ts` | The policy of one domain, without the network and without the database. |
| Contract | `test/contract/` | The endpoints of Hub over a socket, with the fixtures around it. |
| Integration | `test/integration/` | The decisions against a real PostgreSQL, the codes against a real Redis, two replicas. |
| Compatibility | `test/compatibility/` | **The gateway, unchanged, against Hub.** |
| Architecture | `test/architecture/` | The import boundaries of Hub. |
| Load | `test/load/` | The soak and the resources that settle after the traffic. |

### 6.2 The map of the spec to the tests

Every numbered rule of the spec has a test. The table is the checklist of
the coverage, and it is reviewed at the end of every milestone.

| Spec | Rule | Test |
| --- | --- | --- |
| §2.1 (1) | The provider of a tenant is the only one that is trusted | `identity/token-validation.test.ts`, the four broken fixtures |
| §2.1 (2) | The mapping is never by e-mail | `identity/mapping.test.ts` |
| §2.1 (3) | A principal without a grant is refused | `authorization/decision.test.ts` |
| §2.1 (4) | A failure is a denial | `contract/decisions.test.ts` |
| §2.1 (5) | Five endpoints, no other way | `contract/administration.test.ts` |
| §2.1 (6) | No secret is returned or logged | `contract/administration.test.ts`, `observability.test.ts` |
| §2.1 (7) | The reason never reaches a caller | `compatibility/gateway.test.ts` |
| §2.1 (8) | The contract of the gateway does not change | `compatibility/gateway.test.ts` |
| §14.1 | The five assertions of the compatibility | `compatibility/gateway.test.ts` |
| §3.1–3.4 | The constraints of the four tables | `integration/schema.test.ts` |
| §3.6 | The migrations and the schema of the database | `integration/schema.test.ts` |
| §3.7 | The database of a development machine | `runtime/env.test.ts`, `integration/schema.test.ts` |
| §3.1–3.4 | The storage of the four tables | `integration/tenants.test.ts`, `integration/users.test.ts`, `integration/permissions.test.ts`, `integration/grants.test.ts` |
| §4 | The environment is validated as a whole | `runtime/env.test.ts` |
| §11.1 | The probes | `contract/probes.test.ts` |
| §11.3 | No secret reaches a log line | `observability/logging.test.ts` |
| §11.4 | The drain | `runtime/lifecycle.test.ts`, `contract/lifecycle.test.ts` |
| §15 | The import boundaries of Hub | `architecture/imports.test.ts` |
| §4.3 | The secrets are encrypted at rest | `postgres/secrets.test.ts`, `integration/rotation.test.ts` |
| §5.2 | The resolution of the tenant | `identity/tenant.test.ts` |
| §5.2 | The resolution of the tenant | `identity/identity.test.ts` |
| §5.3 | The state of a login is encrypted and single use | `identity/identity.test.ts`, `contract/login.test.ts` |
| §5.5 | The code is single use and bound | `contract/login.test.ts` |
| §5.6 | The refusals of the login | `contract/refusals.test.ts` |
| §6.1 | The validation of the token of un provider | `identity/identity.test.ts`, `contract/refusals.test.ts` |
| §6.1 | The validation of the token of a provider | `identity/token-validation.test.ts` |
| §6.4 | The auto-provisioning creates a principal without a grant | `identity/identity.test.ts`, `contract/refusals.test.ts` |
| §7.1, §7.3 | The claims of the token | `provider/provider.test.ts` |
| §7.5 | The discovery document, the JWKS and the userinfo | `provider/provider.test.ts`, `contract/provider.test.ts` |
| §8.1–8.3 | The contract and the rule of the decision | `contract/decisions.test.ts`, `authorization/decision.test.ts`, `app/decisions.test.ts` |
| §8.5 | The index of the decision | `scripts/explain-decision.ts` |
| §8.7 | The reasons and the metric of the gateway | `authorization/decision.test.ts` |
| §11.2 | The metrics of the decision | `observability/metrics.test.ts`, `contract/decisions.test.ts` |
| §8.4 | The roles are context | `authorization/decision.test.ts` |
| §8.6 | The latency of a revocation | `compatibility/gateway.test.ts` |
| §8.7 | The reasons and the metric of the gateway | `compatibility/gateway.test.ts` |
| §9.2–9.6 | The five endpoints | `contract/administration.test.ts`, `administration/service.test.ts` |
| §9.1 | The authentication, the limiter and the audit | `administration/service.test.ts`, `contract/administration.test.ts` |
| §9.7 | The five calls of the session | `contract/smoke.test.ts` |
| §11.2 | The bounded labels | `observability.test.ts` |
| §13 | The deferred features are absent | `architecture/no-scaffolding.test.ts` |
| §11.1 | The probes of the deployment | `contract/probes.test.ts` |
| §11.2 | The security review | `docs/security.md` |

The last row deserves a word: a test asserts that the code contains no
SAML, no console, no SCIM and no directory sync — not because the
features are bad, but because a half-built feature in a service that
carries a customer is a liability. The test fails the build when a
dependency or a route of a deferred feature appears.

### 6.3 The fixtures

The Shuttle reference has deterministic fixtures for the identity provider
and the access service (`services/oidc-provider.ts`,
`services/access-fixture.ts`). Hub reuses them, as a dependency of the
reference, without forking them:

- The provider of a tenant is the fixture `oidc-provider`, started twice
  with two issuers, so the multi-tenancy is exercised by two real
  providers and not by a mock.
- The broken fixtures of HUB-045 are the same fixture with a key, an
  issuer, an audience and a nonce that do not match.
- The access service of the gateway is replaced by Hub itself in the
  compatibility suite.

The fixtures refuse to run in production, exactly like the ones of the
gateway (`services/fixture-guard.ts`).

### 6.4 The CI

| Job | What it runs |
| --- | --- |
| `check` | `tsc --noEmit`, `biome lint`, `biome format --check`. |
| `unit` | `bun test src`. |
| `contract` | `bun test test/contract`. |
| `architecture` | `bun test test/architecture` and the checker. |
| `compatibility` | `bun test test/compatibility` — the gateway and Hub. |
| `integration` | `bun test test/integration` — on the embedded PostgreSQL by default, on the PostgreSQL of the workflow when `HUB_TEST_DATABASE_URL` names one. |
| `image` | The build of the image, the scan, the SBOM. |

The `compatibility` job is the one that may never be skipped: a red
compatibility job is a red build, whatever the rest says.

---

## 7. The design decisions that are still open

They are in spec §17. They are listed here with the milestone that has to
settle them, because a decision that is not settled blocks a task.

| Question | Settled in | The default meanwhile |
| --- | --- | --- |
| The shared client | M5 (HUB-050) | It is refused. A login is resolved by the client id only. |
| The list of the `roles` claim | M4 (HUB-043) | The keys of every live grant, sorted, capped at 64. |
| A scope on the path of the request | M3 (HUB-031) | There is none. A grant is a workspace and a route. |
| The expiry of a grant | M1 (HUB-011) | The column exists and is read by the rule. |

A question that is settled during a milestone is written in the spec
first, with the evidence, and the spec is changed in the same commit as
the code.

---

## 8. The compatibility with Shuttle

The hardest part of this build is not the protocol. It is that the
gateway cannot change.

### 8.1 The rules of the exercise

1. The gateway is used as it is in the Shuttle reference, at the commit
   pinned by `shuttle.ref`: its configuration, its fixtures, its contract
   suite.
2. The two fixtures are replaced by Hub: the provider of the identity by
   Hub, the access service by Hub.
3. The configuration of the gateway is the one of spec §12.1, with the
   issuer, the client id, the client secret and the access token of the
   tenant.
4. **No commit on the gateway.** The reference is a separate repository
   and is never modified: the check is a diff of its tree, in the CI,
   that fails the build when it is not empty.

### 8.2 The five assertions

| # | Assertion |
| --- | --- |
| 1 | A browser logs in at the provider of the tenant and comes back with a session. |
| 2 | The gateway writes `x-shuttle-user`, `x-shuttle-email` and `x-shuttle-roles` with the values of the principal. |
| 3 | A request with a grant is forwarded; a request without one is `403 workspace_forbidden`. |
| 4 | A grant that is revoked is refused within `SHUTTLE_ACCESS_CACHE_TTL_MS`. |
| 5 | The metrics of the gateway count the denial as `missing_role`. |

The fifth one is the assertion that ties Hub to the vocabulary of the
gateway: the reason of Hub has to name the *role* for the metric to be
right (spec §8.7). It is the reason the reasons are specified and not
left to the implementation.

### 8.3 The shadow period

Before the cutover, Hub answers the decisions in parallel with the
access service that is in production, and a tool compares the two
answers on the same requests.

The tool reports, per subject and per workspace, the answers that
differ. The expected difference is one: the decisions of the old service
are the ones that are hard-coded in the fixture, and they are replaced by
the grants. Every other difference is a bug of Hub, and the shadow
period does not end before it is empty.

The shadow tool reads the decisions of the old service and asks Hub; it
never writes in Hub.

---

## 9. The delivery

| Stage | What happens |
| --- | --- |
| The commit | The branch is merged when the CI is green, the exit criteria of the milestone are checked, and the spec is changed if the milestone changed a rule. |
| The review | One reviewer other than the author. The checklist of §9.1 is in the description of the pull request. |
| The image | The image is built once, tagged with the commit and pushed with its digest. The digest is what is deployed. |
| The promotion | The same digest goes from the development environment to the staging one and from the staging one to the production one. Nothing is rebuilt in between. |
| The deployment | A rolling replacement of the replicas, with the readiness probe as the gate. The drain of a replica takes the logins in flight with it. |
| The rollback | The previous digest is deployed again. The service is stateless except for the database, and the migrations are backward compatible for one release: a rollback of the image does not need a rollback of the schema. |

### 9.1 The checklist of the review

- [ ] The task is in the table of §5, or the table was changed in the
      same pull request.
- [ ] A rule that was implemented has a test, and the test is next to it.
- [ ] The boundaries are respected; the architecture checker passes.
- [ ] The spec is changed when the behavior changed, and the change is
      in the same commit.
- [ ] No secret, token or cookie reaches a log line.
- [ ] No error message of the provider, of the database or of the runtime
      reaches a caller.
- [ ] No column, no table and no flag was added for a future.
- [ ] The exit criteria of the milestone are checked, not the intentions.

---

## 10. The capacity

The targets are measured on the first implementation and published here.
The gateway has a similar document (`docs/capacity.md`); the numbers of
Hub are smaller, but the latency of a decision is on the path of every
request of the gateway, and it is not.

### 10.1 The targets

| Measurement | Target | Shape |
| --- | --- | --- |
| The decision, `p50` | ≤ 3 ms | One principal, a hundred grants. |
| The decision, `p99` | ≤ 20 ms | The same. |
| The decision under load | ≤ 50 ms at `p99` | 500 decisions per second, two replicas. |
| The pool of the database | ≤ 70 % used at the peak | 10 connections per replica. |
| The login, the extra latency of the broker | ≤ 150 ms | The time of Hub around the redirect to the provider and back. |
| The memory of the process | ≤ 200 MB | 1 000 concurrent logins. |
| The decisions per second per replica | ≥ 500 | The shape above. |

### 10.2 The knobs

| Knob | Effect | Limit |
| --- | --- | --- |
| `HUB_DECISION_TIMEOUT_MS` | The ceiling of a decision | 2 000 ms |
| The size of the pool | The concurrency of the database | 10 per replica |
| The cache of the JWKS | The calls to the provider of a tenant | 10 minutes |
| The cache of the discovery | The calls to the discovery of a tenant | 10 minutes |
| The life of the code | The window of a replay | 60 s |

### 10.3 The measurements that are taken

- The latency of the decision, per percentile, with the shape of §10.1.
- The time of the queries of the database, with the plan of the decision
  query.
- The time of the calls to the provider of a tenant, per tenant.
- The memory and the handles of the process, before and after the soak.
- The effect of the revocation on the latency of the gateway, measured
  with the TTL of the cache of the gateway at 0 and at 5 seconds.

The numbers are published in `docs/capacity.md`, like the ones of the
gateway. A number that is not measured is not published.

---

## 11. The checklist of production readiness

It is checked, item by item, by a person who did not write the service.
Every item is answered with a fact: a test, a measurement, a document, a
ticket. "It should be fine" is not an answer.

### 11.1 The correctness

- [ ] Every rule of the spec has a test (§6.2).
- [ ] The compatibility suite passes and the diff of the gateway is empty.
- [ ] The migration applies on an empty database and on a database of the
      previous release.
- [ ] A failure of every dependency is a denial, and it was tested with
      the dependency really down.
- [ ] The reason of a denial reaches neither the caller nor a log line
      that a caller can read.

### 11.2 The security

- [ ] The tokens of the administration and of the decisions are compared in
      constant time.
- [ ] The client secrets are encrypted at rest and are never returned,
      never logged.
- [ ] The issuer of a tenant is an https url; a tenant that is not https
      is refused unless the environment says otherwise.
- [ ] The `idp_issuer` of a tenant cannot reach an internal address: the
      discovery and the JWKS are the only outbound calls, and the address
      is checked before the call (the SSRF of the tenant registration).
- [ ] The refusal pages escape what they show.
- [ ] The state of the login is encrypted, is single use and expires.
- [ ] The authorization code is single use and is bound to the client, to
      the redirect uri and to the challenge.
- [ ] The password of the database is not in the image and is rotated
      with the deployment.
- [ ] The image runs as a non-root user, has no shell and is scanned.
- [ ] The security review of HUB-081 has no open finding above "low".

### 11.3 The data

- [ ] The four tables are the only domain tables, and the schema of the
      production is the schema of the migrations.
- [ ] The backup is automatic, the restore is rehearsed, and the time of
      the recovery is written down.
- [ ] The migration that removes a column is two releases after the one
      that stops using it.
- [ ] The audit log of the administration is shipped somewhere that is not
      the database of the service.

### 11.4 The availability

- [ ] The service is stateless: two replicas, one image, one digest.
- [ ] The drain of a replica does not break a login in flight.
- [ ] The store of the codes is a shared one, or the deployment is a
      single node that says so.
- [ ] The provider of a tenant that is down degrades the tenant, not the
      service: the other tenants keep working.
- [ ] The alerts of HUB-083 are wired to a channel somebody reads.
- [ ] The runbooks of HUB-082 exist and were walked through once.

### 11.5 The observability

- [ ] The logs are structured, carry the request id and redact the
      secrets.
- [ ] The metrics of §11.2 of the spec are exposed, with the bounded
      labels.
- [ ] A dashboard shows the rate of the decisions, the latency, the rate
      of the refusals of the login and the failures by dependency.
- [ ] The log of a decision can be found from the request id of the
      gateway, through the subject and the workspace.

### 11.6 The delivery

- [ ] The image is built once and promoted by digest.
- [ ] The CI runs the type check, the lint, the tests, the architecture
      test, the compatibility test and the scan.
- [ ] The rollback of the image is rehearsed.
- [ ] The version of the service is in the answer of `/healthz` and in
      the log of the start.

---

## 12. The rollout

| Phase | What is true | What is done | How it goes back |
| --- | --- | --- | --- |
| 0 — Dark | Hub runs, nobody calls it. | The deployment, the probes, the metrics, the alerts. | Stop the deployment. |
| 1 — Shadow | Hub answers the decisions in parallel with the service in production. | The comparison of §8.3, every day. | Stop the shadow. |
| 2 — The first tenant, in staging | A whole tenant lives on Hub. | The tenant is created, the principals are created, the grants are created, the gateway of the tenant is switched. | The gateway of the tenant goes back to the old access service. The data of Hub stays. |
| 3 — The first tenant, in production | The same, with real traffic. | A week of monitoring, then the second tenant. | The same. |
| 4 — The last tenant | The old access service is empty. | It is decommissioned. | The data is kept for the retention of the audit. |

The switch of a tenant is one change of the configuration of its gateway:
the issuer, the client id, the client secret and the access url. The
browser is redirected to Hub, the sessions of the gateway are new, and the
callers log in again. That is the only interruption of the cutover, and
it is a login, not an outage.

**The gate of every phase**: the compatibility suite is green, the
alerts are silent, and the difference between the answers of Hub and the
ones of the old service is empty.

---

## 13. The risks

| # | The risk | The consequence | The mitigation | The task |
| --- | --- | --- | --- | --- |
| 1 | The gateway refuses a discovery whose issuer is not the one it was configured with. | The login of a tenant fails at the first attempt. | The issuer is a single value in the environment of both sides; the compatibility suite asserts it character for character. | HUB-041, HUB-070 |
| 2 | The `roles` claim is a snapshot and the upstreams read it. | An upstream that authorizes on the roles keeps a permission that was revoked. | The claim is documented as a snapshot; the decision is computed over the table. An upstream that authorizes on the roles is a deployment that does not use the access service at all. | HUB-043 |
| 3 | The revocation is visible to the gateway only after the TTL of its cache. | A revoked caller reaches the upstream for five seconds. | The TTL is a knob of the route of the gateway (`accessCacheTtlMs: 0` makes it immediate). Hub cannot make it faster without a change of the gateway. | HUB-031, HUB-070 |
| 4 | A tenant registers an `idp_issuer` that points at an internal address. | Hub calls a service of the deployment with the credentials of the tenant. | The address is checked before the call; the egress is restricted to the known providers. | HUB-081 |
| 5 | The store of the codes is down. | The logins fail. | The store is a shared one with an alert on the errors; the failure is loud and it is never a silent allowance. | HUB-063, HUB-083 |
| 6 | The mapping by e-mail is tempting and wrong. | Two people share an address, or an address is reassigned, and a principal inherits the access of another. | The mapping key is `(tenant, subject)`, the e-mail is a display value, and there is a test that says so. | HUB-054 |
| 7 | The multi-tenancy pushes the gateway to change. | The project stops being a broker and becomes a fork of the gateway. | The compatibility suite fails the build when the gateway changes. | HUB-070 |
| 8 | The shared client is enabled to serve several tenants from one gateway. | The tenant of a login becomes a hint that the caller controls. | It is refused by default; the supported topology is one gateway per tenant. | HUB-050 |
| 9 | The scope creep of the deferred features. | The four tables become eight, and the service grows a console nobody uses. | The test that asserts the absence of a deferred feature, and the rule that a feature needs a paying customer. | §2.1, §6.2 |

---

## 14. The definition of done

The service is done for the first release when:

- [ ] The eight milestones are closed, with their exit criteria checked.
- [ ] The checklist of §11 is checked, item by item.
- [ ] The compatibility suite passes with an empty diff of the gateway.
- [ ] The capacity numbers of §10 are measured and published.
- [ ] The runbooks of HUB-082 are written and were walked through.
- [ ] The first tenant is in production, and the shadow period of phase 1
      was empty.
- [ ] The spec is up to date with the code, and the decisions of the
      milestones are recorded with their evidence.

And the service is **not** done when it has a console, a SAML provider, a
SCIM client or a directory sync. Those are deferred, and they are
deferred until a customer pays for them.
