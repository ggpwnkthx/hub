# Hub — Specification

**Hub** is a Bun service that brokers the login of a caller against the
OpenID Connect provider of a tenant, maps the external identity of the
caller to a principal row, answers the decision requests of a gateway over
a table of grants, and offers nine `curl` endpoints for the administration
of the whole thing, and one that reads the audit of the changes.

Hub is **not** a feature of Shuttle. It is a separate deployable that sits
between the browsers, the identity providers of the tenants and the
gateways. Shuttle is not changed: it keeps its single provider, its single
access service and its whole configuration, and it gains **zero** new
features. Hub is what a Shuttle deployment points at.

This document is **normative** for the behavior of Hub. The bodies of the
requests and of the answers are in [api.md](api.md); the code is in
`src/`; the way it is built is in [architecture.md](architecture.md). A
change of behavior is a change of this document first, in the same commit
as the code.

Status: 1.0.1. Runtime: Bun ≥ 1.4.3. Listener: HTTP on
`HUB_HOST:HUB_PORT` (default `0.0.0.0:8081`).

---

## 1. Scope

### 1.1 What Hub does

| | |
| --- | --- |
| **Brokers the login** | Hub is the OpenID Connect client of the provider of a tenant *and* the OpenID Connect provider of the gateway. The browser logs in at the provider of the tenant; the gateway sees a provider it already knows how to talk to. |
| **Maps the identity** | The `(tenant, subject)` pair of the provider is mapped to exactly one **principal row**. The row is the identity of the platform; the external identity is only the way in. |
| **Answers the decisions** | Hub implements the decision contract the gateway already speaks: `POST /v1/decisions`. The decision is computed over a table of **grants**. |
| **Is administered with nine endpoints** | A tenant, a principal, a grant and a group are created, revoked and **listed** with nine `curl` calls, and the audit of the changes is read with a tenth. There is no console, no portal and no wizard. |

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
It cannot tell that Hub is a broker in front of several identity
providers, and it must not have to: that is the whole point of the design.

### 1.4 The consequence that has to be said out loud

A gateway is configured with **one** client id and **one** redirect uri.
The tenant of a login is therefore resolved from the client id of the
authorization request (§5.2), and a client id belongs to exactly one
tenant: the `client_id` of the tenants is unique (§3.1).

The supported topology is therefore:

- **one Shuttle deployment per tenant**, each registered at Hub as the
  client of that tenant; or
- **one Shuttle deployment for several tenants**, when the tenants are
  registered under the client id of that one gateway. The schema does
  not allow it: the `client_id` of a tenant is unique, and two tenants
  cannot hold the same one.

Hub is multi-tenant; Shuttle is not. That is not a gap in the design, it
is the price of "Shuttle gains zero new features", and it is paid on the
side of Hub, which is where the tenancy belongs.

**The escape hatch (§5.2).** A tenant registered with `shared_client =
true` lets the gateway of that tenant log in the principals of the
**other** tenants: the request names the tenant, or the hint of the
e-mail names it. The client id is still the one of the gateway, and it
is still unique: the gateway presents its own client id, and the tenant
of the login is another one. It is a deliberate weakening — a hint that
the caller controls may move a login to another tenant — and it is
refused by default.

---

## 2. Terms

| Term | Meaning |
| --- | --- |
| **tenant** | A customer of the platform. It owns one identity provider, one principal population and one set of grants. |
| **provider (of a tenant)** | The OpenID Connect provider of the tenant. Exactly one per tenant. |
| **principal** | The row of `users` that carries the identity of a caller inside the platform. It is the `subject` of every token Hub issues and the `subject` of every decision request. |
| **permission** | A named capability, e.g. `workspace.read`. It is a *role* of the platform: it travels in the `roles` claim and it is what a grant gives. |
| **grant** | The permission a principal holds, on a workspace, on a route, until it is revoked or it expires. |
| **decision** | The answer of `POST /v1/decisions`: may this principal use this workspace on this route? |
| **gateway** | A Shuttle deployment. It is a client of Hub and a consumer of the decisions. |
| **operator** | The person who runs Hub and calls the nine administrative endpoints. |

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
   Five of them change something, four read a list and one reads the
   audit of the changes; nothing else writes.
6. **Every change is audited, and the audit is durable.** The change and
   the row of the audit are written by **one statement**, so they are
   committed together or neither is: a change that is not audited does
   not exist. The row names the operator by the fingerprint of its
   credential. A log line is not the audit: the audit is a table (§10.1).
7. **A secret is never returned, never logged and never travels in a
   browser.** The client secret of a provider, the client secret of a
   gateway and the tokens are write-only.
8. **A gateway never learns a reason.** The reason of a decision is for
   the operator; the gateway does not forward it to a caller, and neither
   does Hub.
9. **The contract of the gateway does not change.** Hub answers the
   decision request the gateway already sends, with the body it already
   sends (§8).

---

## 3. The five tables

The whole domain model of Hub is five tables. They are read in one sitting
and they are the only tables: the protocol state that is not a domain
concept (the authorization codes) lives in the shared store (§5.5), not in
the database.

Two tables of the **infrastructure** live in the same database and are
not part of the domain model: the table of the migrations
(`hub_schema_migrations`) and the table of the **audit** of the
administration (`admin_audit`, §10.1). The audit holds no tenant, no
principal and no grant: it holds what changed, when, and who changed it.

The schema itself is in `src/platform/postgres/migrations/`.

### 3.1 `tenants`

One row per customer. It carries the registration of the provider of the
tenant and the registration of the gateway of the tenant.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `slug` | `text` | The stable name of the tenant, `[a-z0-9-]{2,63}`. Unique. The key of the row. |
| `display_name` | `text` | The name shown to a human. |
| `enabled` | `boolean` | Default `true`. A disabled tenant denies every decision and refuses every login. |
| `is_default` | `boolean` | Default `false`. At most one tenant is the default (§5.2). |
| `auto_provision` | `boolean` | Default `false`. Whether an unknown external identity creates a principal row on its first login (§6.4). |
| `email_domain` | `text` | The domain of the tenant, `null` when it has none. Unique when it is set. A **hint**, never an authorization (§5.2, §6.3). |
| `idp_issuer` | `text` | The issuer of the provider of the tenant. The `iss` of a token that does not match it exactly is refused. |
| `idp_client_id` | `text` | The client id of Hub at the provider of the tenant. |
| `idp_client_secret` | `bytea` | The client secret of Hub at the provider, encrypted at rest (§4.3). |
| `idp_redirect_uri` | `text` | The url of Hub at the provider of the tenant. It must be the url of §5.1. |
| `idp_scopes` | `text[]` | The scopes Hub asks the provider for. Default `['openid','email','profile']`. |
| `idp_algorithms` | `text[]` | The algorithms a token of the provider may be signed with. Default `['RS256']`. |
| `client_id` | `text` | The client id of the **gateway** of the tenant at Hub. Unique across the tenants. |
| `client_redirect_uris` | `text[]` | The urls the gateway of the tenant is registered with. The browser is sent back to one of them with the code of the login; a url that is not in the list is never sent a code (§5.2). Default `[]`: a tenant that has registered no url refuses every login. |
| `client_secret` | `bytea` | The secret of the gateway of the tenant, encrypted at rest (§4.3). |
| `previous_client_secret` | `bytea` | The secret that the current one replaced, encrypted at rest. `null` when there was no rotation. |
| `previous_client_secret_until` | `timestamptz` | The moment the previous secret stops being accepted. `null` when there was no rotation. |
| `shared_client` | `boolean` | Default `false`. Whether the gateway of this tenant may log in principals of other tenants (§5.2). |
| `created_at`, `updated_at` | `timestamptz` | |

### 3.2 `users`

One row per principal. It is the identity of the platform.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | Primary key. The `sub` of every token Hub issues and the `subject` of every decision request. |
| `tenant_id` | `uuid` | The tenant of the principal. Foreign key to `tenants`. |
| `external_subject` | `text` | The `sub` of the provider of the tenant. |
| `email` | `text` | The last e-mail seen at the provider. `null` when the provider does not publish one. A display value, never a key. |
| `display_name` | `text` | The last name seen at the provider. |
| `status` | `text` | `active` or `disabled`. Default `active`. A disabled principal is refused at the login and denied at every decision. |
| `last_login_at` | `timestamptz` | The last successful login. `null` before the first one. |
| `created_at`, `updated_at` | `timestamptz` | |

Unique: `(tenant_id, external_subject)`. The pair `(id, tenant_id)` is
unique as well, so a grant can carry its tenant in a foreign key (§3.4).

### 3.3 `permissions`

A named capability: it travels in the `roles` claim of a token and it is
what a grant gives.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `tenant_id` | `uuid` | The tenant that owns the permission, or `null` when it belongs to the catalogue of the platform. Foreign key to `tenants`. |
| `key` | `text` | The name of the permission, `[a-z0-9][a-z0-9._-]{0,63}`. |
| `description` | `text` | `null` when there is none. |
| `enabled` | `boolean` | Default `true`. A disabled permission is never given by a grant. |

Unique: `(coalesce(tenant_id, '000…0'::uuid), key)`. The `coalesce` is
there because `null` is not equal to `null` in a unique index of
PostgreSQL, and the catalogue of the platform would otherwise accept two
rows with the same key.

A permission of the catalogue (`tenant_id is null`) may be granted to every
tenant. A permission of a tenant may only be granted inside that tenant.

**A key is a name inside a tenant.** Two tenants may hold a permission of
the same key, and each one has its own row: the unique index is on
`(coalesce(tenant_id, '000…0'::uuid), key)`, so the rows live side by
side. The permission of another tenant is never the permission of this
one, and a grant never names it: the row of the tenant is created on
demand (§10.6).

### 3.4 `grants`

The policy of the platform. A grant says: this principal — or this group
of principals — holds this permission, on this workspace, on this route,
until this date.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `tenant_id` | `uuid` | The tenant of the grant. Foreign key to `tenants`. |
| `user_id` | `uuid` | The principal of the grant, or `null` when the grant names a group. Foreign key to `(id, tenant_id)` of `users`: **a grant can never name a principal of another tenant**. |
| `group_id` | `uuid` | The group of the grant, or `null` when the grant names a principal. Foreign key to `(id, tenant_id)` of `groups`: **a grant can never name a group of another tenant**. |
| `permission_id` | `uuid` | The permission of the grant. Foreign key to `permissions`. |
| `workspace_id` | `text` | The workspace of the grant, or `null` for every workspace of the tenant. Hub keeps the value as it is given: a workspace that is not a UUID simply matches no workspace-scoped grant. |
| `route_id` | `text` | The route of the grant, or `null` for every route. |
| `expires_at` | `timestamptz` | `null` when the grant does not expire. |
| `revoked_at` | `timestamptz` | `null` while the grant is alive. A revoked grant is kept, it is not deleted. |
| `granted_by` | `text` | Who granted it, for the audit log. `null` when it is not known. |
| `created_at` | `timestamptz` | |

A grant names **exactly one** subject: a principal or a group. The check
`(user_id is null) <> (group_id is null)` is in the schema, and it is not a
rule of the application that can be forgotten.

Unique among the live grants: `(tenant_id, user_id, permission_id,
coalesce(workspace_id,''), coalesce(route_id,''))` for the grants that name
a principal, and the same tuple on `group_id` for the grants that name a
group. The `coalesce` is there for the same reason as in §3.3.

### 3.5 `groups`

A group is a set of principals of a tenant. A grant may name a group
instead of a principal: the grant then holds for every principal of the
group.

A group of Hub is **not** the `groups` scope of the provider (§7.4): the
scope asks the provider for the groups of the caller, a group of Hub is a
set of principals of the tenant that the policy is written on.

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `tenant_id` | `uuid` | The tenant of the group. Foreign key to `tenants`. |
| `key` | `text` | The name of the group, `[a-z0-9][a-z0-9._-]{0,63}`. |
| `display_name` | `text` | `null` when there is none. |
| `members` | `uuid[]` | The principals of the group: their ids. Every member is a principal of the tenant at the moment the membership is written. The administration speaks in external subjects (§10.9) and the adapter translates them. The database checks it: a constraint trigger refuses a member that is not a principal of the tenant of the group. |
| `created_at`, `updated_at` | `timestamptz` | |

Unique: `(tenant_id, key)`. The pair `(id, tenant_id)` is unique as well,
so a grant can carry the tenant of its group in a foreign key (§3.4).

The membership is **replaced** by the call of the administration (§10.9):
the members of the list are the members of the group, and the principals
that are not in the list are not in the group any more.

The membership is checked by the **database** and not only by the
application: a list of ids has no foreign key, so a constraint trigger
checks every member when the group is written, and refuses the one that
is not a principal of the tenant of the group. The check is deferred to
the end of the transaction, so a principal that is created in the same
transaction is seen. The refusal of the database is the same `404` that
the administration gives when it finds the member before the write
(§10.9): the constraint is the backstop of the rule of the application,
not its replacement.

The membership is indexed: the question that the decision asks is "which
groups hold this principal", and the predicate that answers it is a
containment (`groups.members @> array[principal]`), which a **GIN index**
serves. Without it, every decision that reads a grant of a group walks
the groups of the tenant and reads every member list of them (§8.5).

### 3.6 The diagram

```
  tenants ────< users ────< grants >──── permissions
     │              │          (tenant_id may be null)
     │              │
     │              └──< groups (the principals of the group)
     │
     └── the registration of the provider and of the gateway
```

### 3.7 The migrations

The schema is created by plain SQL files, applied in the order of their
names, by one runner that takes an advisory lock so two replicas that
start at the same time do not apply the same migration twice. A migration
that fails stops the process: Hub does not start against a schema it does
not understand.

There is no table "for later": a feature that needs one is a feature that
is deferred until a customer pays for it (§14).

The bookkeeping of the migrations lives in a table of the infrastructure,
`hub_schema_migrations`. It holds the name of the migrations that were
applied and nothing else. It exists because the runner has to know what
the schema of the database is: a database that holds a migration this
version of Hub does not know is a schema Hub does not understand, and the
process refuses to start against it.

The runner reads the schema from the directory of the migrations of the
tree (`src/platform/postgres/migrations/`), and, when that directory is
not there, from the directory `migrations/` next to the executable: a
compiled binary carries no directory, and the schema of the release is
deployed with it. A service that does not find the schema refuses to
start and names the directory it looked in.

### 3.8 The database of a development machine

The database of Hub is PostgreSQL. The driver is named by
`HUB_DATABASE_URL`:

| The value | The database |
| --- | --- |
| `postgres://…` or `postgresql://…` | A PostgreSQL server. |
| `pglite://<path>` | The embedded PostgreSQL of the process, in `<path>`. |
| Nothing, in a development environment | The embedded PostgreSQL of the process, in `./.hub/pglite`. |

The embedded PostgreSQL is `pglite`: PostgreSQL compiled to WebAssembly,
running in the process of Hub. It is the same PostgreSQL as the one of a
deployment, so a development machine applies the migrations of the
production and nothing has to be translated between the two.

The repository is developed and tested against **PostgreSQL 18**: the
compose file of a development machine, the jobs of the CI and the gates
of the release run it, and the embedded PostgreSQL is that version. A
deployment names the server it uses in `HUB_DATABASE_URL`, and the
service does not read the version of that server: the version of the
database of a deployment is the choice of the operator.

A **production** environment must name a PostgreSQL server: the embedded
database lives in one process and the replicas of a deployment share their
tables. A production environment that names the embedded database is
refused at the start.

The tests run on the embedded database by default. A workflow that has a
server names it in `HUB_TEST_DATABASE_URL` and the same tests run against
it.

### 3.9 The isolation of the tenants

The tenants are isolated by the application: the keys of the five tables
carry the tenant, the foreign key of a grant refuses a principal of
another tenant, and every statement that reads a tenant reads it by its
id.

The database is the **backstop** of that isolation. The five tables have
the row level security of PostgreSQL, and their policy is the tenant of the
statement:

- A statement that is **not** scoped to a tenant (the administration, the
  decision of the bearer token of the deployment) sees the whole platform.
- A statement that is **scoped** to a tenant runs in the scope of that
  tenant, and it sees the rows of that tenant and nothing else. The scope
  is the setting `hub.tenant_id`, and it is local to the transaction: a
  pooled connection never carries the scope of another request.

The **empty** scope is the scope of the platform. PostgreSQL reverts a
local setting when its transaction ends, and it leaves the placeholder of
the setting on the session: `hub.tenant_id` is empty, and not unset, on
every connection that has run a scoped statement. A connection of a pool
is a connection that is reused, so the empty scope is the normal state of
a connection of a deployment, and the statements of the platform see the
platform on it.

A statement that forgets the tenant in its text is therefore refused by
PostgreSQL itself, and not only by the review of the code.

The policies are only policies for a role that is **subject** to them: a
superuser and a role with `BYPASSRLS` are not. A **production**
deployment therefore refuses to start with such a role: the isolation
would be a promise and not a rule. The role of the deployment is a role
that owns the tables of the platform and that is not a superuser.

---

## 4. The environment

The environment is read once, at the start of the process, and validated as
a whole: a value that cannot be understood stops the service. The only
exception is the level of the log, which falls back to `info`. The
readable list with the values of a development machine is in `.env.example`.

| Variable | Why |
| --- | --- |
| `HUB_HOST` | The address of the listener. Default `0.0.0.0`. |
| `HUB_PORT` | The port of the listener. Default `8081`. |
| `HUB_ISSUER` | The public issuer url of Hub. It is the `iss` of every token it issues and the issuer the gateway is configured with. It must be the url the browser and the gateway use. |
| `HUB_PUBLIC_URL` | The public url of Hub, when it differs from the issuer. Default: the issuer. |
| `HUB_DATABASE_URL` | The PostgreSQL of the five tables. A server in a deployment, the embedded one on a development machine (§3.8). |
| `HUB_REDIS_URL` | The shared store of the authorization codes. Required when more than one replica runs. |
| `HUB_ALLOW_MEMORY_STATE` | Replaces the shared store with the memory of the process. A single-node deployment only. |
| `HUB_ADMIN_TOKEN` | The bearer token of the nine administrative endpoints. |
| `HUB_ADMIN_TOKENS` | The credentials of the administration: a json object of bearer tokens and of their scopes (§4.6). |
| `HUB_PREVIOUS_ADMIN_TOKEN` | The token that the current one replaced. It is accepted until the deployment removes it (§4.3.1). |
| `HUB_ACCESS_TOKEN` | The bearer token the gateway presents on `POST /v1/decisions`. Optional, and deprecated: without it, only the credentials of a tenant are accepted (§8.8). |
| `HUB_PREVIOUS_ACCESS_TOKEN` | The token that the current one replaced. It is accepted until the deployment removes it (§4.3.1). It is refused when the token it replaced is not set. |
| `HUB_ACCESS_CONTEXT_TOKENS` | The credentials of the access context contract (§9): a JSON object whose keys are bearer tokens and whose values are the tenants every token may ask about. A `null` value is a credential of the platform. |
| `HUB_STATE_SECRET` | Signs and encrypts the state of a login (§5.3). 32 bytes at least. The same value on every replica. |
| `HUB_SECRET_ENCRYPTION_KEY` | Encrypts the client secrets at rest (§4.3). 32 bytes at least. |
| `HUB_SIGNING_KEY` | The private key of Hub, in PEM. The public part is published at `/oauth/jwks`. |
| `HUB_SIGNING_KID` | The identifier of the key in the JWKS. |
| `HUB_PREVIOUS_SIGNING_KEY` | The private key of the previous rotation, in PEM. It stays published in the JWKS until the last token it signed has expired (§4.2). |
| `HUB_PREVIOUS_SIGNING_KID` | The identifier of the previous key in the JWKS. |
| `HUB_IDP_TIMEOUT_MS` | How long Hub waits for the provider of a tenant. Default `5000`. |
| `HUB_DECISION_TIMEOUT_MS` | How long a decision may take before it is a denial. Default `2000`. It is also the deadline of the statements of the pool (§8.3). |
| `HUB_CLOCK_SKEW_SECONDS` | The tolerance of the clock on the tokens of a provider. Default `60`. |
| `HUB_METRICS_TOKEN` | The bearer token of the metrics endpoint. Without it the endpoint is not served. |
| `HUB_LOG_LEVEL` | `debug`, `info`, `warn` or `error`. Default `info`. |
| `HUB_ENVIRONMENT` | `development` or `production`. The fixtures refuse to run in production. |
| `HUB_<NAME>_FILE` | The file that holds the value of `HUB_<NAME>`, for every secret of the environment (§4.5). |

### 4.1 The secrets

The two tokens of the service are compared in constant time. They are read
from the environment and never written to a log.

**A bearer token is at least 16 bytes long.** Every token of the
environment — `HUB_ADMIN_TOKEN`, `HUB_PREVIOUS_ADMIN_TOKEN`,
`HUB_ACCESS_TOKEN`, `HUB_PREVIOUS_ACCESS_TOKEN` and `HUB_METRICS_TOKEN` —
is measured in the bytes it is compared in: a token of one character
protects the administration of the platform as well as a token of thirty
two characters protects it, because the length of a secret is the first
thing that is tried. A production deployment refuses to start when one of
its tokens is shorter (§4.4). The length of the two secrets of the
signing and of the encryption is 32 bytes (§4.4).

**The values of the example are not secrets.** A production deployment
refuses to start when one of its secrets is a value of `.env.example` or
a secret that is one repeated character (`000…0`, `111…1`, `aaaa…`),
whatever its length. A deployment that copies the example of a
development machine into a production one must not start with the
secrets of the example: the example is published, and so is every
deployment that kept it.

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
the operator, in one transaction (`scripts/rotate-secrets.ts`).

The key of the encryption is derived from the secret of the deployment
with HKDF-SHA256, so the secret may be a passphrase, a hexadecimal string
or a base64 string, and the key of the encryption is always 32 bytes.

The stored ciphertext carries the version of its format, so a change of
the format is a version and not a migration of the column:

| Bytes | What they hold |
| --- | --- |
| `1` | The version of the format (currently `1`). |
| `12` | The nonce of the encryption. |
| The rest | The body and the tag of the encryption. |

A service without `HUB_SECRET_ENCRYPTION_KEY` does not store the client
secrets in clear: it refuses to write a tenant and says so.

### 4.3.1 The rotation of a secret

A secret that a client presents is rotated without a window in which the
client and Hub disagree.

**The secret of the gateway of a tenant.** The call of the administration
that changes the secret of a tenant keeps the secret it replaces for
**24 hours**. Both secrets are accepted until the window is over: the
gateway is changed first, the tenant is changed second, and the old
secret is dropped by the deployment that owns it. The window is the
rotation, not a second credential.

A call that presents the secret that is already in use is **not** a
rotation: it does not close the window of the rotation that is in
flight. An unrelated change of a tenant does not shorten the window of
the secret of its gateway.

**The token of the decisions and the token of the administration.** They
are read from the environment, and the environment holds the one that is
in use and, during a rotation, the one it replaced:

| Variable | What it holds |
| --- | --- |
| `HUB_ACCESS_TOKEN` | The token that the gateway presents on `POST /v1/decisions`. Optional: without it, only the credentials of a tenant are accepted (§8.8). |
| `HUB_PREVIOUS_ACCESS_TOKEN` | The token that the current one replaced. It is accepted until the deployment removes it. It is refused without the token it replaced: a deployment that removes the shared secret removes it entirely (§8.8). |
| `HUB_ADMIN_TOKEN` | The token of the nine administrative endpoints. |
| `HUB_PREVIOUS_ADMIN_TOKEN` | The token that the current one replaced. It is accepted until the deployment removes it. |

A rotation is therefore a rolling change: the previous value is put in
the environment of the replicas, the new value replaces it, and the
previous value is removed. The rotation of the token of the decisions is
a change of the environment of every gateway at the same time, and the
window is what makes it a rolling one.

The comparison of the two tokens is in constant time, like the
comparison of one.

### 4.4 What a production deployment needs

A production deployment (`HUB_ENVIRONMENT=production`) refuses to start
when one of these is missing. Every problem of the environment is reported
at once and the message names the variables that are missing: a deployment
that fixes one variable and restarts to learn about the next one stays
down.

| Variable | Why it is required |
| --- | --- |
| `HUB_DATABASE_URL` | The five tables live there. A production environment must name a server (§3.8). |
| `HUB_ISSUER` | It is the `iss` of every token Hub issues and the issuer the gateway is configured with. |
| `HUB_REDIS_URL` | The authorization codes have to be shared by the replicas, unless `HUB_ALLOW_MEMORY_STATE=true` names a deployment of a single node. |
| `HUB_ADMIN_TOKEN` | It is the bearer token of the nine administrative endpoints, unless the deployment names its credentials in `HUB_ADMIN_TOKENS` (§4.6). |
| `HUB_STATE_SECRET` | It signs and encrypts the state of a login. At least 32 bytes. |
| `HUB_SECRET_ENCRYPTION_KEY` | It encrypts the client secrets at rest. At least 32 bytes. |
| `HUB_SIGNING_KEY` | It is the private key Hub signs its tokens with, in PEM. |
| `HUB_SIGNING_KID` | It is the identifier of the key in the JWKS. |

A secret is at least 32 bytes long. A secret that is handed over as a hex
string or as a base64 string is counted the way it is read: 32 bytes are 64
hexadecimal characters and 44 base64 characters.

A **bearer token** of the environment is at least **16 bytes** long, and
it is measured in the bytes it is compared in (§4.1). A production
deployment also refuses the values of `.env.example` and the secrets that
are one repeated character (§4.1). Every problem is reported at once, and
the message names the variable.

The level of the log is the only value of the environment that does not
stop the service: a typo in the level of a log must not keep a deployment
down.

**`HUB_ACCESS_TOKEN` is not required.** It is the bearer token of the
deployment on the decisions (§8.8), and it is **deprecated**: it is not
scoped to a tenant, so the gateway that presents it may ask about any
principal of the platform. A deployment that does not set it accepts
**only** the credentials of a tenant, which are scoped. That is the end
of the migration, and it is reachable: the token is optional, so a
deployment can remove it once every one of its gateways presents the
credentials of its tenant. The gateway of the reference sends the bearer
token, so a deployment that still has such a gateway keeps the token
until that gateway is moved (§8.8).

`HUB_ACCESS_CONTEXT_TOKENS` is optional too: it holds the credentials of
the access context contract (§9), and only a deployment that serves a
data backend needs it.

A production deployment also refuses to start when the role of the
database is a superuser or a role with `BYPASSRLS`: the isolation of the
tenants is enforced by the database, and it is not enforced for such a
role (§3.9). The message names the role and what to do about it.

### 4.5 The values that are in a file

A value of the environment may be in a **file** instead of in the
variable: `HUB_SIGNING_KEY_FILE` holds the private key,
`HUB_ACCESS_CONTEXT_TOKENS_FILE` holds the credentials of the access
context, `HUB_ADMIN_TOKEN_FILE` holds the token of the administration,
and so on. Every secret of the environment may be given that way.

The value of the file is the value of the variable, with the trailing
newline removed. A file that cannot be read is a configuration error, and
the service says so instead of starting without the secret.

A variable and its file are **not** set at the same time: a deployment
that sets both is a deployment that does not know which one it meant, and
the service refuses to start rather than choose.

The files are how a secret is given to a container: a secret of a
deployment is a file that a secret manager writes, and a private key in
a variable of the environment is a private key that a shell mangles.

### 4.6 The credentials of the administration

The administration is guarded by bearer tokens. A deployment may name
them in `HUB_ADMIN_TOKENS`, a json object whose keys are the tokens and
whose values are the scope of every one of them:

```json
{
  "the-token-of-the-operator-of-the-platform": null,
  "the-token-of-the-operator-of-acme": {"tenant": "acme", "operator": "alice"}
}
```

A value of `null` is the credential of the **platform**: it may act for
every tenant. A value of an object names the **slug** of the tenant the
credential may act for, and the **name** of its operator. The name is
what the audit of a change carries: a name is what an operator of a
platform can answer for, and the credential itself is never written.

A credential is at least 16 characters long, and a malformed value stops
the service: a credential that is not understood is a credential that is
not scoped.

`HUB_ADMIN_TOKEN` is the credential of the platform of a deployment that
names none. It keeps working, and the operator of the audit is the
fingerprint of the token. The two schemes are not exclusive: a
deployment may name the credentials of its tenants and keep the token of
the platform.

---

## 5. The login

### 5.1 The endpoints of Hub

The bodies of the requests and of the answers are in [api.md](api.md).

| Endpoint | Behaviour |
| --- | --- |
| `GET /oauth/authorize` | The authorization endpoint of Hub. The gateway sends the browser here. |
| `GET /oauth/tenant/callback` | The callback of Hub at the provider of a tenant. The provider sends the browser here. |
| `POST /oauth/token` | The token endpoint of Hub. The gateway exchanges the code here. The client authenticates with `client_secret_basic`; a client without a secret is refused. |
| `GET /oauth/jwks` | The keys of Hub. |
| `GET /oauth/userinfo` | The claims of the principal of a bearer token. |
| `GET /.well-known/openid-configuration` | The discovery document of Hub. |
| `POST /v1/decisions` | The decision contract of the gateway (§8). |
| `GET /healthz` | `200 {"status":"ok",…}`. Always available. |
| `GET /readyz` | `200` when the database answers and the migrations are applied, `503` otherwise. |
| `GET /metrics` | Prometheus text. `404` when `HUB_METRICS_TOKEN` is unset, `401` when the bearer token does not match. |
| `POST /v1/admin/tenants` | Administration (§10.2). |
| `GET /v1/admin/tenants` | Administration (§10.3). |
| `POST /v1/admin/users` | Administration (§10.4). |
| `GET /v1/admin/users` | The list of the principals, paginated (§10.5). |
| `PUT /v1/admin/grants` | Administration (§10.6). |
| `DELETE /v1/admin/grants/{id}` | Administration (§10.7). |
| `GET /v1/admin/grants` | The list of the grants, paginated (§10.8). |
| `POST /v1/admin/groups` | The group and its membership (§10.9). |
| `GET /v1/admin/groups` | The list of the groups, paginated (§10.10). |
| `GET /v1/admin/audit` | The audit of the changes, paginated (§10.1). It reads and it does not change. |

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
recommended topology. Only the operator of the platform may enable it:
the flag is one of the flags of the tenant that belong to the platform
(§10.1).

**The redirect uri of the request.** The url the browser comes back to
is a value the caller controls, so it is checked against the ones the
gateway of the client is registered with (`client_redirect_uris`,
§3.1) before the tenant is resolved:

- A `redirect_uri` that is not one of them → `400 invalid_request`, and
  the browser is **not** sent to it. The refusal is a page of Hub, not a
  redirection: a url that is not registered never receives a code.
- A tenant that has registered no url refuses every login. A deployment
  that has not registered its gateway yet does not log anyone in; it
  registers the url and the logins work.

The check is on the **client**, not on the tenant of the login: with a
shared client the tenant of the login may be another one, but the url
the browser comes back to always belongs to the gateway that presented
the client id.

### 5.3 The state of a login

The state of a login is carried by two cookies and by the parameters of
the redirects.

**The state cookie** (`hub_login_state`) holds, encrypted with
`HUB_STATE_SECRET` (AES-256-GCM, authenticated): the tenant, the client
id, the redirect uri, the `state` of the gateway, the `nonce`, the
verifier of the PKCE of the provider and the moment the login started. It
is `HttpOnly`, `Secure` in production, `SameSite=Lax`,
`Path=/oauth/tenant/callback`, and it lives ten minutes.

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
- It is bound to the client id, to the redirect uri and to the challenge
  of the PKCE. An exchange that presents another redirect uri, another
  client or a verifier that does not match the challenge is
  `invalid_grant`.
- It is bound to the **client that began the login**, and not to the
  tenant of the login: with a shared client, the tenant of the login may
  be another one (§5.2), and the gateway exchanges the code with the
  client id it is registered with. The audience of the tokens is that
  client id as well (§7.1).
- It never carries the identity in the clear.

The shared store is Redis. A deployment of one replica may use the memory
of the process with `HUB_ALLOW_MEMORY_STATE=true`. A store that cannot be
reached is an error: the login fails, it never falls back to "no state".

### 5.6 What a failed login answers

| Case | Answer |
| --- | --- |
| The provider refuses the login | The provider's own answer is passed to the browser, unchanged. |
| The provider is unreachable | `502 upstream_unavailable`, with a page that says the provider is not reachable and the name of the tenant. The reason is never the raw error of the provider. |
| The token of the provider is invalid | `403 identity_rejected`, with a page that says the identity was refused. The reason of the refusal is in the log of the service. |
| The identity is unknown and the tenant does not auto-provision | `403 identity_unknown`, with a page that says the identity is not known to the platform. The log carries the `(tenant, subject)` that was refused. |
| The principal is disabled | `403 principal_disabled`. |
| The state does not match, or the cookie is missing | `400 login_state_invalid`. The login is refused and a new one has to start. |

| The cookie of the state is not readable | `400 login_state_invalid`. A cookie that is not a valid escape is not a cookie. |

**The headers of the answers.** Every answer of Hub carries
`x-content-type-options: nosniff`, `x-frame-options: DENY` and
`referrer-policy: no-referrer`. A page of a refusal carries
`content-security-policy: default-src 'none'`. A deployment that is
served in https carries `strict-transport-security`. The answer of the
token endpoint carries `cache-control: no-store` and `pragma: no-cache`:
a token is never stored by an intermediary or by a browser (RFC 6749
§5.1).

---

## 6. The mapping of the identity

### 6.1 The validation of the token of the provider

Before a single row is read, the token of the provider is validated:

| Check | Rule |
| --- | --- |
| The issuer | `iss` is **exactly** the `idp_issuer` of the tenant. A comparison that ignores the case or the trailing slash is not allowed. |
| The audience | `aud` contains the `idp_client_id` of the tenant, or `azp` is it. |
| The nonce | `nonce` is the nonce of the login in flight. |
| The algorithm | The algorithm is in the `idp_algorithms` of the tenant. The `none` algorithm and an algorithm that is not in the list are refused. |
| The signature | It is verified with the JWKS of the provider, fetched from its discovery document and cached for ten minutes. A token that names a key the cache does not have is the sign of a **rotation**: the keys are read again once and the token is verified against them (§6.6). |
| The clock | `exp` and `iat` are checked with a tolerance of `HUB_CLOCK_SKEW_SECONDS`. |
| The subject | `sub` is present and is not empty. |

The discovery document of the provider is fetched from
`{idp_issuer}/.well-known/openid-configuration`. A provider whose issuer
in the document is not the `idp_issuer` of the tenant is refused.

**The addresses of the providers.** A tenant registers the issuer of its
provider, and Hub calls that address: the discovery document and the
keys are the only calls. The address is checked before the call: the
host is resolved and every address it resolves to has to be a public one.
A production deployment refuses the private addresses; a development
machine accepts them (the fixtures of the tests are on the loopback).

**The call is made to the address that was checked.** The guard resolves
the host and pins the address it resolved to, and the call is made to
that address, with the name of the host in the `Host` header and in the
name the certificate of a secure call is checked against. The name of the
host is therefore never resolved a second time: a host that answers a
public address to the check and a private one to the connection is of no
use. The answer of a provider is read up to one MiB: a provider that
answers more than that is not reachable.

### 6.2 The key of the mapping

The mapping key is `**(tenant, subject)**`:

```
users.tenant_id        = the tenant of the login
users.external_subject = the `sub` of the provider
```

It is never the e-mail. An e-mail changes, is reused and is not unique;
a principal that is bound to one is not a principal, it is a guess.
Linking two external identities to one principal is a feature, and it is
deferred (§14).

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

### 6.6 The rotation of the keys of a provider

A provider rotates its signing key: it publishes a new key in its JWKS
and it signs the tokens with it, and the old key stays published until
the last token it signed has expired.

The keys of a provider are cached for ten minutes (§6.1). A token that
names a key that the cache does not have is therefore **not** a bad
token: it is the sign of a rotation. Hub reads the keys of the provider
again, once, and it verifies the token against them. A token that is
signed with a key the provider does not publish is refused as before.

The keys are not read again on every call: at most once every thirty
seconds for a tenant. A provider that is hammered with tokens it did not
sign is not hammered with calls.

The client of a provider is kept for the same ten minutes. A change of
the registration of a tenant (its secret, its issuer) drops the client of
that tenant, and the next login builds a new one.

---

## 7. The tokens of Hub

Hub is the provider of the gateway. The tokens it issues are ordinary
OpenID Connect tokens.

### 7.1 The claims of the id token

| Claim | Value |
| --- | --- |
| `iss` | The issuer of Hub. |
| `sub` | The id of the principal. |
| `aud` | The client id of the gateway of the tenant — the client that began the login (§5.2, §5.5). |
| `exp`, `iat` | Five minutes of life. |
| `nonce` | The nonce of the login, when there was one. |
| `email` | The e-mail of the principal, when it is known. |
| `name` | The display name of the principal, when it is known. |
| `roles` | The keys of the permissions of the active grants of the principal (§7.3). |
| `tid` | The slug of the tenant. |
| `email_verified` | Always `false`: Hub does not verify the e-mail of a provider. |

The gateway reads `sub`, `email` and `roles` and nothing else, so the
claims above are the whole contract with the gateway.

The `sub` is the id of a principal: a **uuid** (§8.1). The gateway of
the release `2.0.0` of the reference and later writes the subject of
the identity **as it is**, and refuses with a `500` a subject that
cannot be written into a header — one that carries a control character,
one that is empty, one that is longer than 512 characters. A uuid
carries no control character and is thirty-six characters long: the
subject of Hub is always written, and it is never rewritten.

### 7.2 The access token

An access token is a JWT signed with `RS256`, with the issuer, the
audience (the client id), the subject, the scope and a life of five
minutes. It is accepted by the gateway in the `jwt` and `any` modes,
because the gateway validates a bearer token against the same provider it
discovers for the browser.

| Claim | Value |
| --- | --- |
| `iss` | The issuer of Hub. |
| `sub` | The id of the principal. |
| `aud` | The client id of the gateway of the tenant. |
| `exp`, `iat` | Five minutes of life. |
| `scope` | The scopes of the login. |
| `roles` | The keys of the permissions of the active grants of the principal (§7.3). |
| `tid` | The slug of the tenant. |

The token carries **no nonce** and **no e-mail**. A bearer token that
carries a nonce is an id token, and the gateway refuses it
(`SHUTTLE_OIDC_REJECT_NONCE_TOKEN`): an id token travels through the
browser, and it lands in the history, in the logs and in the referrers.
The e-mail of the principal is the claim of the id token: a caller that
comes with a bearer token is a client of an API, and it is identified by
its subject and by its roles.

The gateway of the release `1.2.0` of the reference and later requires an
**expiry** on a bearer token, and it bounds the lifetime of a token with
the moment it was issued (`SHUTTLE_OIDC_MAX_TOKEN_AGE_MS`): the access
token of Hub carries `exp` and `iat`, and its lifetime is five minutes,
so the gateway accepts it whatever the bound of the deployment is.

There is **no refresh token**. The gateway does not use one, and a refresh
token is a credential that has to be revoked, stored and rotated. A
client that needs one asks for it: it is a feature, it is deferred (§14).

### 7.3 The roles claim

The `roles` claim is the list of the keys of the permissions of the grants
of the principal that are alive at the moment the token is issued: not
revoked, not expired, with an enabled permission. The grants of the
**groups** of the principal are part of it: a permission that the group
holds is a permission of every member of the group.

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
`groups` by default and a broker that refused an unknown scope would
break a gateway that never changed.

### 7.5 The discovery document

`GET /.well-known/openid-configuration` is the document the gateway reads
once and caches for ten minutes. It carries at least:

| Field | Value |
| --- | --- |
| `issuer` | Exactly `HUB_ISSUER`. The gateway refuses a document whose issuer is not the one it was configured with. |
| `authorization_endpoint` | `{HUB_PUBLIC_URL}/oauth/authorize` |
| `token_endpoint` | `{HUB_PUBLIC_URL}/oauth/token` |
| `jwks_uri` | `{HUB_PUBLIC_URL}/oauth/jwks` |
| `userinfo_endpoint` | `{HUB_PUBLIC_URL}/oauth/userinfo` |
| `response_types_supported` | `["code"]` |
| `subject_types_supported` | `["public"]` |
| `id_token_signing_alg_values_supported` | `["RS256"]` |
| `grant_types_supported` | `["authorization_code"]` |
| `scopes_supported` | `["openid","profile","email","groups"]` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `["client_secret_basic"]` |

The `userinfo_endpoint` answers the claims of the principal of a bearer
token: `sub`, `email`, `name` and `roles`. A token that is expired, that
is signed with another key or that belongs to another audience is `401`.

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

- A missing or wrong credential → `401 unauthorized`. The two schemes of
  the credentials are in §8.8.
- A body that is not JSON, or a `subject` that is not a string → `400 bad_request`.
- A `subject` that is not the id of a principal → `400 bad_request`. The
  id of a principal is a uuid: a value that is not one names no row, and
  the request is refused instead of being asked of the database. The
  database is never asked to cast a value it cannot cast, so a caller
  cannot turn a malformed request into a failure of the storage.
- A database that cannot be reached, or a query that takes longer than
  `HUB_DECISION_TIMEOUT_MS` → `503 service_unavailable`.

Every one of these three is a **denial** for the gateway, because the
gateway fails closed on anything that is not a successful answer.

### 8.2 The answer

```
200 {"allow": true,  "reason": "allowed"}
200 {"allow": false, "reason": "the principal does not have the role of the workspace", "reasonCode": "missing_role"}
```

The status is `200` for a decision, allow or deny. The reason is free
text and is **never** given to the caller: the gateway hides it. It
exists for the operator, and it is in the log of the service.

A **denial** carries the **code** of its reason, and an allowance
carries none. The code is the vocabulary of the gateway (§6.1 of the
specification of the gateway): `missing_role` is a denial because the
caller does not have the role the policy asks for, and `access_denied` is
a denial for a reason the service does not name.

The gateway counts the code when the service sends one, and it counts the
text of the reason when the service sends none (§6.5 of the specification
of the gateway). The code and the text always agree: the code of a
reason is `missing_role` if and only if the text of the reason mentions
a role (§8.7). A gateway that reads the code and a gateway that reads
the text therefore count the same denials, and a reason that is reworded
does not change the metric of the gateway.

### 8.3 The rule

A principal may use a workspace on a route when there is at least one
grant that satisfies **all** of the following:

| Condition | Rule |
| --- | --- |
| The principal | `users.id = subject` and `users.status = 'active'`. |
| The tenant | `users.tenant_id` names a tenant whose `enabled = true`. |
| The grant | `grants.revoked_at is null` and the grant names the principal (`grants.user_id = users.id`) or a group of the principal (`grants.group_id` names a group whose `members` hold `users.id`). |
| The expiry | `grants.expires_at is null` or `grants.expires_at > now()`. |
| The permission | The permission of the grant is `enabled`. |
| The workspace | `grants.workspace_id is null` (every workspace of the tenant) or `grants.workspace_id = workspaceId`. |
| The route | `grants.route_id is null` (every route) or `grants.route_id = routeId`. |

A grant of one workspace does not grant another one. A grant of one route
does not grant another one. A grant without a workspace and without a
route is a grant of the whole tenant.

A grant of a **group** holds for every principal of the group, and for
nobody else. A principal that is removed from the group loses the access
at the next decision: the membership is read from the table, never from a
token.

The query is a single statement over five tables, with the indexes of
§8.5.

**The deadline of the statement is the deadline of the server.** The
statement runs with the `statement_timeout` of the connection of the
pool, which is the tightest deadline of the service
(`HUB_DECISION_TIMEOUT_MS`, two seconds by default). A statement that
takes too long is stopped by PostgreSQL, the transaction is rolled back
and the connection is given back to the pool at once. A deadline that
lives only in the memory of the process would let a statement keep a
connection of the pool for the whole window of the timeout of the pool.

The deadline of the process is the backstop of the deadline of the
server: it is longer by a quarter of a second, and it answers `503`
(the gateway fails closed) when the server did not answer at all.

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
`missing_role` and any other denial as `access_denied`. The reasons of
Hub are chosen with that in mind, so the metric of the gateway separates
the two.

### 8.5 The indexes

| Index | Serves |
| --- | --- |
| `users (id)` | The primary key: the subject of the request. |
| `grants (user_id) where revoked_at is null` | The grants of the principal. |
| `grants (group_id) where revoked_at is null` | The grants of the groups of the principal. |
| `groups` (GIN on `members`) | The groups that hold the principal: the containment `members @> array[principal]`. |
| `permissions (id)` | The primary key. |

The query of §8.3 stops at the first grant that satisfies it.

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

| Situation | Reason | Code |
| --- | --- | --- |
| Allowed | `allowed` | — |
| The subject is not a principal | `the principal does not exist` | `access_denied` |
| The principal is disabled | `the principal is disabled` | `access_denied` |
| The tenant is disabled | `the tenant is disabled` | `access_denied` |
| No grant satisfies the rule | `the principal does not have the role of the workspace` | `missing_role` |
| A grant exists but it expired | `the role of the workspace has expired` | `missing_role` |

The last two contain the word *role*, so the gateway counts them as
`missing_role`.

**The code and the text agree.** The code of a reason is `missing_role`
if and only if the text of the reason mentions a role. The gateway
counts the code when it is sent, and it falls back on the text when it
is not (§8.2): a gateway that reads the code and a gateway that reads
the text count the same denials.

The two are one contract: a reason that is added, reworded or removed is
a change of this table first, and a test holds the agreement of the two.
A reason that mentions a role and is not a denial of a role would change
the metric of the gateway of the reference, which counts the text.

### 8.8 The credentials of the gateway

The gateway authenticates itself on the decisions. Two schemes are
accepted, and a deployment picks one of them or the other.

| Scheme | What it is | What it may ask about |
| --- | --- | --- |
| `Authorization: Bearer {token}` | The token of the deployment, `HUB_ACCESS_TOKEN`. **Optional and deprecated.** | Every principal of the platform. |
| `Authorization: Basic {id:secret}` | The registration of the gateway of a tenant (§3.1). | The principals of that tenant. |

The **bearer token** is the scheme of the gateway of the reference: it is
the one the gateway already sends, and it keeps working. It is not
scoped: every gateway of the deployment shares it, so the gateway that
presents it may ask about any principal of the platform. The blast
radius of that secret is the whole platform.

The gateway of the reference presents that token and nothing else: it
authenticates itself at the decisions with a bearer token, and it has no
scheme for the credentials of a tenant. The shared token is therefore the
scheme of a deployment whose gateway is the one of the reference, and the
credentials of a tenant are the scheme of a deployment whose gateway
presents them.

The **credentials of a tenant** are the client id and the client secret
that are registered for the gateway of a tenant (§3.1). The client id
names the tenant, the secret is compared in constant time, and the
decisions of that gateway are **scoped to that tenant**: a subject that is
not a principal of the tenant is refused with the reason of a principal
that does not exist. The answer does not tell the gateway that the
subject exists in another tenant.

The scope of the credentials of a tenant does not depend on the row of
the tenant. A tenant whose `shared_client` is true may log in the
principals of the other tenants (§5.2), and its decisions are still
scoped to its own tenant: a gateway that asks about the principals of
every tenant presents the bearer token of the deployment, which is the
scheme that is not scoped.

A credential that is neither of the two schemes, or one that is refused →
`401 unauthorized`. The comparison is in constant time in both cases, and
the secret of a tenant is never written to a log.

The two schemes are not exclusive and nothing of the gateway changes: the
scheme of the credentials is a property of the deployment. A deployment
that moves its gateways to their own credentials removes the shared
secret of the platform.

**The bearer token is optional.** `HUB_ACCESS_TOKEN` is not required in
a production deployment (§4.4): a deployment that does not set it
accepts **only** the credentials of a tenant, and a request that
presents the bearer scheme is refused with `401 unauthorized`. This is
the end of the migration, and it is reachable — the token was
**required** before, so a deployment that had moved every one of its
gateways to the credentials of their tenant still had to keep a secret
whose blast radius was the whole platform. A deployment removes the
token when the last gateway that sends it has been moved.

**The bearer token of the deployment is deprecated.** It keeps working:
the gateway of the reference sends it, and a change of the gateway is
not a change of the deployment. But the service says so, once, in the
log of the first decision that presents it: the token is not scoped to a
tenant, and the credentials of a tenant are. The notice names the
scheme to use instead, and it is written once per service — a warning
on every decision would drown the log of the decisions.

---

## 9. The access context

> **Status: extension.** This section was added by the extension of the
> access context contract, which is a required integration change of the
> data backend. It does not change the contract of §8: the gateway keeps
> using `POST /v1/decisions` and nothing of the gateway changes.

A service that owns data needs more than a boolean. It needs to know
**which** capabilities a principal holds, so that it can decide what the
principal may read and what it may write. The decision of §8 answers
"may this principal use this workspace on this route"; the access context
answers "which capabilities does this principal hold for this workspace
and this route".

The two contracts read the same tables and they evaluate the same policy.
The access context never replaces the decision: the gateway continues to
use §8.

The bodies of the requests and of the answers are in
[api.md](api.md#the-access-context-contract).

### 9.1 The discovery

```
GET {HUB_ISSUER}/v1/access-context
Authorization: Bearer {access context credential}
```

```json
{"versions":[1],"maxPermissionKeys":4096,"maxLifetimeMs":5000}
```

The discovery is the readiness check of a consumer. A version the
consumer does not know stops its readiness: a consumer that guesses the
contract guesses the permissions.

### 9.2 The request

```
POST {HUB_ISSUER}/v1/access-context
Authorization: Bearer {access context credential}
Content-Type: application/json

{"version":1,"subject":"…","tenantId":"…","workspaceId":"…","routeId":"…"}
```

The body is at most 64 KiB. A field that is not known, a field of the
wrong type and a version that is not supported are refused with
`400 bad_request`. The `subject` and the `tenantId` are the ids of the
rows of the platform, so they are uuids: a value that is not one names
no row, and the request is refused instead of being asked of the
database.

The credential of the access context is **not** the credential of the
gateway and it is not a credential of the administration. It is a
dedicated read only credential, and it is scoped to an explicit set of
tenants:

| Situation                                   | Answer  |
| ------------------------------------------- | ------- |
| A missing or wrong credential               | `401 unauthorized` |
| A credential that may not ask about the tenant | `403 forbidden` |
| A body that is not understood               | `400 bad_request` |
| A policy that cannot be evaluated completely | `503 service_unavailable` |

The scope of a credential is configured with `HUB_ACCESS_CONTEXT_TOKENS`,
a JSON object whose keys are the bearer tokens and whose values are the
lists of the tenants the token may ask about. A `null` value is a
credential of the platform: it may ask about every tenant. It is a
choice of the deployment and it is never the default of a credential of
a tenant.

### 9.3 The answer

```json
{
  "version": 1,
  "allow": true,
  "subject": "…",
  "tenantId": "…",
  "workspaceId": "…",
  "routeId": "…",
  "permissionKeys": ["content.editor", "content.reader"],
  "evaluatedAt": "2026-10-21T16:00:00.000Z",
  "validUntil": "2026-10-21T16:00:05.000Z"
}
```

`permissionKeys` is the **complete**, sorted and deduplicated set of the
keys of the grants that apply to the request: the grants of the
principal and the grants of the groups of the principal, the grants that
are enabled, that are not revoked, that are not expired and whose
workspace and route scope match the request or is unrestricted.

The answer is never partial: more than 4096 keys is an error and never
an allowance with fewer keys.

`validUntil` is at most `evaluatedAt + 5000 ms` and at most the earliest
expiry among the grants that contributed. A conservative earlier expiry
is allowed. It is not a promise that a grant cannot be revoked before
that instant.

A denial is an answer of `200`: `allow` is false, `permissionKeys` is
empty, `validUntil` is absent, and the answer does not disclose whether
the cause was an unknown principal, another tenant, a disabled state or
a missing grant.

### 9.4 The rule

Hub evaluates one consistent policy snapshot:

1. The credential may ask about the requested tenant.
2. The principal exists, is active and belongs to that tenant.
3. The tenant is enabled.
4. At least one enabled, unrevoked and unexpired grant applies to the
   principal or to a group the principal belongs to.

Hub does not own a catalog of the workspaces: the relation between a
tenant and a workspace is the responsibility of the consumer. Hub still
verifies that the principal belongs to the tenant of the request.

### 9.5 The freshness

The context is evaluated on every request and it is never cached by Hub.
The consumer may cache a context for a read, and the bounds of the
cache are the ones of the consumer: the cache of a consumer never holds
a context longer than `validUntil`, and a mutation or a background
command asks for a fresh context.

The authorization is evaluated at the moment of the decision. A
revocation that happens after that moment may leave a request that is
already running in flight. The bound of that window is the lifetime of
the cache of the consumer plus the duration of the request that is
running. It is not a distributed transaction.

---

## 10. The administration

Nine endpoints, and one that reads the audit of the changes. That is the
whole administration surface of Hub: there is no console, no portal and
no second way to change a tenant, a principal or a grant (§2.1,
invariant 5).

The bodies of the requests and of the answers are in [api.md](api.md).

### 10.1 The common rules

- Every endpoint is under `/v1/admin` and requires a **bearer token**. A
  missing or wrong token → `401 unauthorized`. The comparison is in
  constant time. The token that the current one replaced is accepted as
  well, until the deployment removes it (§4.3.1).

  There are three kinds of credentials (§4.6):

  | Credential | What it may act for | The operator of the audit |
  | --- | --- | --- |
  | `HUB_ADMIN_TOKEN` | Every tenant of the platform. | The fingerprint of the token. |
  | A credential of a tenant of `HUB_ADMIN_TOKENS` | The tenant of the credential and nothing else. | The name of the operator of the credential. |
  | A credential of the platform of `HUB_ADMIN_TOKENS` | Every tenant of the platform. | The name of the operator, or the fingerprint of the token. |

  A credential of a tenant is refused with `403 forbidden` when the call
  acts for **another** tenant: a principal, a group, a grant or a tenant
  that is not its own. The lists of a credential of a tenant are the
  lists of its tenant, and the filter of a query cannot widen them. A
  credential of a tenant does not create a tenant: the creation of a
  tenant is the work of the operator of the platform.

  **The flags of a tenant that belong to the platform are the work of the
  operator of the platform.** The `shared_client` of a tenant moves the
  logins of the platform and the `is_default` routes the logins of the
  shared clients: a credential of a tenant may not change them. A call
  that carries a value that is not the value of the row → `403
  forbidden`. A call that carries the value of the row changes the
  tenant like any other change.

- The bodies are JSON, at most 64 KiB. A body that is larger → `413`.
- The answers are JSON. The errors are
  `{"error": "<code>", "message": "<text>"}`.
- The calls are rate limited per address: a burst of failed authentications
  is refused with `429`, so the admin token cannot be guessed by hammering
  the endpoint. **The budget of an address is spent by the calls that
  fail**: a call that authenticates itself is answered, whatever the
  address presented before, and it clears the count of the address. The
  count of the failures is held by the **shared store**
  of the deployment, so the window of the limiter is the window of the
  deployment and not the window of a replica: a deployment of several
  replicas does not accept five times the budget. A deployment that keeps
  its state in the process is a single node, and its count is the count of
  the deployment.
- Every call is logged: the endpoint, the status, the address, and the
  identifier of the thing that was changed. The secrets are never logged.
- The two list endpoints are **paginated**: `limit` (default `50`, maximum
  `200`) and `offset` (default `0`). A `limit` that is not a number, a
  `limit` above the maximum or an `offset` that is negative →
  `400 invalid_request`. The answer carries the `total` of the rows that
  match the filter, so the operator knows how many pages there are.
- **Every change is audited in a table.** The audit is the table
  `admin_audit`: it holds the action, the identifier of the thing that
  changed, the tenant, the operator, the address and the request. The
  operator is the **name** of the credential when it carries one, and
  the **fingerprint** of the credential when it does not (the first
  twelve hexadecimal characters of the digest of the token): the audit
  names the operator and it never holds the secret. The row is written
  by **the same statement** that writes the thing that changed, so the
  change and its audit are committed together or neither is: a change
  that is not audited does not exist. A write that fails is a failure of
  the call: the caller repeats it, and every call of the administration
  is idempotent. The audit is read with `GET /v1/admin/audit`, which is
  paginated like the other lists and filtered by `tenant` and by
  `action`. The audit of a credential of a tenant is the audit of that
  tenant.

The error codes: `unauthorized`, `invalid_request`, `not_found`,
`conflict`, `forbidden`, `too_many_requests`, `service_unavailable`. The
last one is the answer of a call that cannot be authenticated because the
count of the failed authentications could not be read: the count is held
by the shared store of the deployment, and a store that is down is a call
that is refused, never a call that is let through.

### 10.2 `POST /v1/admin/tenants`

Creates a tenant, or updates the tenant of that slug. The slug is the
key: the call is an **upsert**. `201` when the tenant was created, `200`
when it was updated.

A slug that belongs to another tenant of the same client id → `409
conflict`. A `clientId` that belongs to another tenant → `409 conflict`. A
`default` that would make a second tenant the default → `409 conflict`.

The two client secrets are encrypted at rest and are never returned.

### 10.3 `GET /v1/admin/tenants`

The list of the tenants, with the number of their principals and of their
grants.

### 10.4 `POST /v1/admin/users`

Creates a principal, or updates the principal of that `(tenant,
externalSubject)` pair. This is the endpoint that registers a caller
before its first login, and the one that disables a caller.

The pair is the key: the call is an **upsert**. `201` when the principal
was created, `200` when it was updated. An unknown tenant → `404
not_found`.

**The batch.** The body may carry a list of principals instead of one:
`{"principals": [ … ]}`. It is the call that onboards a tenant: one call
writes a hundred principals instead of a hundred calls.

- The batch holds at most **1 000** principals. A bigger list → `400
  invalid_request`. An empty list → `400 invalid_request`. The body of a
  batch is at most 1 MiB: the body of one principal is at most 64 KiB.
- The answer is `200` and it names the outcome of **every** item:
  `{"principals": [{"tenant", "externalSubject", "id", "created", "error"?,
  "message"?}, …]}`.
- **Every item is written on its own.** The change of an item and the row
  of its audit are one statement: an item that is written is audited, and
  an item that fails leaves nothing behind. An item that fails does not
  stop the others — its `error` names the refusal (`not_found` for a
  tenant that does not exist, `conflict` for an identity that is already
  used) — because an operator that onboards a tenant wants to know
  *which* identities were refused.
- The call is **idempotent**: the same batch again writes the same
  principals, and the ones that exist are updated instead of created.
- The cost of a batch is the cost of its items: every item is one
  statement and one row of the audit, so a batch of a thousand principals
  is a thousand statements. The batch is the call that onboards a tenant,
  and it is not the call of the path of a request.

### 10.5 `GET /v1/admin/users`

The list of the principals. It is the endpoint that answers "who has an
account here" and "what is the state of this account", without a query
against the database by hand. The filters are `tenant`, `status` and
`email`; the page is `limit` and `offset` (§10.1).

The order is the newest first (`created_at desc, id desc`), and it is
stable: two pages never show the same row twice and never skip one. The
list never carries a secret.

### 10.6 `PUT /v1/admin/grants`

Creates a grant, or updates the grant of that `(tenant, user, permission,
workspace, route)` tuple.

Exactly one of `userId` and `group` is required. The permission row is
**created on demand** when it does not exist, in the scope of the tenant.

A principal that belongs to another tenant → `403 forbidden`. A `userId`
that does not exist → `404 not_found`. A group that does not exist → `404
not_found`. A group of another tenant → `403 forbidden`. A body that
names neither a principal nor a group, or both → `400 invalid_request`.
A permission that exists in the catalogue of the platform is reused. A
permission that exists in another tenant is **not** reused: the tenant
creates its own row, and the grant names that row — a key is a name
inside a tenant (§3.3).

**The batch.** The body may carry a list of grants instead of one:
`{"grants": [ … ]}`. The rules are the ones of the batch of the
principals (§10.4): at most **1 000** grants, every item written on its
own, the answer naming the outcome of every item, and the call
idempotent.

### 10.7 `DELETE /v1/admin/grants/{id}`

Revokes a grant. The row is kept and stamped with `revoked_at`: the
history of the policy is worth more than the bytes, and a revoked grant
that is revived is not a grant that never existed.

The call is **idempotent**: a grant that is already revoked answers `204`
as well. An id that does not exist → `404 not_found`. A revocation is
visible to the gateway within `SHUTTLE_ACCESS_CACHE_TTL_MS` (§8.6).

### 10.8 `GET /v1/admin/grants`

The list of the grants. It is the endpoint that answers "who may use this
workspace" and "what is still live", without a query against the database
by hand. The filters are `tenant`, `userId` and `live`; the page is
`limit` and `offset` (§10.1). The order is the newest first and it is
stable.

The grant carries the `grantedBy` of the row: the operator has to be able
to read who gave an access without a query against the database by hand.

### 10.9 `POST /v1/admin/groups`

Creates a group, or changes the group of that key. The call **replaces**
the membership of the group.

The members are the external identities of the principals (§6.2): the
operator knows the `sub` of the provider, not the id of the row. A member
that is not a principal of the tenant → `404 not_found`: a group cannot
name a principal that does not exist.

The key is the key of the row: the call is an **upsert**. `201` when the
group was created, `200` when it was changed.

### 10.10 `GET /v1/admin/groups`

The list of the groups, paginated like the other lists (§10.1). It reads
and it does not change.

The filters are `tenant` and `key`. A tenant that does not exist →
`404 not_found`.

The group carries the **external subjects** of its members (§10.9): the
operator knows the `sub` of the provider, not the id of the row.

### 10.11 The whole session, in nine calls

The nine calls of a tenant, from the registration to the revocation, are
in [api.md](api.md) §"The session in nine calls".

### 10.12 `GET /v1/admin/audit`

The audit of the changes, the newest first. It reads and it does not
change, and it is paginated like the other lists.

The filter is `tenant` (the slug of a tenant that does not exist →
`404 not_found`) and `action` (`tenant.created`, `tenant.updated`,
`principal.created`, `principal.updated`, `group.created`,
`group.updated`, `grant.created`, `grant.updated`, `grant.revoked`).

The **format** of the answer is `json` by default. `csv` and `jsonl` are
the **exports**: the rows leave the platform in a file that a spreadsheet
or a script reads, and the filter of the list applies to them. A format
that is not one of the three → `400 invalid_request`.

| Format | The answer |
| --- | --- |
| `json` | The paginated list: the rows, the `total`, the `limit` and the `offset`. |
| `csv` | `text/csv`: the header is the name of the columns, and every row is a line. |
| `jsonl` | `application/x-ndjson`: one object per line. |

An export carries at most **10 000 rows** in one answer, and the `limit`
of the list applies to it: an audit that holds more rows is exported page
by page. The answer of an export names the file in
`content-disposition`.

The answer carries the rows and the `total` of the rows that match the
filter:

```json
{
  "records": [
    {
      "id": "0f2c…",
      "at": "2026-10-21T19:44:20.975Z",
      "action": "grant.revoked",
      "targetId": "9fbfda13-…",
      "tenant": "acme",
      "operator": "6b1f2c9d0e3a",
      "address": "10.0.0.7",
      "requestId": "8452a08e-ebd7-4e61-ae99-fe051f3e531d"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

The row carries no secret: the operator is the fingerprint of the
credential that made the call.

---

## 11. The behavior of the decision, in the whole picture

| Path | Answer |
| --- | --- |
| The caller has a grant that satisfies the rule | `{"allow":true,"reason":"allowed"}` |
| The caller has no grant | `{"allow":false,"reason":"the principal does not have the role of the workspace"}` |
| The caller is not a principal of Hub | `{"allow":false,"reason":"the principal does not exist"}` |
| The database is down | `503` → the gateway denies, because it fails closed |

The gateway hides the reason from the caller and counts it: `allowed` is
not counted, a denial with *role* in the reason is `missing_role`, any
other denial is `access_denied`.

---

## 12. The operations

The how-to of the operations is in [operations.md](operations.md). This
section is the contract that the operations have to respect.

### 12.1 The probes

`GET /healthz` answers `200 {"status":"ok","service":"hub","version":"1.0.1"}`
as long as the process is alive.

`GET /readyz` answers `200 {"status":"ready"}` when the database answers a
trivial query and the migrations are applied, `503 {"status":"draining"}`
during a drain and `503 {"status":"not-ready"}` otherwise.

### 12.2 The metrics

| Metric | Type | Labels |
| --- | --- | --- |
| `hub_decisions_total` | counter | `result` (`allow`, `deny`), `tenant` |
| `hub_decision_duration_seconds` | histogram | `tenant` |
| `hub_logins_total` | counter | `result` (`success`, `refused`, `error`), `tenant` |
| `hub_admin_requests_total` | counter | `endpoint`, `status` |
| `hub_store_errors_total` | counter | `store` (`redis`, `postgres`) |

The labels are bounded: the `tenant` label is capped at 100 values and
the rest is aggregated into `overflow`. Neither a caller nor a provider can
grow the number of series without limit.

### 12.3 The logs

Structured JSON, one line per event, with the redacted fields. The events
are: the login (tenant, outcome, the reason of a refusal), the decision
(subject, workspace, route, allow or deny, the reason), the
administration (endpoint, status, the identifier of the thing that
changed) and the lifecycle of the process.

The redaction is the one of the gateway: a token, a secret, a cookie and
an `Authorization` header never reach a log line.

### 12.4 The drain

On `SIGTERM` the readiness probe answers `503` with the body `draining`,
the listener stops accepting new work, the running logins are given five
seconds to finish, and the process exits. A decision that is running when
the deadline is reached is a denial.

---

## 13. What does not change in Shuttle

This is the point of the whole design, so it is written as a list of
things that are **not** touched.

| In Shuttle | Status |
| --- | --- |
| The format of the route table (`config/routes.json`) | Unchanged. |
| The environment of the gateway (`SHUTTLE_*`) | Unchanged. Hub asks for no new variable: the variables that the releases `1.0.0`, `1.1.0`, `1.2.0`, `1.3.0` and `2.0.0` of the gateway added are the business of the deployment, and two of them are required by a production deployment of the gateway (`SHUTTLE_SESSION_SECRET` and `SHUTTLE_IDENTITY_SIGNING_KEY`). The release `2.0.0` added `SHUTTLE_TRUSTED_PROXY_HOPS` (one by default), the number of the proxies that are in front of the gateway, and it changed the ranges of `SHUTTLE_TRUSTED_PROXIES`: they replace the ranges of the route table when the environment names them, and they do not add to them. |
| The single provider (`SHUTTLE_OIDC_ISSUER`, `SHUTTLE_OIDC_CLIENT_ID`, `SHUTTLE_OIDC_REDIRECT_URI`, `SHUTTLE_OIDC_CLIENT_SECRET`) | Unchanged. They name Hub. |
| The single access service (`SHUTTLE_ACCESS_URL`, `SHUTTLE_ACCESS_TOKEN`) | Unchanged. They name Hub. |
| The contract of the decision (`POST /v1/decisions`, `{subject, workspaceId, routeId, roles}` → `{allow, reason}`) | Unchanged. Hub implements it as it is, and it sends the `reasonCode` of a denial (§8.7). |
| The cache of the decisions of the gateway | Unchanged. Its TTL is the latency of a revocation. |
| The headers of the identity, the sessions, the limits, the WebSockets | Unchanged. The gateway of the release `2.0.0` writes the **subject** of the identity as it is and refuses a subject that cannot be written into a header: the subject of the tokens of Hub is a uuid (§7.1), so it is always written. |
| The signature of the identity | The one of the gateway: the release `1.0.0` removed the symmetric format, and the upstreams verify the signature with the public key of the deployment. The gateway signs it, not Hub. |
| The routes, the upstreams, the workspaces | Unchanged. They belong to the deployment, not to the broker. |
| The code of the gateway | **No commit.** |

### 13.1 The configuration of a deployment

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

The gateway of the release `1.0.0` and later asks for two more variables
in a production deployment: `SHUTTLE_SESSION_SECRET`, the secret of the
sessions of the browsers, and `SHUTTLE_IDENTITY_SIGNING_KEY`, the
private key that signs the identity of a request. They are the business
of the deployment and not of Hub: the upstreams verify the identity with
the public key of the deployment.

### 13.2 The two configurations that have to agree

| On the side of Hub | On the side of Shuttle |
| --- | --- |
| `HUB_ISSUER` | `SHUTTLE_OIDC_ISSUER` — the **same** url, character for character. |
| `tenants.client_id` | `SHUTTLE_OIDC_CLIENT_ID` |
| `tenants.client_secret` | `SHUTTLE_OIDC_CLIENT_SECRET` |
| `HUB_ACCESS_TOKEN` | `SHUTTLE_ACCESS_TOKEN` |

### 13.3 What the gateway learns from Hub, and what it does not

The gateway learns the identity of the caller: the subject, the e-mail and
the roles. It does not learn the tenant, the grants or the permissions:
they are not claims of the token and the gateway does not read them.

The e-mail is the claim of the id token: a caller that comes with a
bearer token is identified by its subject and by its roles (§7.2).

The tenant is in the `tid` claim for the operator. The gateway ignores
it, and that is fine: the decision of §8 does not need it, because the
subject names the principal and the principal names its tenant.

---

## 14. The deferred features

Everything below is **deferred**. A deferred feature has no column, no
table, no flag, no endpoint and no code. The schema does not reserve
anything for it, because a column that is always `null` is a column that
somebody will read as a feature.

The rule that brings one of them back: **a named customer pays for it.**
Not "it seems useful", not "it is on the roadmap", not "it is standard".

| Deferred | What it would mean | What is missing without it |
| --- | --- | --- |
| **SAML** | A tenant whose provider speaks SAML instead of OpenID Connect. | A tenant whose provider is not an OIDC provider is not served. |
| **Account linking** | One principal, several external identities (a second provider, a second subject). | The mapping key is `(tenant, subject)`, and it is one to one. A person with two accounts has two principals and two sets of grants. |
| **The console** | A web interface for the administration. | The nine endpoints of §10 and `curl`. |
| **SCIM** | The provisioning of the principals by a provider. | The principals are created by the endpoint of §10.4, or by the auto-provisioning of the tenant. |
| **Directory sync** | The import of the directory of a tenant, on a schedule, from a source of truth. | The principals are created one at a time, by hand or by a script that calls the endpoints. |

The **groups** were not deferred: the operator of the platform asked for
them, and they are the fifth table of the model (§3.5).

---

## 15. The verification

A rule that has no test is a rule that is not implemented.

| Kind | Where | What it proves |
| --- | --- | --- |
| Unit | `src/domains/*/*.test.ts` | The validation of the token of a provider, the mapping, the rule of the decision, the resolution of the tenant. |
| Contract | `test/contract/` | The whole flow against the fixtures of Hub: the login of a browser, the exchange of the code, the decision, the nine administrative endpoints, the audit, the rotation of the secrets. |
| Integration | `test/integration/` | The decisions against a real PostgreSQL and a real Redis, the isolation of the tenants, the migrations, the deadline of a statement, the rule of the decision against a policy that is built at random. |
| Compatibility | `test/compatibility/` | **The gateway, unchanged, against Hub.** The fixtures of the Shuttle reference are replaced by Hub, and the contract suite of the gateway is run against it. |
| Architecture | `test/architecture/` | The import boundaries of Hub, and the absence of the deferred features. |
| Tooling | `test/tooling/` | The runner of the compatibility suite: the pin of the reference, the sources of the checkout, and the refusals. |

### 15.1 The compatibility test, in detail

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

The suite holds a second file: the **rehearsal of the cutover** of a
tenant ([release.md](release.md) §4). It plays the phases of the runbook
against the gateway of the reference: the tenant is registered, its
principal and its grant are registered, a browser logs in and reaches an
upstream, the grant is revoked and the access ends, and the tenant is
switched again without registering anything.

**The gateway is not modified for any of these tests.** If one of them
needs a change in the gateway, the change is a change of the gateway, and
it is refused: the compatibility test exists to prove that there is none.

### 15.2 The pin of the reference

The revision of the gateway that the suite runs against is the commit
that `compatibility.json` names, at the root of the repository. The pin
is a **full commit id**: a branch, a tag, a short hash and a placeholder
are refused, because a reference that moves is a reference that cannot
be tested twice.

The runner of the suite (`scripts/compatibility.ts`, `bun run
test:compat`) is the only way the reference is prepared:

1. it reads the manifest relatively to the root of the repository;
2. it clones the reference and checks out the pinned commit — the whole
   history, because the pinned commit is not always the one of the
   default branch;
3. it installs the dependencies of the reference in the directory of the
   reference, with a frozen lockfile;
4. it passes the path of the checkout in `HUB_SHUTTLE_PATH`, and the
   suite runs the gateway of the reference as a process, in its own
   directory;
5. it asserts that the reference is at the pinned commit and that its
   tracked files are the ones of the commit, before and after the run.

A checkout that a developer prepared (`HUB_SHUTTLE_PATH`) is checked
and never written to: a checkout that is at another commit, or that
carries changes, is refused with the reason. The runner never falls
back to another source: a suite that runs against another revision
proves nothing. The manual is in [compatibility.md](compatibility.md).

---

## 16. The layout of the code

The layout, the layers and the boundaries are in
[architecture.md](architecture.md). In one table:

| Path | Owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. |
| `src/app/` | The HTTP application: thin handlers, the order of the pipeline, the mapping of the failures to the answers of the protocol. |
| `src/domains/identity/` | The validation of the token of a provider, the mapping to a principal, the resolution of the tenant. |
| `src/domains/authorization/` | The rule of the decision, the reading of the grants, the reasons. |
| `src/domains/administration/` | The nine endpoints, the validation of their bodies, the audit of every change. |
| `src/domains/provider/` | The tokens of Hub, the JWKS, the discovery document, the exchange of the code. |
| `src/platform/` | The adapters: PostgreSQL, Redis, the Bun listener, the HTTP client. |
| `src/observability/` | The logs, the metrics, the comparison of the secrets. |
| `src/runtime/` | The environment, the composition root, the lifecycle and the drain. |
| `scripts/compatibility.ts` | The runner of the compatibility suite. It is outside the application: no file of `src/` imports it, and the service depends on no package of the reference. |
| `compatibility.json` | The pin of the reference: the url of its repository and the commit of the revision that is tested (§15.2). |

---

## 17. The decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Where does the multi-tenancy live? | In Hub, never in Shuttle. Shuttle keeps one provider and one access service, so one Shuttle deployment serves one tenant of Hub (§1.4). |
| 2 | Is Hub a provider or a client of OpenID Connect? | Both: a client of the provider of the tenant and a provider for the gateway. The gateway does not have to know. |
| 3 | What is the key of the mapping of an identity? | `(tenant, subject)`. Never the e-mail: an e-mail is mutable and is not an identity (§6.2). |
| 4 | Is a principal created at the first login? | Only when the tenant has `auto_provision = true`, and it has no grant: the login succeeds and the access does not (§6.4). |
| 5 | What decides an access? | The table of grants, and nothing else. The roles of the request are context, because they are a snapshot of the token and a policy that read them would allow a revoked grant until the next login (§8.4). |
| 6 | Is a decision cached by Hub? | No. The table is the truth, the query is a single statement over indexed tables, and the latency of a revocation is the TTL of the cache of the gateway (§8.6). |
| 7 | How many administrative endpoints? | Nine: five that change something, four that read a list, and one that reads the audit of the changes. They are the whole surface, and the reason a tenant, a principal and a grant can only be changed through them is that the audit is complete (§10). |
| 8 | Why is the authorization code stored instead of being self-contained? | A self-contained code can be redeemed twice inside its life. The store makes it single use, which is the property the gateway relies on (§5.5). |
| 9 | Why are there no refresh tokens? | The gateway does not use one. A refresh token is a credential to store, rotate and revoke; it is a feature, it is deferred (§7.2). |
| 10 | Why is the reason of a denial free text? | The gateway hides it and only counts it. The vocabulary of the reasons is chosen so the count of the gateway separates a missing role from any other denial (§8.7). |

---

## 18. The settled questions

The questions that were open when this document was written, and the
answer that the implementation gives them. The answers are the contract:
a change of one of them is a change of this document first.

| # | Question | The answer | Where |
| --- | --- | --- | --- |
| 1 | May the shared client be enabled at all? | It is refused by default: `shared_client` is `false` unless the operator says so. When it is enabled, the parameter of the tenant and the hint of the e-mail can move a login to another tenant, and nothing else can. | §3.1, §5.2 |
| 2 | Is the `roles` claim of the token the right list? | It is the list of the keys of the live grants of the principal, sorted, without duplicates and capped at sixty-four entries. The count of the roles that were left out is in the log. | §7.3 |
| 3 | Does a grant need a scope on the path of the request? | No. The decision contract does not carry one and the contract does not change: a grant is a workspace and a route, which is the granularity the gateway knows. | §8.3 |
| 4 | Is the expiry of a grant worth it? | Yes: it is in the model because a temporary access is a real thing, and it costs one comparison in the statement of the decision. | §3.4, §8.3 |
| 5 | How is a secret rotated? | The secret of the gateway of a tenant is kept for 24 hours when it is replaced, and the tokens of the environment are read from two variables during a rotation. The rotation is a rolling change and never a window in which the client and the service disagree (§4.3.1). |
| 6 | Where does the audit of the administration live? | In a table of the infrastructure, `admin_audit`, written by the call that changed the thing. A log line is not an audit: it disappears with the container and it is not queryable (§10.1). |
