# Hub — Architecture

How the service is put together, and what the build checks about it. The
behavior is in [spec.md](spec.md); the wire format is in [api.md](api.md).

## The shape

Hub is a **modular monolith**: one process, one image, one database, four
independent domains. The boundaries between the parts are not a convention
of the review — they are **checked by the build**, and a violation fails
the CI.

```
   the browser ─┐
                ├─►  src/app/       the HTTP surface: thin handlers, one pipeline
   the gateway ─┘        │
                         ▼
              src/domains/     the rules, and only the rules
       identity │ authorization │ administration │ provider
                         ▲
                         │  the ports of the domains
              src/platform/     PostgreSQL, Redis, the Bun listener, the HTTP client
                         ▲
                         │
              src/runtime/       the composition root: the environment, the wiring
```

The direction of the arrows is the direction of the dependencies: the
runtime knows everything, the domains know nothing but their own rules,
and the application talks to the domains through their public entry
points.

## The layers

| Layer | Owns | Never does |
| --- | --- | --- |
| `src/domains/` | The policy of one domain: the validation of a token of a provider, the rule of the decision, the validation of the bodies of the administration, the claims of a token. | Touch the network, the database, the framework or the environment. |
| `src/app/` | The order of the pipeline, the mapping of the failures of a domain to the answers of the protocol, the headers of the answers. | Hold a rule. |
| `src/platform/` | The adapters: the SQL of the repositories, the driver of the store, the listener, the client of the provider. | Decide anything. |
| `src/observability/` | The logs, the metrics, the constant-time comparison of the secrets. | Depend on anything else. |
| `src/runtime/` | The reading of the environment, the composition of the pieces, the lifecycle and the drain. | — |

## The boundaries that the build checks

`scripts/architecture.ts` is run by the CI and by `test/architecture/`. It
walks the source tree and fails on a forbidden import. The rules, copied
and extended from the gateway:

1. A domain is imported through its public entry point (`index.ts`).
2. The four domains are independent: none of them depends on another.
3. Core domain code imports no framework (Hono), no Bun api, no adapter,
   no application, no platform and no runtime.
4. The application uses the public entry points of the domains and the
   observation interfaces, never a concrete adapter.
5. The platform implements the ports of the domains, it makes no policy
   decision and it knows neither the application nor the runtime.
6. The observation layer is independent of everything else.
7. The runtime is the composition root: it may assemble everything.
8. There are no catch-all directories and no import cycles.
9. The framework of the application belongs to the application and the
   api of the runtime belongs to the platform of the runtime.
10. The environment is read in the runtime only: a domain that reads
    `process.env` has a setting that nobody can validate.

A second test, `test/architecture/no-scaffolding.test.ts`, asserts that
the code contains **no SAML, no console, no SCIM and no directory sync**:
a half-built feature in a service that carries a customer is a liability
(spec §13).

## The layout

| Path | Owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. |
| `src/runtime/env.ts` | The schema of the environment, the defaults, the validation as a whole, the refusal to start in production without the required secrets. The only place that reads `process.env`. |
| `src/runtime/composition.ts` | The composition root: the adapters, the repositories, the wiring of the application. |
| `src/runtime/lifecycle.ts` | The listener, the drain, the deadline of the drain. |
| `src/app/app.ts` | The pipeline of a request: the request id, the probes, the routes, the refusal of the unknown paths, the handler of the unexpected errors. |
| `src/app/{login,oauth,provider}.ts` | The login, the token endpoint, the discovery and the JWKS. |
| `src/app/decisions.ts` | The decision contract of the gateway. |
| `src/app/administration.ts` | The eight endpoints: the authentication, the limits, the pagination, the audit of the changes. |
| `src/app/{errors,pages,metrics,endpoints,state}.ts` | The answers of refusal, the pages of the login, the metrics, the probes, the state of a request. |
| `src/domains/identity/` | The validation of the token of a provider, the resolution of the tenant, the state of a login, the mapping to a principal, the client of the provider. |
| `src/domains/authorization/` | The rule of the decision and the reasons. |
| `src/domains/administration/` | The eight endpoints as a service: the validation of the bodies, the limiter, the audit. |
| `src/domains/provider/` | The keys, the tokens, the discovery, the authorization code, the exchange. |
| `src/platform/postgres/` | The pool, the migrations, the repositories of the five tables, the trace of the statements, the scope of a tenant, the table of the audit. |
| `src/platform/redis/` | The store of the authorization codes. |
| `src/platform/bun/` | The listener, the request and the response of the platform, the guard of the addresses. |
| `src/observability/` | The logs and the redaction, the metrics, the comparison of the secrets. |
| `scripts/` | The operator tools: the smoke test, the shadow comparison, the load, the plan of the decision, the rotation of the secrets, the architecture checker. |

## The two flows

### The login

```
gateway ──► GET /oauth/authorize
               │  resolve the tenant (§5.2 of the spec)
               │  create the state cookie (encrypted, single use, 10 min)
               ▼
            302 to the provider of the tenant
               │
               ▼
provider ──► GET /oauth/tenant/callback?code=…&state=…
               │  read the cookie, check the state, delete the cookie
               │  exchange the code at the provider (PKCE S256)
               │  validate the id token (issuer, audience, nonce, algorithm, signature, clock)
               │  map (tenant, sub) → the principal row (§6.2)
               │  issue the authorization code of the gateway (60 s, single use, in Redis)
               ▼
            302 to the gateway
               │
gateway ──► POST /oauth/token
               │  authenticate the client (client_secret_basic)
               │  exchange the code for the id token and the access token
               ▼
            200 {"access_token": …, "id_token": …}
```

### The decision

```
gateway ──► POST /v1/decisions  {subject, workspaceId, routeId, roles}
               │  authenticate (bearer token of the deployment, or the credentials of a tenant)
               │  one statement over users, tenants, grants, permissions, groups
               │  a timeout of HUB_DECISION_TIMEOUT_MS
               ▼
            200 {"allow": true|false, "reason": "…"}
```

The query of the decision is one statement, in
`src/platform/postgres/decisions.ts`, that returns the **facts** of the
rule; the domain in `src/domains/authorization/decision.ts` turns the
facts into the answer and the reason. The storage never decides, and the
domain never sees SQL.

## The data model

Five tables, and the whole model is in spec §3. What matters for the
architecture:

- The **keys carry the tenant**. Every table of the domain has a
  `tenant_id`, and the foreign keys are composite (`(id, tenant_id)`) so
  that a grant can never name a principal of another tenant. The
  constraint is in the schema, not in the application.
- The **isolation has a backstop in the database**: the five tables have
  the row level security of PostgreSQL, the scope of a statement is the
  setting `hub.tenant_id`, and the scope is local to the transaction, so a
  pooled connection never carries the scope of another request.
- The **grants are the policy**, and there is no policy language: a
  permission, a workspace, a route, an expiry.
- The **protocol state is not in the database**: the state of a login is
  in the cookie of the browser, the authorization code is in the store for
  sixty seconds.
- The **audit is not in the domain model**: the table `admin_audit` holds
  what changed and who changed it, and it holds no tenant, no principal
  and no grant. It is a table of the infrastructure, like the table of the
  migrations.

## The tests

| Kind | Where | What it proves |
| --- | --- | --- |
| Unit | `src/domains/*/*.test.ts` | The policy of one domain, without the network and without the database. |
| Contract | `test/contract/` | The endpoints over a socket, with the fixtures around: the login, the decision, the administration, the audit, the rotation of the secrets. |
| Integration | `test/integration/` | The decisions against a real PostgreSQL, the isolation, the migrations, the deadline of a statement, the rule of the decision against a policy that is built at random. |
| Compatibility | `test/compatibility/` | **The gateway of the reference, unchanged, against Hub.** |
| Architecture | `test/architecture/` | The import boundaries and the absence of the deferred features. |

The compatibility suite starts the gateway of the Shuttle reference, at
the commit pinned in `shuttle.ref`, with Hub in place of its two
fixtures. The CI then asserts that the tree of the reference was not
touched: **the build fails if anyone modifies the gateway to make a test
pass.**

## The rules of the work

1. **One rule, one domain, one test file next to it.** A rule that has no
   test is a rule that is not implemented.
2. **The boundaries are checked by the build, not by a review.**
3. **Shuttle is not modified.** Not for a feature, not for a bug, not for
   a test.
4. **The schema does not reserve anything for a future.** No column that
   is always `null`, no table that is empty, no flag that is never read.
5. **The measurements are taken before the code depends on them.**
6. **A failure is a denial.** Everywhere: a database that is down, a
   store that is down, a provider that is slow, a secret that is missing.
   The service never guesses in the direction of allowing.
7. **A decision is written down with its evidence.** The evidence is a
   measurement, a test, or a document of the provider — never an
   intuition.
