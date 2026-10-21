# Hub — Specification

**Hub** is a Bun service that brokers the login of a caller against the
OpenID Connect provider of a tenant, maps the external identity of the
caller to a principal row, answers the decision requests of a gateway over
a table of grants, and offers five `curl` endpoints for the administration
of the whole thing.

Hub is **not** a feature of Shuttle. It is a separate deployable that sits
between the browsers, the identity providers of the tenants and the
gateways. Shuttle is not changed: it keeps its single provider, its single
access service and its whole configuration, and it gains **zero** new
features. Hub is what a Shuttle deployment points at.

This document is normative for the behavior of Hub. The behavior of the
gateway itself is in `docs/spec.md` of the **Shuttle** repository, the
reference of this service, and it is unchanged by this document; the
places where the two meet are listed in §12.

How the service is built, in what order, and what has to be true before
it carries a customer's traffic, is in [IMPLEMENTATION.md](IMPLEMENTATION.md).
That document is a plan and not a contract.

Status: 0.1.0 (draft). Runtime: Bun ≥ 1.4.3, like the gateway.
Listener: HTTP on `HUB_HOST:HUB_PORT` (default `0.0.0.0:8081`).

---

## 1. Scope

### 1.1 What Hub does


|                                         |                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brokers the login**                   | Hub is the OpenID Connect client of the provider of a tenant and the OpenID Connect provider of the gateway, at the same time. The browser logs in at the provider of the tenant; the gateway sees a provider it already knows how to talk to. |
| **Maps the identity**                   | The `(tenant, subject)` pair of the provider is mapped to exactly one **principal row**. The row is the identity of the platform; the external identity is only the way in.                                                                    |
| **Answers the decisions**               | Hub implements the decision contract the gateway already speaks: `POST /v1/decisions`. The decision is computed over a table of **grants**.                                                                                                    |
| **Is administered with five endpoints** | A tenant, a principal and a grant are created and revoked with five `curl` calls. There is no console, no portal and no wizard.                                                                                                                |


### 1.2 What Hub does not do

- It does not proxy traffic. It is not in the path of a request that is
already authenticated; only the login and the decisions pass through it.
- It does not decide access on its own policy language. The policy is the
table of grants and nothing else.
- It does not manage the routes, the upstreams or the workspaces of a
deployment. The gateway keeps that part.

### 1.3 The relationship with Shuttle

```
   browser                     Hub                       tenant IdP          Shuttle
      │                         │                             │                  │
      │  GET /auth/login ──────▶│                             │                  │
      │                         │◀──── /oauth/authorize ──────│                  │
      │◀── 302 to Hub ──────────│                             │                  │
      │                         │───── 302 to the IdP ───────▶│                  │
      │◀── 302 to the IdP ──────│◀────────────────────────────│                  │
      │                         │◀── /oauth/tenant/callback ──│                  │
      │                         │  map (tenant, sub) → row    │                  │
      │                         │─── 302 to Shuttle ────────────────────────────▶│
      │                         │                             │                  │
      │                         │◀── POST /oauth/token ──────────────────────────│
      │                         │    id_token, access_token   │                  │
      │                         │                             │                  │
      │                         │◀── POST /v1/decisions ─────────────────────────│
      │                         │    {"allow":true}           │                  │
```

The gateway sees **one** provider (Hub) and **one** access service (Hub).
It cannot tell that Hub is a broker in front of several identity providers,
and it must not have to: that is the whole point of the design.

### 1.4 The consequence that has to be said out loud

A gateway is configured with **one** client id and **one** redirect uri. The
tenant of a login is therefore resolved from the client id of the
authorization request (§5.2), and a client id belongs to exactly one
tenant.

So the supported topology is:

- **one Shuttle deployment per tenant**, each registered at Hub as the
client of that tenant; or
- **one Shuttle deployment for several tenants**, only when every one of
those tenants is registered under the same client id, which the schema
does not allow.

Hub is multi-tenant; Shuttle is not. That is not a gap in the design, it
is the price of "Shuttle gains zero new features", and it is paid on the
side of Hub, which is where the tenancy belongs. §5.2 describes the one
escape hatch (a shared client) and what it costs.

---

## 2. Terms


| Term                       | Meaning                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **tenant**                 | A customer of the platform. It owns one identity provider, one principal population and one set of grants.                                                               |
| **provider (of a tenant)** | The OpenID Connect provider of the tenant. Exactly one per tenant.                                                                                                       |
| **principal**              | The row of `users` that carries the identity of a caller inside the platform. It is the `subject` of every token Hub issues and the `subject` of every decision request. |
| **permission**             | A named capability, e.g. `workspace.read`. It is a *role* of the platform: it travels in the `roles` claim and it is what a grant gives.                                 |
| **grant**                  | The permission a principal holds, on a workspace, on a route, until it is revoked or it expires.                                                                         |
| **decision**               | The answer of `POST /v1/decisions`: may this principal use this workspace on this route?                                                                                 |
| **gateway**                | A Shuttle deployment. It is a client of Hub and a consumer of the decisions.                                                                                             |
| **operator**               | The person who runs Hub and calls the five administrative endpoints.                                                                                                     |


### 2.1 The invariants

None of them is configurable. Each of them is enforced in code and has a
test.

1. **Hub never authenticates a caller against a provider that is not the
 one of the tenant.** The issuer, the audience, the nonce and the
 algorithm of the token of the provider are checked before the identity
 is read.
2. **An external identity is never mapped by its e-mail.** The mapping key
 is `(tenant, subject)`. An e-mail is mutable and is not an identity.
3. **A principal that has no grant is refused.** The existence of a
 principal is not an access.
4. **A decision is denied when it cannot be computed.** A database that
 cannot be reached produces a denial, never an allowance.
5. **The administrative endpoints are the whole administration surface.**
 There is no second way to change a tenant, a principal or a grant.
6. **A secret is never returned, never logged and never travels in a
 browser.** The client secret of a provider, the client secret of a
 gateway and the tokens are write-only.
7. **A gateway never learns a reason.** The reason of a decision is for
 the operator; the gateway does not forward it to a caller, and neither
 does Hub.
8. **The contract of the gateway does not change.** Hub answers the
 decision request the gateway already sends, with the body it already
 sends (§8).

---

## 3. The four tables

The whole domain model of Hub is four tables. They are read in one sitting
and they are the only tables: the protocol state that is not a domain
concept (the authorization codes) lives in the shared store (§5.5), not in
the database.

### 3.1 `tenants`

One row per customer. It carries the registration of the provider of the
tenant and the registration of the gateway of the tenant.


| Column                     | Type          | Rule                                                                                                                                     |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`        | Primary key.                                                                                                                             |
| `slug`                     | `text`        | The stable name of the tenant, `[a-z0-9-]{2,63}`. Unique. It is the name the operator uses.                                              |
| `display_name`             | `text`        | The name shown to a human.                                                                                                               |
| `enabled`                  | `boolean`     | Default `true`. A disabled tenant denies every decision and refuses every login.                                                         |
| `is_default`               | `boolean`     | Default `false`. At most one tenant is the default (§5.2).                                                                               |
| `auto_provision`           | `boolean`     | Default `false`. Whether an unknown external identity creates a principal row on its first login (§6.4).                                 |
| `email_domain`             | `text`        | The domain of the tenant, `null` when the tenant has none. Unique when it is set. It is a **hint**, never an authorization (§5.2, §6.3). |
| `idp_issuer`               | `text`        | The issuer of the provider of the tenant. The `iss` of a token that does not match it exactly is refused.                                |
| `idp_client_id`            | `text`        | The client id of Hub at the provider of the tenant.                                                                                      |
| `idp_client_secret`        | `bytea`       | The client secret of Hub at the provider of the tenant, encrypted at rest (§4.3).                                                        |
| `idp_redirect_uri`         | `text`        | The url of Hub at the provider of the tenant. It must be the url of §5.1.                                                                |
| `idp_scopes`               | `text[]`      | The scopes Hub asks the provider for. Default `['openid', 'email', 'profile']`.                                                          |
| `idp_algorithms`           | `text[]`      | The algorithms a token of the provider may be signed with. Default `['RS256']`.                                                          |
| `client_id`                | `text`        | The client id of the **gateway** of the tenant at Hub. Unique across the tenants.                                                        |
| `client_secret`            | `bytea`       | The secret of the gateway of the tenant, encrypted at rest (§4.3).                                                                       |
| `shared_client`            | `boolean`     | Default `false`. Whether the gateway of this tenant may log in principals of other tenants (§5.2).                                       |
| `created_at`, `updated_at` | `timestamptz` |                                                                                                                                          |


### 3.2 `users`

One row per principal. It is the identity of the platform.


| Column                     | Type          | Rule                                                                                                                     |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`                       | `uuid`        | Primary key. This is the `sub` of every token Hub issues and the `subject` of every decision request.                    |
| `tenant_id`                | `uuid`        | The tenant of the principal. Foreign key to `tenants`.                                                                   |
| `external_subject`         | `text`        | The `sub` of the provider of the tenant.                                                                                 |
| `email`                    | `text`        | The last e-mail seen at the provider. `null` when the provider does not publish one. It is a display value, never a key. |
| `display_name`             | `text`        | The last name seen at the provider.                                                                                      |
| `status`                   | `text`        | `active` or `disabled`. Default `active`. A disabled principal is refused at the login and denied at every decision.     |
| `last_login_at`            | `timestamptz` | The last successful login. `null` before the first one.                                                                  |
| `created_at`, `updated_at` | `timestamptz` |                                                                                                                          |


Unique: `(tenant_id, external_subject)`. The pair `(id, tenant_id)` is
unique as well, so a grant can carry its tenant in a foreign key (§3.4).

### 3.3 `permissions`

A named capability. A permission is a *role* of the platform: it is what
travels in the `roles` claim of a token and what a grant gives.


| Column        | Type      | Rule                                                                                                                       |
| ------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`          | `uuid`    | Primary key.                                                                                                               |
| `tenant_id`   | `uuid`    | The tenant that owns the permission, or `null` when it belongs to the catalogue of the platform. Foreign key to `tenants`. |
| `key`         | `text`    | The name of the permission, `[a-z0-9][a-z0-9._-]{0,63}`.                                                                   |
| `description` | `text`    | `null` when there is none.                                                                                                 |
| `enabled`     | `boolean` | Default `true`. A disabled permission is never given by a grant.                                                           |


Unique: `(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)`.
The `coalesce` is there because `null` is not equal to `null` in a unique
index of PostgreSQL, and the catalogue of the platform would otherwise
accept two rows with the same key.

A permission of the catalogue (`tenant_id is null`) may be granted to every
tenant. A permission of a tenant may only be granted inside that tenant.

### 3.4 `grants`

The policy of the platform. A grant says: this principal holds this
permission, on this workspace, on this route, until this date.


| Column          | Type          | Rule                                                                                                                                                                                                                                   |
| --------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `uuid`        | Primary key.                                                                                                                                                                                                                           |
| `tenant_id`     | `uuid`        | The tenant of the grant. Foreign key to `tenants`.                                                                                                                                                                                     |
| `user_id`       | `uuid`        | The principal of the grant. Foreign key to `(id, tenant_id)` of `users`: **a grant can never name a principal of another tenant**.                                                                                                     |
| `permission_id` | `uuid`        | The permission of the grant. Foreign key to `permissions`.                                                                                                                                                                             |
| `workspace_id`  | `text`        | The workspace of the grant, or `null` for every workspace of the tenant. The gateway validates a workspace as a UUID, but Hub keeps the value as it is given: a workspace that is not a UUID simply matches no workspace-scoped grant. |
| `route_id`      | `text`        | The route of the grant, or `null` for every route. The id of a route of the gateway, e.g. `workspace-api`.                                                                                                                             |
| `expires_at`    | `timestamptz` | `null` when the grant does not expire.                                                                                                                                                                                                 |
| `revoked_at`    | `timestamptz` | `null` while the grant is alive. A revoked grant is kept, it is not deleted: the history of the policy is worth more than the bytes.                                                                                                   |
| `granted_by`    | `text`        | Who granted it, for the audit log. `null` when it is not known.                                                                                                                                                                        |
| `created_at`    | `timestamptz` |                                                                                                                                                                                                                                        |


Unique: `(tenant_id, user_id, permission_id, coalesce(workspace_id, ''), coalesce(route_id, ''))` among the grants that are not revoked. The
`coalesce` is there for the same reason as in §3.3: a grant of "every
workspace" and a grant of "the workspace ''" have to be two different
rows, and the second one is impossible anyway.

### 3.5 The diagram

```
  tenants ────< users ────< grants >──── permissions
     │                                 (tenant_id may be null)
     │
     └── the registration of the provider and of the gateway
```

### 3.6 The migrations

The schema is created by plain SQL files, applied in the order of their
names, by one runner that takes an advisory lock so two replicas that
start at the same time do not apply the same migration twice. A migration
that fails stops the process: Hub does not start against a schema it does
not understand.

The four tables are created by the first migration. There is no second
table "for later": a feature that needs one is a feature that is deferred
until a customer pays for it (§13).

The bookkeeping of the migrations lives in a table of the infrastructure,
`hub_schema_migrations`. It holds the name of the migrations that were
applied and nothing else: it is not a table of the domain model and it
carries no data of the platform. It exists because the runner has to know
what the schema of the database is: a database that holds a migration this
version of Hub does not know is a schema Hub does not understand, and the
process refuses to start against it.

### 3.7 The database of a development machine

The database of Hub is PostgreSQL. The driver is named by
`HUB_DATABASE_URL`:

| The value                             | The database                                     |
| ------------------------------------- | ------------------------------------------------ |
| `postgres://…` or `postgresql://…`    | A PostgreSQL server.                             |
| `pglite://<path>`                     | The embedded PostgreSQL of the process, in `<path>`. |
| Nothing, in a development environment | The embedded PostgreSQL of the process, in `./.hub/pglite`. |

The embedded PostgreSQL is `pglite`: PostgreSQL compiled to WebAssembly,
running in the process of Hub. It is the same PostgreSQL as the one of a
deployment, so a development machine applies the migrations of the
production and nothing has to be translated between the two.

A **production** environment must name a PostgreSQL server: the embedded
database lives in one process and the replicas of a deployment share their
tables. A production environment that names the embedded database is
refused at the start.

The tests run on the embedded database by default. A workflow that has a
server names it in `HUB_TEST_DATABASE_URL` and the same tests run against
it.

---

## 4. The environment

The environment is read once, at the start of the process, and validated as
a whole: a value that cannot be understood stops the service. The only
exception is the level of the log, which falls back to `info`.


| Variable                    | Why                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_HOST`                  | The address of the listener. Default `0.0.0.0`.                                                                                                                                                                                                                                   |
| `HUB_PORT`                  | The port of the listener. Default `8081`.                                                                                                                                                                                                                                         |
| `HUB_ISSUER`                | The public issuer url of Hub. It is the `iss` of every token it issues and the issuer the gateway is configured with. It must be the url the browser and the gateway use: the discovery document of a different issuer is refused by the gateway (§6 of the spec of the gateway). |
| `HUB_PUBLIC_URL`            | The public url of Hub, when it differs from the issuer. Default: the issuer.                                                                                                                                                                                                      |
| `HUB_DATABASE_URL`          | The PostgreSQL of the four tables. A PostgreSQL server of a deployment, the embedded PostgreSQL of a development machine (§3.7). Required in a production environment.                                                                                                                             |
| `HUB_REDIS_URL`             | The shared store of the authorization codes. Required when more than one replica runs.                                                                                                                                                                                            |
| `HUB_ALLOW_MEMORY_STATE`    | Replaces the shared store with the memory of the process. The gateway has the same escape hatch, for the same reason.                                                                                                                                                             |
| `HUB_ADMIN_TOKEN`           | The bearer token of the five administrative endpoints. Required in production.                                                                                                                                                                                                    |
| `HUB_ACCESS_TOKEN`          | The bearer token the gateway presents on `POST /v1/decisions`. Required in production.                                                                                                                                                                                            |
| `HUB_STATE_SECRET`          | Signs and encrypts the state of a login (§5.3). 32 bytes at least. The same value on every replica.                                                                                                                                                                               |
| `HUB_SECRET_ENCRYPTION_KEY` | Encrypts the client secrets at rest (§4.3). 32 bytes.                                                                                                                                                                                                                             |
| `HUB_SIGNING_KEY`           | The private key of Hub, in PEM. The public part is published at `/oauth/jwks`.                                                                                                                                                                                                    |
| `HUB_SIGNING_KID`           | The identifier of the key in the JWKS.                                                                                                                                                                                                                                            |
| `HUB_IDP_TIMEOUT_MS`        | How long Hub waits for the provider of a tenant. Default `5000`.                                                                                                                                                                                                                  |
| `HUB_DECISION_TIMEOUT_MS`   | How long a decision may take before it is a denial. Default `2000`.                                                                                                                                                                                                               |
| `HUB_CLOCK_SKEW_SECONDS`    | The tolerance of the clock on the tokens of a provider. Default `60`.                                                                                                                                                                                                             |
| `HUB_METRICS_TOKEN`         | The bearer token of the metrics endpoint. Without it the endpoint is not served.                                                                                                                                                                                                       |
| `HUB_LOG_LEVEL`             | `debug`, `info`, `warn` or `error`. Default `info`.                                                                                                                                                                                                                               |
| `HUB_ENVIRONMENT`           | `development` or `production`. The fixtures refuse to run in production.                                                                                                                                                                                                          |


### 4.1 The secrets

The two tokens of the service are compared in constant time. They are read
from the environment and never written to a log.

### 4.2 The signing key

The tokens Hub issues are signed with `RS256` and published at
`/oauth/jwks`. The key is a secret of the deployment: it comes from the
environment or from a secret manager, it is never generated at the start of
a process (a key that changes at every restart invalidates every token
that is alive) and it is never written to a disk of the container.

A rotation is the publication of a second key in the JWKS and the change
of `HUB_SIGNING_KEY`; the old key stays published until the last token it
signed has expired.

### 4.3 The secrets at rest

The two client secrets of a tenant (the one of the provider and the one of
the gateway) are encrypted with AES-256-GCM under
`HUB_SECRET_ENCRYPTION_KEY` before they are written. The administrative
endpoints take them in clear over TLS and never return them: an answer
carries `null` in their place.

Changing `HUB_SECRET_ENCRYPTION_KEY` makes every stored secret
unreadable. The migration is a re-encryption of the two columns, done by
the operator, in one transaction.

The key of the encryption is derived from the secret of the deployment
with HKDF-SHA256, so the secret may be a passphrase, a hexadecimal string
or a base64 string, and the key of the encryption is always 32 bytes.

The stored ciphertext carries the version of its format, so a change of
the format is a version and not a migration of the column:

| Bytes    | What they hold                              |
| -------- | ------------------------------------------- |
| `1`      | The version of the format (currently `1`).  |
| `12`     | The nonce of the encryption.                |
| The rest | The body and the tag of the encryption.     |

A service without `HUB_SECRET_ENCRYPTION_KEY` does not store the client
secrets in clear: it refuses to write a tenant and says so.

`scripts/rotate-secrets.ts` is the tool of the rotation: it reads the key
that is in use and the new one, re-encrypts the two columns of every
tenant in one transaction and the deployment is then restarted with the
new key.

### 4.4 What a production deployment needs

A production deployment (`HUB_ENVIRONMENT=production`) refuses to start
when one of these is missing. Every problem of the environment is reported
at once and the message names the variables that are missing: a deployment
that fixes one variable and restarts to learn about the next one stays
down.

| Variable                  | Why it is required                                                              |
| ------------------------- | ------------------------------------------------------------------------------- |
| `HUB_DATABASE_URL`        | The four tables live there. It is required in a production environment; a development machine runs the embedded PostgreSQL of the process (§3.7). |
| `HUB_ISSUER`              | It is the `iss` of every token Hub issues and the issuer the gateway is configured with. |
| `HUB_REDIS_URL`           | The authorization codes have to be shared by the replicas, unless `HUB_ALLOW_MEMORY_STATE=true` names a deployment of a single node. |
| `HUB_ADMIN_TOKEN`         | It is the bearer token of the five administrative endpoints.                     |
| `HUB_ACCESS_TOKEN`        | It is the bearer token the gateway presents on `POST /v1/decisions`.             |
| `HUB_STATE_SECRET`        | It signs and encrypts the state of a login. At least 32 bytes.                  |
| `HUB_SECRET_ENCRYPTION_KEY` | It encrypts the client secrets at rest. At least 32 bytes.                    |
| `HUB_SIGNING_KEY`         | It is the private key Hub signs its tokens with, in PEM.                         |
| `HUB_SIGNING_KID`         | It is the identifier of the key in the JWKS.                                     |

A secret is at least 32 bytes long. A secret that is handed over as a hex
string or as a base64 string is counted the way it is read: 32 bytes are 64
hexadecimal characters and 44 base64 characters.

The level of the log is the only value of the environment that does not
stop the service: a typo in the level of a log must not keep a deployment
down.

---

## 5. The login

### 5.1 The endpoints of Hub


| Endpoint                                | Behaviour                                                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /oauth/authorize`                  | The authorization endpoint of Hub. The gateway sends the browser here.                                                                                     |
| `GET /oauth/tenant/callback`            | The callback of Hub at the provider of a tenant. The provider sends the browser here.                                                                      |
| `POST /oauth/token`                     | The token endpoint of Hub. The gateway exchanges the code here. The client authenticates with `client_secret_basic`; a client without a secret is refused. |
| `GET /oauth/jwks`                       | The keys of Hub.                                                                                                                                           |
| `GET /oauth/userinfo`                   | The claims of the principal of a bearer token.                                                                                                             |
| `GET /.well-known/openid-configuration` | The discovery document of Hub.                                                                                                                             |
| `POST /v1/decisions`                    | The decision contract of the gateway (§8).                                                                                                                 |
| `GET /healthz`                          | `200 {"status":"ok",…}`. Always available.                                                                                                                 |
| `GET /readyz`                           | `200` when the database answers and the migrations are applied, `503` otherwise.                                                                           |
| `GET /metrics`                          | Prometheus text. `404` when `HUB_METRICS_TOKEN` is unset, `401` when the bearer token does not match.                                                      |
| `POST /v1/admin/tenants`                | Administration (§9).                                                                                                                                       |
| `GET /v1/admin/tenants`                 | Administration (§9).                                                                                                                                       |
| `POST /v1/admin/users`                  | Administration (§9).                                                                                                                                       |
| `PUT /v1/admin/grants`                  | Administration (§9).                                                                                                                                       |
| `DELETE /v1/admin/grants/{id}`          | Administration (§9).                                                                                                                                       |


Every other path is `404 not_found`.

### 5.2 The tenant of a login

The tenant of a login is resolved in this order. The first match wins.

1. **The client of the request.** The `client_id` of the authorization
 request names the tenant whose `client_id` it is. This is the normal
 case and it is the only one a gateway can reach (§1.4).
2. **The `tenant` parameter.** When the tenant of the client has
 `shared_client = true`, the authorization request may name another
 tenant in its `tenant` parameter, and that tenant is used. The
 parameter is ignored when the client is not shared, so a parameter
 cannot move a login to another tenant.
3. **The hint.** When the request carries a `login_hint` that is an
 e-mail, its domain names the tenant whose `email_domain` is that
 domain. The hint is only usable when the tenant of the client is
 shared.
4. **The default tenant.** When the tenant of the client is shared and no
 other rule matched, the tenant whose `is_default = true` is used.

A client that names no tenant → `400 invalid_request`. A tenant that is
disabled → `403 tenant_disabled`.

A shared client is a deliberate weakening: the operator accepts that a
login may be resolved to a tenant by a hint that the caller controls. It
is refused by default and it is the reason a shared gateway is not the
recommended topology.

### 5.3 The state of a login

The state of a login is carried by two cookies and by the parameters of
the redirects.

**The state cookie** (`hub_login_state`) holds, encrypted with
`HUB_STATE_SECRET` (AES-256-GCM, authenticated): the tenant, the client
id, the redirect uri, the `state` of the gateway, the `nonce`, the
verifier of the PKCE of the provider and the moment the login started. It
is `HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/oauth/tenant/callback`,
and it lives ten minutes.

The state cookie is **single use**: it is deleted as soon as the callback
is processed, whatever the outcome.

**The state of the provider.** Hub sends a fresh random `state` to the
provider and a fresh `nonce`; both are bound to the state cookie and are
checked when the browser comes back.

**The PKCE.** Hub sends `S256` to the provider and keeps the verifier in
the state cookie. A provider that does not support PKCE is refused at the
registration of the tenant.

### 5.4 The flow, step by step

1. The gateway sends the browser to
 `GET /oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=openid profile email groups&state=…&nonce=…&code_challenge=…&code_challenge_method=S256`.
2. Hub resolves the tenant (§5.2), creates the state cookie and redirects
 the browser to the authorization endpoint of the provider of the tenant,
 with the `state`, the `nonce`, the `code_challenge` and the
 `redirect_uri` of the tenant.
3. The provider authenticates the caller and sends the browser back to
 `GET /oauth/tenant/callback?code=…&state=…`.
4. Hub reads the state cookie, checks that the `state` matches, deletes
 the cookie, exchanges the code at the provider with the verifier of the
 PKCE, and validates the id token (§6.1).
5. Hub maps the external identity to a principal (§6.2, §6.4).
6. Hub issues an authorization code for the gateway and redirects the
 browser to the `redirect_uri` of the request, with the code and the
 `state` of the gateway.
7. The gateway exchanges the code at `POST /oauth/token` with its
 verifier, its client id and its secret.
8. Hub answers with an `id_token` and an `access_token` (§7).

### 5.5 The authorization code

The code is an opaque random string of 32 bytes. It is stored in the
shared store under a hash of itself, with the client id, the redirect uri,
the challenge of the PKCE, the principal and the moment it was created.

- It lives **60 seconds**.
- It is **single use**: the first exchange deletes it, the second exchange
is `invalid_grant`.
- It is bound to the client id, to the redirect uri and to the challenge of
the PKCE. An exchange that presents another redirect uri, another client
or a verifier that does not match the challenge is `invalid_grant`.
- It never carries the identity in the clear.

The shared store is Redis. A deployment of one replica may use the memory
of the process with `HUB_ALLOW_MEMORY_STATE=true`, exactly like the
gateway does for its sessions. A store that cannot be reached is an error:
the login fails, it never falls back to "no state".

### 5.6 What a failed login answers


| Case                                                           | Answer                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The provider refuses the login                                 | The provider's own answer is passed to the browser, unchanged.                                                                                                 |
| The provider is unreachable                                    | `502 upstream_unavailable`, with a page that says the provider is not reachable and the name of the tenant. The reason is never the raw error of the provider. |
| The token of the provider is invalid                           | `403 identity_rejected`, with a page that says the identity was refused. The reason of the refusal is in the log of the service.                               |
| The identity is unknown and the tenant does not auto-provision | `403 identity_unknown`, with a page that says the identity is not known to the platform. The log carries the `(tenant, subject)` that was refused.             |
| The principal is disabled                                      | `403 principal_disabled`.                                                                                                                                      |
| The state does not match, or the cookie is missing             | `400 login_state_invalid`. The login is refused and a new one has to start.                                                                                    |


---

## 6. The mapping of the identity

### 6.1 The validation of the token of the provider

Before a single row is read, the token of the provider is validated:


| Check         | Rule                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The issuer    | `iss` is **exactly** the `idp_issuer` of the tenant. A comparison that ignores the case or the trailing slash is not allowed.      |
| The audience  | `aud` contains the `idp_client_id` of the tenant, or `azp` is it.                                                                  |
| The nonce     | `nonce` is the nonce of the login in flight.                                                                                       |
| The algorithm | The algorithm is in the `idp_algorithms` of the tenant. The `none` algorithm and an algorithm that is not in the list are refused. |
| The signature | It is verified with the JWKS of the provider, fetched from its discovery document and cached for ten minutes.                      |
| The clock     | `exp` and `iat` are checked with a tolerance of `HUB_CLOCK_SKEW_SECONDS`.                                                          |
| The subject   | `sub` is present and is not empty.                                                                                                 |


The discovery document of the provider is fetched from
`{idp_issuer}/.well-known/openid-configuration`. A provider whose issuer
in the document is not the `idp_issuer` of the tenant is refused, for the
same reason the gateway refuses it (§5 of the spec of the gateway).

### 6.2 The key of the mapping

The mapping key is `**(tenant, subject)**`:

```
users.tenant_id = the tenant of the login
users.external_subject = the `sub` of the provider
```

It is never the e-mail. An e-mail changes, is reused and is not unique;
a principal that is bound to one is not a principal, it is a guess.
Linking two external identities to one principal is a feature, and it is
deferred (§13).

### 6.3 The e-mail is a display value

The e-mail of the token is written in the row of the principal and it is
published in the token of Hub. It is **never** used to find a principal
and it is **never** used to authorize anything. The domain of an e-mail
selects a tenant only in the shared-client case (§5.2) and only as a
hint.

### 6.4 An unknown identity

When the mapping finds no row:

- the tenant has `auto_provision = true` → the row is created, with the
status `active`, **and with no grant at all**. The caller authenticates
and reaches nothing: the principal exists, the access does not. The
login succeeds and the first request is denied by §8.
- the tenant has `auto_provision = false` → the login is refused with
`403 identity_unknown` (§5.6).

The default is `false`: an identity that nobody registered does not get
an account because it managed to log in somewhere.

### 6.5 The principal of a decision

The `subject` of a decision request is the id of the row of the
principal. The row is found by its id; it is unique in the whole
platform, so the tenant of the principal is known without the request
carrying it. A subject that resolves to no row is a denial
(`the principal does not exist`).

---

## 7. The tokens of Hub

Hub is the provider of the gateway. The tokens it issues are ordinary
OpenID Connect tokens.

### 7.1 The claims of the id token


| Claim            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| `iss`            | The issuer of Hub.                                                        |
| `sub`            | The id of the principal.                                                  |
| `aud`            | The client id of the gateway of the tenant.                               |
| `exp`, `iat`     | Five minutes of life.                                                     |
| `nonce`          | The nonce of the login, when there was one.                               |
| `email`          | The e-mail of the principal, when it is known.                            |
| `name`           | The display name of the principal, when it is known.                      |
| `roles`          | The keys of the permissions of the active grants of the principal (§7.3). |
| `tid`            | The slug of the tenant.                                                   |
| `email_verified` | Always `false`: Hub does not verify the e-mail of a provider.             |


The gateway reads `sub`, `email` and `roles` and nothing else
(`SHUTTLE_OIDC_ROLES_CLAIM` is `roles` by default), so the claims above
are the whole contract with the gateway.

### 7.2 The access token

An access token is a JWT signed with `RS256`, with the issuer, the
audience (the client id), the subject, the scope and a life of five
minutes. It is accepted by the gateway in the `jwt` and `any` modes
(§5.4 of the spec of the gateway), because the gateway validates a bearer
token against the same provider it discovers for the browser.

There is **no refresh token**. The gateway does not use one, and a refresh
token is a credential that has to be revoked, stored and rotated. A
client that needs one asks for it: it is a feature, it is deferred.

### 7.3 The roles claim

The `roles` claim is the list of the keys of the permissions of the grants
of the principal that are alive at the moment the token is issued: not
revoked, not expired, with an enabled permission.

It is a **snapshot**. It is published for the upstreams of the deployment,
which receive it in the `x-shuttle-roles` header. It is **not** the
policy: the decision of §8 is computed over the table of grants, never
over the claim (§8.4).

The list is sorted and capped at 64 entries. A principal with more
permissions than that gets a token with the first 64 of them, and the
count of the rest is in the log.

### 7.4 The scopes

Hub accepts the scopes `openid`, `profile`, `email` and `groups`. A scope
that Hub does not know is ignored, not refused: the gateway asks for
`groups` by default (`SHUTTLE_OIDC_SCOPES`) and a broker that refused an
unknown scope would break a gateway that never changed.

### 7.5 The discovery document

`GET /.well-known/openid-configuration` is the document the gateway reads
once and caches for ten minutes. It carries at least:


| Field                                   | Value                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `issuer`                                | Exactly `HUB_ISSUER`. The gateway refuses a document whose issuer is not the one it was configured with. |
| `authorization_endpoint`                | `{HUB_PUBLIC_URL}/oauth/authorize`                                                                       |
| `token_endpoint`                        | `{HUB_PUBLIC_URL}/oauth/token`                                                                           |
| `jwks_uri`                              | `{HUB_PUBLIC_URL}/oauth/jwks`                                                                            |
| `userinfo_endpoint`                     | `{HUB_PUBLIC_URL}/oauth/userinfo`                                                                        |
| `response_types_supported`              | `["code"]`                                                                                               |
| `subject_types_supported`               | `["public"]`                                                                                             |
| `id_token_signing_alg_values_supported` | `["RS256"]`                                                                                              |
| `grant_types_supported`                 | `["authorization_code"]`                                                                                 |
| `scopes_supported`                      | `["openid","profile","email","groups"]`                                                                  |
| `code_challenge_methods_supported`      | `["S256"]`                                                                                               |
| `token_endpoint_auth_methods_supported` | `["client_secret_basic"]`                                                                                |


The `userinfo_endpoint` answers the claims of the principal of a bearer
token: `sub`, `email`, `name` and `roles`. A token that is expired, that
is signed with another key or that belongs to another audience is
`401`.

---

## 8. The decisions

This is the contract the gateway already speaks. It is described in §6 of
the spec of the gateway; it is repeated here because Hub has to implement
it exactly.

### 8.1 The request

```
POST {HUB_ISSUER}/v1/decisions
Authorization: Bearer {HUB_ACCESS_TOKEN}
Content-Type: application/json

{"subject":"…","workspaceId":"…","routeId":"…","roles":["…"]}
```

The four fields are the ones the gateway sends. Hub does not require a
field that the gateway does not send, and it does not refuse a field it
does not know: the request of the gateway is the request of the contract.

- A missing or wrong bearer token → `401 unauthorized`.
- A body that is not JSON, or a `subject` that is not a string → `400 bad_request`.
- A database that cannot be reached, or a query that takes longer than
`HUB_DECISION_TIMEOUT_MS` → `503 service_unavailable`.

Every one of these three is a **denial** for the gateway, because the
gateway fails closed on anything that is not a successful answer (§6 of
the spec of the gateway).

### 8.2 The answer

```
200 {"allow": true,  "reason": "allowed"}
200 {"allow": false, "reason": "the principal does not have the role of the workspace"}
```

The status is `200` for a decision, allow or deny. The reason is free
text and is **never** given to the caller: the gateway hides it (§6 of
the spec of the gateway). It exists for the operator, and it is in the log
of the service.

### 8.3 The rule

A principal may use a workspace on a route when there is at least one
grant that satisfies **all** of the following:


| Condition      | Rule                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| The principal  | `users.id = subject` and `users.status = 'active'`.                                                   |
| The tenant     | `users.tenant_id` names a tenant whose `enabled = true`.                                              |
| The grant      | `grants.user_id = users.id` and `grants.revoked_at is null`.                                          |
| The expiry     | `grants.expires_at is null` or `grants.expires_at > now()`.                                           |
| The permission | The permission of the grant is `enabled`.                                                             |
| The workspace  | `grants.workspace_id is null` (every workspace of the tenant) or `grants.workspace_id = workspaceId`. |
| The route      | `grants.route_id is null` (every route) or `grants.route_id = routeId`.                               |


A grant of one workspace does not grant another one. A grant of one route
does not grant another one. A grant without a workspace and without a
route is a grant of the whole tenant.

The query is a single statement over three tables, with the indexes of
§8.5.

### 8.4 The roles of the request

The `roles` of the request are **context, not policy**. The gateway
copies them from the token of the caller, and the token is a snapshot
(§7.3): a grant that is given after the token was issued would not be in
it, and a grant that is revoked would still be in it. A policy that read
the roles of the request would therefore allow a revoked grant until the
next login.

The rule of §8.3 reads the table and the table only. The roles of the
request are recorded in the log of the decision, and they are used for one
thing only: the **reason** of a denial names the roles the principal
holds, so the operator sees what the principal had.

The gateway counts a denial whose reason mentions a *role* as
`missing_role` and any other denial as `access_denied`
(§6 of the spec of the gateway). The reasons of Hub are chosen with that
in mind, so the metric of the gateway separates the two.

### 8.5 The indexes


| Index                                       | Serves                                       |
| ------------------------------------------- | -------------------------------------------- |
| `users (id)`                                | The primary key: the subject of the request. |
| `grants (user_id) where revoked_at is null` | The grants of the principal.                 |
| `permissions (id)`                          | The primary key.                             |


The query of §8.3 is `EXISTS`, so it stops at the first grant that
satisfies it.

### 8.6 The latency of a revocation

Hub does not cache a decision: the table is the truth and the query is
cheap. The latency of a revocation is therefore the one of the gateway:
the lifetime of its cache of the decisions,
`SHUTTLE_ACCESS_CACHE_TTL_MS` (5 s by default).

A route that declares `accessCacheTtlMs: 0` asks Hub for every request,
and a revocation is immediate on that route. Hub cannot make it faster:
the gateway does not ask it again, and changing that would be a change of
the gateway.

### 8.7 The reasons


| Situation                      | Reason                                                  |
| ------------------------------ | ------------------------------------------------------- |
| Allowed                        | `allowed`                                               |
| The subject is not a principal | `the principal does not exist`                          |
| The principal is disabled      | `the principal is disabled`                             |
| The tenant is disabled         | `the tenant is disabled`                                |
| No grant satisfies the rule    | `the principal does not have the role of the workspace` |
| A grant exists but it expired  | `the role of the workspace has expired`                 |


The last two contain the word *role*, so the gateway counts them as
`missing_role`.

---

## 9. The administration

Five endpoints. That is the whole administration surface of Hub: there is
no console, no portal and no second way to change a tenant, a principal or
a grant (§2.1, invariant 5).

### 9.1 The common rules

- Every endpoint is under `/v1/admin` and requires
`Authorization: Bearer $HUB_ADMIN_TOKEN`. A missing or wrong token →
`401 unauthorized`. The comparison is in constant time.
- The bodies are JSON, at most 64 KiB. A body that is larger → `413`.
- The answers are JSON. The errors are
`{"error": "<code>", "message": "<text>"}`.
- The calls are rate limited per address: a burst of failed authentications
is refused with `429`, so the admin token cannot be guessed by hammering
the endpoint.
- Every call is logged: the endpoint, the status, the address, and the
identifier of the thing that was changed. The secrets are never logged.

The error codes: `unauthorized`, `invalid_request`, `not_found`,
`conflict`, `forbidden`, `too_many_requests`.

### 9.2 `POST /v1/admin/tenants`

Creates a tenant, or updates the tenant of that slug.

```bash
curl -sS -X POST https://hub.example.com/v1/admin/tenants \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "slug": "acme",
        "displayName": "Acme Inc",
        "issuer": "https://login.acme.example",
        "idpClientId": "hub-acme",
        "idpClientSecret": "the-secret-of-the-provider",
        "idpRedirectUri": "https://hub.example.com/oauth/tenant/callback",
        "emailDomain": "acme.example",
        "clientId": "shuttle-acme",
        "clientSecret": "the-secret-of-the-gateway",
        "autoProvision": false,
        "sharedClient": false,
        "default": false,
        "enabled": true
      }'
```


| Field             | Rule                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `slug`            | Required. `[a-z0-9-]{2,63}`. The key of the row.                                        |
| `displayName`     | Required.                                                                               |
| `issuer`          | Required. The issuer of the provider of the tenant.                                     |
| `idpClientId`     | Required.                                                                               |
| `idpClientSecret` | Required. Encrypted at rest, never returned.                                            |
| `idpRedirectUri`  | Optional. Default `https://{HUB_PUBLIC_URL}/oauth/tenant/callback`.                     |
| `idpScopes`       | Optional. Default `["openid","email","profile"]`.                                       |
| `idpAlgorithms`   | Optional. Default `["RS256"]`.                                                          |
| `emailDomain`     | Optional. Unique when it is set.                                                        |
| `clientId`        | Required. The client id of the gateway of the tenant at Hub. Unique across the tenants. |
| `clientSecret`    | Required. Encrypted at rest, never returned.                                            |
| `autoProvision`   | Optional. Default `false`.                                                              |
| `sharedClient`    | Optional. Default `false`.                                                              |
| `default`         | Optional. Default `false`. At most one tenant is the default.                           |
| `enabled`         | Optional. Default `true`.                                                               |


The slug is the key: the call is an **upsert**. `201` when the tenant was
created, `200` when it was updated. A slug that belongs to another tenant
of the same client id → `409 conflict`. A `clientId` that belongs to
another tenant → `409 conflict`. A `default` that would make a second
tenant the default → `409 conflict`.

The answer carries no secret:

```json
{
  "id": "6f0f…", "slug": "acme", "displayName": "Acme Inc",
  "issuer": "https://login.acme.example", "emailDomain": "acme.example",
  "clientId": "shuttle-acme", "autoProvision": false, "sharedClient": false,
  "default": false, "enabled": true,
  "createdAt": "2026-01-08T10:00:00.000Z"
}
```

### 9.3 `GET /v1/admin/tenants`

The list of the tenants, with the number of their principals and of their
grants.

```bash
curl -sS https://hub.example.com/v1/admin/tenants \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"
```

```json
{
  "tenants": [
    {
      "id": "6f0f…", "slug": "acme", "displayName": "Acme Inc",
      "issuer": "https://login.acme.example", "emailDomain": "acme.example",
      "clientId": "shuttle-acme", "autoProvision": false, "sharedClient": false,
      "default": false, "enabled": true,
      "userCount": 42, "grantCount": 57,
      "createdAt": "2026-01-08T10:00:00.000Z"
    }
  ]
}
```

### 9.4 `POST /v1/admin/users`

Creates a principal, or updates the principal of that `(tenant, externalSubject)` pair. This is the endpoint that registers a caller
before its first login, and the one that disables a caller.

```bash
curl -sS -X POST https://hub.example.com/v1/admin/users \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "tenant": "acme",
        "externalSubject": "00u1a2b3c4d5",
        "email": "alice@acme.example",
        "displayName": "Alice",
        "status": "active"
      }'
```


| Field             | Rule                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| `tenant`          | Required. The slug of the tenant.                                               |
| `externalSubject` | Required. The `sub` of the provider of the tenant.                              |
| `email`           | Optional. The e-mail to publish in the token until the provider says otherwise. |
| `displayName`     | Optional.                                                                       |
| `status`          | Optional. `active` or `disabled`. Default `active`.                             |


The pair `(tenant, externalSubject)` is the key: the call is an
**upsert**. `201` when the principal was created, `200` when it was
updated. An unknown tenant → `404 not_found`.

```json
{
  "id": "b1c2…", "tenant": "acme", "externalSubject": "00u1a2b3c4d5",
  "email": "alice@acme.example", "displayName": "Alice", "status": "active",
  "lastLoginAt": null, "createdAt": "2026-01-08T10:05:00.000Z"
}
```

### 9.5 `PUT /v1/admin/grants`

Creates a grant, or updates the grant of that `(tenant, user, permission, workspace, route)` tuple.

```bash
curl -sS -X PUT https://hub.example.com/v1/admin/grants \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "tenant": "acme",
        "userId": "b1c2…",
        "permission": "workspace.read",
        "workspaceId": "11111111-1111-4111-8111-111111111111",
        "routeId": "workspace-api",
        "expiresAt": null
      }'
```


| Field         | Rule                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant`      | Required. The slug of the tenant.                                                                                                    |
| `userId`      | Required. The id of the principal. It must belong to the tenant.                                                                     |
| `permission`  | Required. The key of the permission. The permission row is **created on demand** when it does not exist, in the scope of the tenant. |
| `workspaceId` | Optional. `null` (the default) is every workspace of the tenant.                                                                     |
| `routeId`     | Optional. `null` (the default) is every route.                                                                                       |
| `expiresAt`   | Optional. `null` (the default) is a grant that does not expire. An ISO 8601 moment.                                                  |
| `grantedBy`   | Optional. Who grants it, for the audit log.                                                                                          |


A principal that belongs to another tenant → `403 forbidden`. A `userId`
that does not exist → `404 not_found`. A permission that exists in the
catalogue of the platform is reused; a permission that exists in another
tenant → `403 forbidden`.

The answer:

```json
{
  "id": "d3e4…", "tenant": "acme", "userId": "b1c2…",
  "permission": "workspace.read",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "routeId": "workspace-api", "expiresAt": null, "revokedAt": null,
  "createdAt": "2026-01-08T10:06:00.000Z"
}
```

### 9.6 `DELETE /v1/admin/grants/{id}`

Revokes a grant. The row is kept and stamped with `revoked_at`: the
history of the policy is worth more than the bytes, and a revoked grant
that is revived is not a grant that never existed.

```bash
curl -sS -X DELETE https://hub.example.com/v1/admin/grants/d3e4… \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -i
```

```
HTTP/1.1 204 No Content
```

The call is **idempotent**: a grant that is already revoked answers `204`
as well. An id that does not exist → `404 not_found`.

A revocation is visible to the gateway within
`SHUTTLE_ACCESS_CACHE_TTL_MS` (§8.6).

### 9.7 The whole session, in five calls

```bash
export HUB=https://hub.example.com
export HUB_ADMIN_TOKEN=…

# 1. the tenant and the registration of its gateway
curl -sS -X POST $HUB/v1/admin/tenants \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"slug":"acme","displayName":"Acme Inc","issuer":"https://login.acme.example",
       "idpClientId":"hub-acme","idpClientSecret":"…","clientId":"shuttle-acme",
       "clientSecret":"…","emailDomain":"acme.example"}'

# 2. the tenants, with their counts
curl -sS $HUB/v1/admin/tenants -H "authorization: Bearer $HUB_ADMIN_TOKEN"

# 3. the principal of the external identity
curl -sS -X POST $HUB/v1/admin/users \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"tenant":"acme","externalSubject":"00u1a2b3c4d5","email":"alice@acme.example"}'

# 4. the grant: the permission on the workspace, on the route
curl -sS -X PUT $HUB/v1/admin/grants \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"tenant":"acme","userId":"b1c2…","permission":"workspace.read",
       "workspaceId":"11111111-1111-4111-8111-111111111111","routeId":"workspace-api"}'

# 5. the revocation, when the access has to end
curl -sS -X DELETE $HUB/v1/admin/grants/d3e4… -H "authorization: Bearer $HUB_ADMIN_TOKEN"
```

---

## 10. The behavior of the decision, in the whole picture

The three paths a caller can take, and what each of them answers.


| Path                                           | Answer                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| The caller has a grant that satisfies the rule | `{"allow":true,"reason":"allowed"}`                                                |
| The caller has no grant                        | `{"allow":false,"reason":"the principal does not have the role of the workspace"}` |
| The caller is not a principal of Hub           | `{"allow":false,"reason":"the principal does not exist"}`                          |
| The database is down                           | `503` → the gateway denies, because it fails closed                                |


The gateway hides the reason from the caller and counts it: `allowed` is
not counted, a denial with *role* in the reason is `missing_role`, any
other denial is `access_denied` (§6 of the spec of the gateway).

---

## 11. The operations

### 11.1 The probes

`GET /healthz` answers `200 {"status":"ok","service":"hub","version":"0.1.0"}`
as long as the process is alive.

`GET /readyz` answers `200 {"status":"ready"}` when the database answers a
trivial query and the migrations are applied, `503 {"status":"draining"}`
during a drain and `503 {"status":"not-ready"}` otherwise.

### 11.2 The metrics


| Metric                          | Type      | Labels                                             |
| ------------------------------- | --------- | -------------------------------------------------- |
| `hub_decisions_total`           | counter   | `result` (`allow`, `deny`), `tenant`               |
| `hub_decision_duration_seconds` | histogram | `tenant`                                           |
| `hub_logins_total`              | counter   | `result` (`success`, `refused`, `error`), `tenant` |
| `hub_admin_requests_total`      | counter   | `endpoint`, `status`                               |
| `hub_store_errors_total`        | counter   | `store` (`redis`, `postgres`)                      |


The labels are bounded: the `tenant` label is capped at 100 values and
the rest is aggregated into `overflow`, exactly like the route label of
the gateway (§16 of the decisions of the gateway). Neither a caller nor a
provider can grow the number of series without limit.

### 11.3 The logs

Structured JSON, one line per event, with the redacted fields. The events
are: the login (tenant, outcome, the reason of a refusal), the decision
(subject, workspace, route, allow or deny, the reason), the
administration (endpoint, status, the identifier of the thing that
changed) and the lifecycle of the process.

The redaction is the one of the gateway: a token, a secret, a cookie and
an `Authorization` header never reach a log line.

### 11.4 The drain

On `SIGTERM` the readiness probe answers `503` with the body `draining`,
the listener stops accepting new work, the running logins are given five
seconds to finish, and the process exits. A decision that is running when
the deadline is reached is a denial.

---

## 12. What does not change in Shuttle

This is the point of the whole design, so it is written as a list of
things that are **not** touched.


| In Shuttle                                                                                                                       | Status                                                       |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| The format of the route table (`config/routes.json`)                                                                             | Unchanged.                                                   |
| The environment of the gateway (`SHUTTLE_*`)                                                                                     | Unchanged. No new variable.                                  |
| The single provider (`SHUTTLE_OIDC_ISSUER`, `SHUTTLE_OIDC_CLIENT_ID`, `SHUTTLE_OIDC_REDIRECT_URI`, `SHUTTLE_OIDC_CLIENT_SECRET`) | Unchanged. They name Hub.                                    |
| The single access service (`SHUTTLE_ACCESS_URL`, `SHUTTLE_ACCESS_TOKEN`)                                                         | Unchanged. They name Hub.                                    |
| The contract of the decision (`POST /v1/decisions`, `{subject, workspaceId, routeId, roles}` → `{allow, reason}`)                | Unchanged. Hub implements it as it is.                       |
| The cache of the decisions of the gateway                                                                                        | Unchanged. Its TTL is the latency of a revocation.           |
| The headers of the identity, the signature, the sessions, the limits, the WebSockets                                             | Unchanged.                                                   |
| The routes, the upstreams, the workspaces                                                                                        | Unchanged. They belong to the deployment, not to the broker. |
| The code of the gateway                                                                                                          | **No commit.**                                               |


### 12.1 The configuration of a deployment

```
SHUTTLE_OIDC_ISSUER=https://hub.example.com
SHUTTLE_OIDC_CLIENT_ID=shuttle-acme
SHUTTLE_OIDC_CLIENT_SECRET=the-secret-of-the-gateway
SHUTTLE_OIDC_REDIRECT_URI=https://shuttle-acme.example.com/auth/callback
SHUTTLE_OIDC_SCOPES=openid,profile,email,groups
SHUTTLE_OIDC_ROLES_CLAIM=roles

SHUTTLE_ACCESS_URL=https://hub.example.com
SHUTTLE_ACCESS_TOKEN=the-access-token-of-hub
```

The gateway discovers Hub, reads its JWKS, exchanges the code at its
token endpoint and asks it for the decisions. It cannot tell that Hub is
in front of several identity providers, and it does not have to.

### 12.2 The two configurations that have to agree


| On the side of Hub         | On the side of Shuttle                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_ISSUER`               | `SHUTTLE_OIDC_ISSUER` — they must be the **same** url, character for character. The gateway refuses a discovery whose issuer is not the one it was configured with (§5 of the spec of the gateway). |
| `tenants.client_id`        | `SHUTTLE_OIDC_CLIENT_ID`                                                                                                                                                                            |
| `tenants.client_secret`    | `SHUTTLE_OIDC_CLIENT_SECRET`                                                                                                                                                                        |
| `tenants.idp_redirect_uri` | —                                                                                                                                                                                                   |
| `HUB_ACCESS_TOKEN`         | `SHUTTLE_ACCESS_TOKEN`                                                                                                                                                                              |


### 12.3 What the gateway learns from Hub, and what it does not

The gateway learns the identity of the caller: the subject, the e-mail and
the roles. It does not learn the tenant, the grants or the permissions:
they are not claims of the token and the gateway does not read them.

The tenant is in the `tid` claim for the operator and for the future. The
gateway ignores it, and that is fine: the decision of §8 does not need
it, because the subject names the principal and the principal names its
tenant.

---

## 13. The deferred features

Everything below is **deferred**. A deferred feature has no column, no
table, no flag, no endpoint and no code. The schema does not reserve
anything for it, because a column that is always `null` is a column that
somebody will read as a feature.

The rule that brings one of them back: **a named customer pays for it.**
Not "it seems useful", not "it is on the roadmap", not "it is standard".


| Deferred            | What it would mean                                                                | What is missing without it                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **SAML**            | A tenant whose provider speaks SAML instead of OpenID Connect.                    | A tenant whose provider is not an OIDC provider is not served. The provider of a tenant is OpenID Connect and only OpenID Connect.  |
| **Account linking** | One principal, several external identities (a second provider, a second subject). | The mapping key is `(tenant, subject)`, and it is one to one. A person with two accounts has two principals and two sets of grants. |
| **The console**     | A web interface for the administration.                                           | The five endpoints of §9 and `curl`.                                                                                                |
| **SCIM**            | The provisioning of the principals by a provider.                                 | The principals are created by the endpoint of §9.4, or by the auto-provisioning of the tenant.                                      |
| **Directory sync**  | The import of the directory of a tenant, on a schedule, from a source of truth.   | The principals are created one at a time, by hand or by a script that calls the endpoints.                                          |


The list is not exhaustive and it is not a promise. The point of writing
it down is that the four tables of §3 are the whole model, and that a
feature that needs a fifth table is a feature that has to be paid for
before it is designed.

---

## 14. The verification

A rule that has no test is a rule that is not implemented.


| Kind          | Where                         | What it proves                                                                                                                                                                                                                                                                    |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit          | `src/domains/*/*.test.ts` | The validation of the token of a provider, the mapping, the rule of the decision, the resolution of the tenant.                                                                                                                                                                   |
| Contract      | `test/contract/`          | The whole flow against the fixtures of Hub: the login of a browser, the exchange of the code, the decision, the five administrative endpoints.                                                                                                                         |
| Integration   | `test/integration/`       | The decisions against a real PostgreSQL and a real Redis, and a deployment with two replicas.                                                                                                                                                                                     |
| Compatibility | `test/compatibility/`     | **The gateway, unchanged, against Hub.** The fixtures of the Shuttle reference (`services/oidc-provider.ts`, `services/access-fixture.ts`) are replaced by Hub, and the contract suite of the gateway (`test/contract/`) is run against it. This is the test that proves the claim of §12. |
| Architecture  | `test/architecture/`      | The import boundaries of Hub, the way the gateway has them.                                                                                                                                                                                                                       |


### 14.1 The compatibility test, in detail

The gateway is started with its own configuration and with the fixtures
replaced by Hub:

```
SHUTTLE_OIDC_ISSUER   = the issuer of Hub
SHUTTLE_OIDC_CLIENT_ID= the client id of the tenant
SHUTTLE_ACCESS_URL    = the base url of Hub
SHUTTLE_ACCESS_TOKEN  = the access token of Hub
```

The suite asserts:

1. a browser logs in at the provider of the tenant and comes back to the
 gateway with a session;
2. the gateway writes the `x-shuttle-user`, the `x-shuttle-email` and the
 `x-shuttle-roles` headers with the values of the principal;
3. a request with a grant on the workspace is forwarded, and a request
 without one is refused with `403 workspace_forbidden`;
4. a grant that is revoked is refused within the TTL of the cache of the
 gateway;
5. the metrics of the gateway count the denial as `missing_role`.

**The gateway is not modified for any of these tests.** If one of them
needs a change in the gateway, the change is a change of the gateway, and
it is refused: the compatibility test exists to prove that there is none.

---

## 15. The layout of the code

Hub is a modular monolith of its own, with the same rules as the gateway.


| Path                              | Owns                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                 | The entry point of the process.                                                                                             |
| `src/app/`                    | The HTTP application: thin handlers, the order of the pipeline, the mapping of the failures to the answers of the protocol. |
| `src/domains/identity/`       | The validation of the token of a provider, the mapping to a principal, the resolution of the tenant.                        |
| `src/domains/authorization/`  | The rule of the decision, the reading of the grants, the reasons.                                                           |
| `src/domains/administration/` | The five endpoints, the validation of their bodies, the audit log.                                                          |
| `src/domains/provider/`       | The tokens of Hub: the signing, the JWKS, the discovery document, the code, the exchange.                                   |
| `src/platform/postgres/`      | The client of the database, the migrations.                                                                                 |
| `src/platform/redis/`         | The shared store of the authorization codes.                                                                                |
| `src/platform/bun/`           | The listener and the outbound HTTP.                                                                                         |
| `src/runtime/`                | The environment, the composition root, the signals and the drain.                                                           |
| `src/observability/`          | The logs, the metrics, the redaction.                                                                                       |


The rules are the rules of the gateway (`docs/architecture.md` of the
Shuttle repository, "The rules of the work"): a domain imports
nothing but the public entry points of the domains it may use, the
adapters are assembled by the composition root, and a rule that has no
test is not implemented.

---

## 16. The decisions


| #   | Question                                                              | Decision                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Where does the multi-tenancy live?                                    | In Hub, never in Shuttle. Shuttle keeps one provider and one access service, so one Shuttle deployment serves one tenant of Hub (§1.4).                                                                    |
| 2   | Is Hub a provider or a client of OpenID Connect?                      | Both: a client of the provider of the tenant and a provider for the gateway. The gateway does not have to know.                                                                                            |
| 3   | What is the key of the mapping of an identity?                        | `(tenant, subject)`. Never the e-mail: an e-mail is mutable and is not an identity (§6.2).                                                                                                                 |
| 4   | Is a principal created at the first login?                            | Only when the tenant has `auto_provision = true`, and it has no grant: the login succeeds and the access does not (§6.4).                                                                                  |
| 5   | What decides an access?                                               | The table of grants, and nothing else. The roles of the request are context, because they are a snapshot of the token and a policy that read them would allow a revoked grant until the next login (§8.4). |
| 6   | Is a decision cached by Hub?                                          | No. The table is the truth, the query is an `EXISTS` over three indexed tables, and the latency of a revocation is the TTL of the cache of the gateway (§8.6).                                             |
| 7   | How many administrative endpoints?                                    | Five. They are the whole surface, and the reason a tenant, a principal and a grant can only be changed through them is that the audit log is complete (§9).                                                |
| 8   | Why is the authorization code stored instead of being self-contained? | A self-contained code can be redeemed twice inside its life. The store makes it single use, which is the property the gateway relies on (§5.5).                                                            |
| 9   | Why are there no refresh tokens?                                      | The gateway does not use one. A refresh token is a credential to store, rotate and revoke; it is a feature, it is deferred (§7.2).                                                                         |
| 10  | Why is the reason of a denial free text?                              | The gateway hides it and only counts it. The vocabulary of the reasons is chosen so the count of the gateway separates a missing role from any other denial (§8.7).                                        |


---

## 17. The open questions


| #   | Question                                              | Why it is open                                                                                                                                                |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | May the shared client be enabled at all?              | It moves the tenant of a login to a hint that the caller controls. It is refused by default and it is the only way to serve several tenants from one gateway. |
| 2   | Is the `roles` claim of the token the right list?     | It is a snapshot and it is published for the upstreams. A deployment with many grants per principal will want a different list.                               |
| 3   | Does a grant need a scope on the path of the request? | The decision contract does not carry one, and the contract does not change. A grant is a workspace and a route, which is the granularity the gateway knows.   |
| 4   | Is the expiry of a grant worth it?                    | It is in the model because a temporary access is a real thing, and it costs one comparison in the query.                                                      |


