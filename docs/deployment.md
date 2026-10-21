# The deployment of Hub

How a deployment of Hub is made, what it needs and how it is checked.

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

The token of the access service is the scheme of the gateway of the
reference, and it is **not scoped**: every gateway of the deployment
shares it. A gateway that presents the **credentials of its tenant**
instead (`client_secret_basic`, spec §8.8) only asks about the
principals of that tenant. The two schemes work at the same time, so a
deployment moves its gateways one by one and then removes the shared
secret.

The whole list is in [SPEC.md](../SPEC.md) §4, and the variables that a
production deployment cannot start without are in §4.4.

## The role of the database

The isolation of the tenants is enforced by the database, and the
policies of the tables are only policies for a role that is subject to
them. A **production** deployment refuses to start with a superuser and
with a role that has `BYPASSRLS` (spec §3.8).

The role of the deployment therefore owns the tables of the platform and
is not a superuser:

```sql
create role hub_app login password '…';
alter database hub owner to hub_app;
grant usage, create on schema public to hub_app;
```

The migrations are applied by that role, so it owns the tables it
creates. The runbook of the refusal is in [runbooks.md](runbooks.md).

The values are **32 bytes at least** for the two secrets, and they are the
same on every replica: a replica that has another secret cannot read the
state of the logins of the others.

## The environment of a replica

```
HUB_ENVIRONMENT=production
HUB_HOST=0.0.0.0
HUB_PORT=8081
HUB_ISSUER=https://hub.example.com
HUB_PUBLIC_URL=https://hub.example.com
HUB_DATABASE_URL=postgres://hub:…@postgres:5432/hub
HUB_REDIS_URL=redis://redis:6379/0
HUB_ADMIN_TOKEN=…
HUB_ACCESS_TOKEN=…
HUB_METRICS_TOKEN=…
HUB_STATE_SECRET=…
HUB_SECRET_ENCRYPTION_KEY=…
HUB_SIGNING_KEY=…
HUB_SIGNING_KID=hub-1
HUB_LOG_LEVEL=info
```

The file `.env.example` holds the same list with the values that a
development machine can use.

## The first tenant

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
   The two sides have to agree character for character: the issuer is the
   same url on the two sides (spec §12.2).
5. **The check** — the eight calls of the session:
   ```bash
   HUB_URL=https://hub.example.com HUB_ADMIN_TOKEN=… bun run scripts/admin-smoke.ts
   ```

## The probes of the deployment

| Probe | What it is for |
| --- | --- |
| `GET /healthz` | The process answers. It is the liveness probe: it is `200` as long as the process is alive. |
| `GET /readyz` | The service can serve the traffic: the database answers and the migrations are applied. It is `503 {"status":"draining"}` during a drain: it is the gate of the rolling replacement. |

## The deployment of the image

The image runs as a user that is not `root` and it writes nothing: the
file system of the container can be read-only, apart from the temporary
directory of the runtime. The logs go to the standard output.

The image is built once and promoted by its digest
([delivery.md](delivery.md)).
