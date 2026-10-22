# Hub — HTTP API

Every endpoint of Hub, its request, its answer and its errors. The rules
behind them are in [spec.md](spec.md); this document is the reference of
the wire format.

The bodies are JSON. The errors are `{"error": "<code>", "message":
"<text>"}`, except the token endpoint, which speaks OAuth: `{"error":
"<code>", "error_description": "<text>"}`.

Every answer carries the header `x-request-id`. It is the identifier of
the request in the logs of the service; a client that sends a valid
`x-request-id` gets its own back.

---

## The probes

| Endpoint | Answer |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok","service":"hub","version":"0.2.0"}` — as long as the process is alive. |
| `GET /readyz` | `200 {"status":"ready"}` when the database answers and the migrations are applied; `503 {"status":"draining"}` during a drain; `503 {"status":"not-ready"}` otherwise. |
| `GET /metrics` | Prometheus text. `404` when `HUB_METRICS_TOKEN` is unset, `401` when the bearer token does not match. |

```bash
curl -sS https://hub.example.com/healthz
curl -sS https://hub.example.com/readyz
curl -sS https://hub.example.com/metrics -H "authorization: Bearer $HUB_METRICS_TOKEN"
```

---

## The OpenID Connect provider

### `GET /oauth/authorize`

The authorization endpoint. The gateway sends the browser here.

| Parameter | Rule |
| --- | --- |
| `client_id` | Required. Names the tenant (§5.2 of the spec). |
| `redirect_uri` | Required. Must be one of the `clientRedirectUris` registered for the tenant. A url that is not registered is refused with `400 invalid_request`, and the browser is not sent to it. |
| `response_type` | Required. `code`. |
| `scope` | Optional. `openid profile email groups`. |
| `state` | Optional. Returned to the gateway. |
| `nonce` | Optional. Bound to the token that is issued. |
| `code_challenge`, `code_challenge_method` | Optional. `S256`. |
| `tenant` | Only when the client of the tenant is `shared_client`. |
| `login_hint` | Optional. An e-mail, used only when the client is shared. |

The answer is a `302` to the provider of the tenant, or a refusal:
`400 invalid_request` (no tenant, bad parameters), `403 tenant_disabled`.

### `GET /oauth/tenant/callback`

The callback of Hub at the provider of a tenant. The provider sends the
browser here with `code` and `state`.

The answer is a `302` to the `redirect_uri` of the request, with the code
of Hub and the `state` of the gateway. The refusals are the ones of
§5.6 of the spec: `400 login_state_invalid`, `400 invalid_request`,
`403 identity_rejected`, `403 identity_unknown`, `403 principal_disabled`,
`403 provider_error`, `403 tenant_disabled`, `502 upstream_unavailable`.
An unexpected failure is `500 internal_error`, and it never carries the
error of a dependency.

### `POST /oauth/token`

The exchange of the code for the tokens. The client authenticates with
`client_secret_basic`.

```
POST /oauth/token
Authorization: Basic {client_id}:{client_secret}
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…
```

| Field | Rule |
| --- | --- |
| `grant_type` | Required. `authorization_code`. |
| `code` | Required. The code of the login. Single use, 60 seconds. |
| `redirect_uri` | Required. The same one as in the authorization request. |
| `code_verifier` | Required when the request carried a `code_challenge`. |

```json
{
  "access_token": "eyJ…",
  "token_type": "Bearer",
  "expires_in": 300,
  "id_token": "eyJ…"
}
```

There is no refresh token (spec §7.2). The refusals: `401 invalid_client`
(missing, unreadable or wrong credentials), `400 invalid_request` (grant
type, missing code or redirect uri), `400 invalid_grant` (the code is
unknown, expired, already used, or bound to another client, redirect uri
or challenge).

### `GET /.well-known/openid-configuration`

The discovery document. The fields are in §7.5 of the spec.

### `GET /oauth/jwks`

The public keys of Hub, in the JWKS format. During a rotation, the JWKS
carries the current key and the previous one, until the last token it
signed has expired.

### `GET /oauth/userinfo`

The claims of the principal of a bearer token: `sub`, `email`, `name` and
`roles`.

```bash
curl -sS https://hub.example.com/oauth/userinfo -H "authorization: Bearer $ACCESS_TOKEN"
```

`401` when the token is expired, signed with another key, or belongs to
another audience.

---

## The decision contract

### `POST /v1/decisions`

The contract the gateway already speaks. It is not changed by Hub.

```
POST /v1/decisions
Authorization: Bearer {HUB_ACCESS_TOKEN}
Content-Type: application/json

{"subject":"…","workspaceId":"…","routeId":"…","roles":["…"]}
```

| Field | Rule |
| --- | --- |
| `subject` | Required. The id of a principal: a uuid. |
| `workspaceId` | Optional. Absent → the empty string. |
| `routeId` | Optional. Absent → the empty string. |
| `roles` | Optional. Absent → an empty list. The roles are **context**, never the policy (spec §8.4). |

```json
{"allow": true, "reason": "allowed"}
{"allow": false, "reason": "the principal does not have the role of the workspace"}
```

The status is `200` for a decision, allow or deny. The refusals: `401
unauthorized` (missing or wrong credential), `400 bad_request` (the body
is not JSON, or the subject is not a string, or the subject is not the
id of a principal), `503 service_unavailable`
(the database is down, or the decision took longer than
`HUB_DECISION_TIMEOUT_MS`). All three are denials for the gateway, which
fails closed.

The credentials are the two schemes of §8.8 of the spec: the bearer token
of the deployment (every principal of the platform) or the credentials of
a tenant (its own principals only).

---

## The access context contract

> **Status: extension.** Added by the extension of the access context
> contract, a required integration change of the data backend. The
> decision contract above is unchanged.

The contract a service that owns data uses to learn the **complete** set
of the capabilities of a principal, for a workspace and a route. It is
not the credential of the gateway and it is not a credential of the
administration: it is a dedicated read only credential, scoped to an
explicit set of tenants with `HUB_ACCESS_CONTEXT_TOKENS`.

### `GET /v1/access-context`

The discovery of the contract. It is the readiness check of a consumer.

```
GET /v1/access-context
Authorization: Bearer {access context credential}
```

```json
{"versions":[1],"maxPermissionKeys":4096,"maxLifetimeMs":5000}
```

The refusals: `401 unauthorized` (missing or wrong credential). The
discovery discloses nothing about the principals and nothing about the
grants.

### `POST /v1/access-context`

The context of a principal.

```
POST /v1/access-context
Authorization: Bearer {access context credential}
Content-Type: application/json

{"version":1,"subject":"…","tenantId":"…","workspaceId":"…","routeId":"…"}
```

| Field | Rule |
| --- | --- |
| `version` | Required. `1`. Another version is `400 bad_request`. |
| `subject` | Required. The id of a principal: a uuid. |
| `tenantId` | Required. The tenant of the request: a uuid. |
| `workspaceId` | Required. The workspace of the request. |
| `routeId` | Required. The route of the request. |

A field that is not known and a field of the wrong type are refused. The
body is at most 64 KiB.

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

`permissionKeys` is the complete, sorted and deduplicated set of the
keys of the grants that apply to the request. The answer is never
partial: more than 4096 keys is `503 service_unavailable` and never an
allowance with fewer keys.

A denial is an answer of `200`: `allow` is false, `permissionKeys` is
empty, `validUntil` is absent, and the answer does not disclose the
cause.

The refusals: `401 unauthorized` (missing or wrong credential), `403
forbidden` (the credential may not ask about this tenant), `400
bad_request` (the body is not understood), `503 service_unavailable`
(the policy could not be evaluated completely).

---

## The administration

Nine endpoints, all under `/v1/admin`, all requiring
`Authorization: Bearer $HUB_ADMIN_TOKEN`. The rules they share — the
limits, the pagination, the error codes, the audit — are in §10.1 of the
spec.

### `POST /v1/admin/tenants`

Creates a tenant, or updates the tenant of that slug (an upsert).

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
        "clientRedirectUris": ["https://shuttle-acme.example.com/auth/callback"],
        "autoProvision": false,
        "sharedClient": false,
        "default": false,
        "enabled": true
      }'
```

| Field | Rule |
| --- | --- |
| `slug` | Required. `[a-z0-9-]{2,63}`. The key of the row. |
| `displayName` | Required. |
| `issuer` | Required. The issuer of the provider of the tenant. |
| `idpClientId` | Required. |
| `idpClientSecret` | Required. Encrypted at rest, never returned. |
| `idpRedirectUri` | Optional. Default `https://{HUB_PUBLIC_URL}/oauth/tenant/callback`. |
| `idpScopes` | Optional. Default `["openid","email","profile"]`. |
| `idpAlgorithms` | Optional. Default `["RS256"]`. |
| `emailDomain` | Optional. Unique when it is set. |
| `clientId` | Required. The client id of the gateway of the tenant at Hub. Unique across the tenants. |
| `clientSecret` | Required. Encrypted at rest, never returned. A secret that replaces another one is kept for 24 hours, and both are accepted until the window is over (the rotation of a secret). |
| `clientRedirectUris` | Optional. Default `[]`. The urls the gateway is registered with: the browser is sent back to one of them with the code of the login. A url that is not in the list is refused with `400 invalid_request`. A tenant that has registered none refuses every login. |
| `autoProvision` | Optional. Default `false`. |
| `sharedClient` | Optional. Default `false`. |
| `default` | Optional. Default `false`. At most one tenant is the default. |
| `enabled` | Optional. Default `true`. |

`201` when the tenant was created, `200` when it was updated. `409
conflict` when the client id belongs to another tenant, or when a second
tenant would become the default.

```json
{
  "id": "6f0f…", "slug": "acme", "displayName": "Acme Inc",
  "issuer": "https://login.acme.example", "emailDomain": "acme.example",
  "clientId": "shuttle-acme",
  "clientRedirectUris": ["https://shuttle-acme.example.com/auth/callback"],
  "autoProvision": false, "sharedClient": false,
  "default": false, "enabled": true,
  "createdAt": "2026-01-08T10:00:00.000Z"
}
```

### `GET /v1/admin/tenants`

The list of the tenants, with their counts.

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

### `POST /v1/admin/users`

Creates a principal, or updates the principal of that `(tenant,
externalSubject)` pair (an upsert). This is the endpoint that registers a
caller before its first login, and the one that disables a caller.

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

| Field | Rule |
| --- | --- |
| `tenant` | Required. The slug of the tenant. |
| `externalSubject` | Required. The `sub` of the provider of the tenant. |
| `email` | Optional. The e-mail to publish in the token until the provider says otherwise. |
| `displayName` | Optional. |
| `status` | Optional. `active` or `disabled`. Default `active`. |

`201` when the principal was created, `200` when it was updated. `404
not_found` when the tenant is unknown.

```json
{
  "id": "b1c2…", "tenant": "acme", "externalSubject": "00u1a2b3c4d5",
  "email": "alice@acme.example", "displayName": "Alice", "status": "active",
  "lastLoginAt": null, "createdAt": "2026-01-08T10:05:00.000Z"
}
```

#### The batch of the principals

The body may carry a list of principals instead of one. It is the call
that onboards a tenant: one call writes a hundred principals instead of
a hundred calls.

```bash
curl -sS -X POST https://hub.example.com/v1/admin/users \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "principals": [
          {"tenant": "acme", "externalSubject": "00u1a2b3c4d5", "email": "alice@acme.example"},
          {"tenant": "acme", "externalSubject": "00u1a2b3c4d6", "email": "bob@acme.example"}
        ]
      }'
```

The batch holds at most 1 000 principals. **Every item is written on its
own**: an item that is written is audited, and an item that fails leaves
nothing behind. An item that fails does not stop the others, and the
answer names the outcome of every one of them.

```json
{
  "principals": [
    {"tenant": "acme", "externalSubject": "00u1a2b3c4d5", "id": "b1c2…", "created": true},
    {"tenant": "acme", "externalSubject": "00u1a2b3c4d6", "id": null, "created": false,
     "error": "not_found", "message": "the tenant does not exist"}
  ]
}
```

The call is **idempotent**: the same batch again writes the same
principals, and the ones that exist are updated instead of created.

### `GET /v1/admin/users`

The list of the principals.

```bash
curl -sS "https://hub.example.com/v1/admin/users?tenant=acme&limit=50" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"
```

| Parameter | Rule |
| --- | --- |
| `tenant` | Optional. The slug of a tenant. Absent → every tenant. |
| `status` | Optional. `active` or `disabled`. |
| `email` | Optional. The exact e-mail of the principal. |
| `limit` | Optional. Default `50`, maximum `200`. |
| `offset` | Optional. Default `0`. |

```json
{
  "principals": [
    {
      "id": "b1c2…", "tenant": "acme", "externalSubject": "00u1a2b3c4d5",
      "email": "alice@acme.example", "displayName": "Alice", "status": "active",
      "lastLoginAt": "2026-01-08T10:05:00.000Z",
      "createdAt": "2026-01-08T10:00:00.000Z"
    }
  ],
  "total": 42, "limit": 50, "offset": 0
}
```

The order is the newest first (`created_at desc, id desc`), and it is
stable: two pages never show the same row twice and never skip one. The
list never carries a secret.

### `PUT /v1/admin/grants`

Creates a grant, or updates the grant of that `(tenant, user, permission,
workspace, route)` tuple.

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

| Field | Rule |
| --- | --- |
| `tenant` | Required. The slug of the tenant. |
| `userId` | The id of the principal. Exactly one of `userId` and `group` is required. |
| `group` | The key of the group of the grant. Exactly one of `userId` and `group` is required. |
| `permission` | Required. The key of the permission. The row is **created on demand** when it does not exist, in the scope of the tenant. A key is a name inside a tenant: two tenants may hold a permission of the same key. |
| `workspaceId` | Optional. `null` (the default) is every workspace of the tenant. |
| `routeId` | Optional. `null` (the default) is every route. |
| `expiresAt` | Optional. `null` (the default) is a grant that does not expire. An ISO 8601 moment. |
| `grantedBy` | Optional. Who grants it, for the audit log. |

```json
{
  "id": "d3e4…", "tenant": "acme", "userId": "b1c2…",
  "permission": "workspace.read",
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "routeId": "workspace-api", "expiresAt": null, "revokedAt": null,
  "createdAt": "2026-01-08T10:06:00.000Z"
}
```

#### The batch of the grants

The body may carry a list of grants instead of one: `{"grants": [ … ]}`.
The rules are the ones of the batch of the principals: at most 1 000
grants, every item written on its own, the answer naming the outcome of
every one of them, and the call idempotent.

```json
{
  "grants": [
    {"tenant": "acme", "id": "d3e4…", "created": true},
    {"tenant": "acme", "id": null, "created": false,
     "error": "not_found", "message": "the principal does not exist"}
  ]
}
```

### `DELETE /v1/admin/grants/{id}`

Revokes a grant. The row is kept and stamped with `revoked_at`.

```bash
curl -sS -X DELETE https://hub.example.com/v1/admin/grants/d3e4… \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -i
```

```
HTTP/1.1 204 No Content
```

The call is **idempotent**: a grant that is already revoked answers `204`
as well. `404 not_found` when the id does not exist.

### `GET /v1/admin/grants`

The list of the grants.

```bash
curl -sS "https://hub.example.com/v1/admin/grants?tenant=acme&live=true" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"
```

| Parameter | Rule |
| --- | --- |
| `tenant` | Optional. The slug of a tenant. Absent → every tenant. |
| `userId` | Optional. The id of a principal. |
| `live` | Optional. `true` → the grants that are not revoked and not expired. `false` → the others. Absent → every grant. |
| `limit` | Optional. Default `50`, maximum `200`. |
| `offset` | Optional. Default `0`. |

```json
{
  "grants": [
    {
      "id": "d3e4…", "tenant": "acme", "userId": "b1c2…",
      "permission": "workspace.read",
      "workspaceId": "11111111-1111-4111-8111-111111111111",
      "routeId": "workspace-api", "expiresAt": null, "revokedAt": null,
      "grantedBy": "ops@example.com",
      "createdAt": "2026-01-08T10:10:00.000Z"
    }
  ],
  "total": 57, "limit": 50, "offset": 0
}
```

### `POST /v1/admin/groups`

Creates a group, or changes the group of that key (an upsert). The call
**replaces** the membership of the group.

```bash
curl -sS -X POST https://hub.example.com/v1/admin/groups \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
        "tenant": "acme",
        "key": "team-platform",
        "displayName": "The platform team",
        "members": ["00u1a2b3c4d5", "00u9z8y7x6w5"]
      }'
```

| Field | Rule |
| --- | --- |
| `tenant` | Required. The slug of the tenant. |
| `key` | Required. `[a-z0-9][a-z0-9._-]{0,63}`. |
| `displayName` | Optional. |
| `members` | Optional. The **external subjects** of the principals of the group. |

A member that is not a principal of the tenant → `404 not_found`: a group
cannot name a principal that does not exist.

```json
{
  "id": "e5f6…", "tenant": "acme", "key": "team-platform",
  "displayName": "The platform team",
  "members": ["00u1a2b3c4d5", "00u9z8y7x6w5"],
  "createdAt": "2026-01-08T10:20:00.000Z"
}
```

### `GET /v1/admin/groups`

The list of the groups, the newest first. It reads and it does not change.

```bash
curl -sS "https://hub.example.com/v1/admin/groups?tenant=acme&limit=20" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"
```

| Query | Rule |
| --- | --- |
| `tenant` | Optional. The slug of a tenant. A tenant that does not exist → `404 not_found`. |
| `key` | Optional. The key of a group. |
| `limit` | Optional. Default `50`, maximum `200`. |
| `offset` | Optional. Default `0`. |

The group carries the **external subjects** of its members, like the
answer of the creation does.

```json
{
  "groups": [
    {
      "id": "e5f6…", "tenant": "acme", "key": "team-platform",
      "displayName": "The platform team",
      "members": ["00u1a2b3c4d5", "00u9z8y7x6w5"],
      "createdAt": "2026-01-08T10:20:00.000Z"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

### `GET /v1/admin/audit`

The audit of the changes, the newest first. It reads and it does not
change.

```bash
curl -sS "https://hub.example.com/v1/admin/audit?tenant=acme&limit=20" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"
```

| Query | Rule |
| --- | --- |
| `tenant` | Optional. The slug of a tenant. A tenant that does not exist → `404 not_found`. |
| `action` | Optional. The name of the action. |
| `limit` | Optional. Default `50`, maximum `200`. An export carries at most `10000`. |
| `offset` | Optional. Default `0`. |
| `format` | Optional. `json` by default, `csv` or `jsonl` for the export. Another value → `400 invalid_request`. |

The actions are `tenant.created`, `tenant.updated`, `principal.created`,
`principal.updated`, `group.created`, `group.updated`, `grant.created`,
`grant.updated` and `grant.revoked`.

The row of the audit is written by the statement that writes the thing
that changed: the change and its audit are committed together, or
neither is. A call that fails leaves no change behind, and the caller
that repeats it writes the same row of the audit.

```json
{
  "records": [
    {
      "id": "0f2c…",
      "at": "2026-01-08T10:30:00.000Z",
      "action": "grant.revoked",
      "targetId": "9fbfda13-…",
      "tenant": "acme",
      "operator": "6b1f2c9d0e3a",
      "address": "10.0.0.7",
      "requestId": "8452a08e-ebd7-4e61-ae99-fe051f3e531d"
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

The `operator` is the fingerprint of the credential that made the call:
the first twelve hexadecimal characters of the digest of the token. It
names the operator and it is not the token.

### The export of the audit

The audit is a table and it is queryable, but an operator that hands the
history of the platform to somebody needs a **file**. The export is the
same endpoint with a format:

```bash
# The audit of a tenant, in a file a spreadsheet reads.
curl -sS "https://hub.example.com/v1/admin/audit?format=csv&tenant=acme" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -o acme-audit.csv

# The audit of a tenant, in a file a script reads line by line.
curl -sS "https://hub.example.com/v1/admin/audit?format=jsonl&tenant=acme" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -o acme-audit.jsonl
```

The filter of the list applies to the export, and an export carries at
most 10 000 rows: an audit that holds more rows is exported page by
page, with `limit` and `offset`.

```csv
id,at,action,targetId,tenant,operator,address,requestId
0f2c…,2026-01-08T10:30:00.000Z,grant.revoked,9fbfda13-…,acme,6b1f2c9d0e3a,10.0.0.7,8452a08e-…
```

---

## The session in nine calls

The whole life of a tenant, from the registration to the revocation.

```bash
export HUB=https://hub.example.com
export HUB_ADMIN_TOKEN=…

# 1. the tenant and the registration of its gateway
curl -sS -X POST $HUB/v1/admin/tenants \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"slug":"acme","displayName":"Acme Inc","issuer":"https://login.acme.example",
       "idpClientId":"hub-acme","idpClientSecret":"…","clientId":"shuttle-acme",
       "clientSecret":"…","emailDomain":"acme.example",
       "clientRedirectUris":["https://shuttle-acme.example.com/auth/callback"]}'

# 2. the tenants, with their counts
curl -sS $HUB/v1/admin/tenants -H "authorization: Bearer $HUB_ADMIN_TOKEN"

# 3. the principals of the tenant
curl -sS "$HUB/v1/admin/users?tenant=acme" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"

# 4. the principal of the external identity
curl -sS -X POST $HUB/v1/admin/users \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"tenant":"acme","externalSubject":"00u1a2b3c4d5","email":"alice@acme.example"}'

# 5. the grant: the permission on the workspace, on the route
curl -sS -X PUT $HUB/v1/admin/grants \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"tenant":"acme","userId":"b1c2…","permission":"workspace.read",
       "workspaceId":"11111111-1111-4111-8111-111111111111","routeId":"workspace-api"}'

# 6. the grants of the tenant
curl -sS "$HUB/v1/admin/grants?tenant=acme" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"

# 7. the group and its membership: a grant of the group holds for every member
curl -sS -X POST $HUB/v1/admin/groups \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"tenant":"acme","key":"team-platform","displayName":"The platform team",
       "members":["00u1a2b3c4d5"]}'

# 8. the groups of the tenant
curl -sS "$HUB/v1/admin/groups?tenant=acme" \
  -H "authorization: Bearer $HUB_ADMIN_TOKEN"

# 9. the revocation, when the access has to end
curl -sS -X DELETE $HUB/v1/admin/grants/d3e4… -H "authorization: Bearer $HUB_ADMIN_TOKEN"
```

The same sequence, run against a deployment, is
`scripts/admin-smoke.ts`:

```bash
HUB_URL=$HUB HUB_ADMIN_TOKEN=$HUB_ADMIN_TOKEN bun run scripts/admin-smoke.ts
```
