# The runbooks of Hub

A runbook is the answer to "what do I do when it happens". Every one of
them is a sequence of commands and a decision: nothing here needs a
person who knows the service.

The names of the things:

| Name | What it is |
| --- | --- |
| The deployment | The set of the replicas of Hub, behind the ingress of the platform. |
| The database | The PostgreSQL of the four tables. |
| The store | The Redis of the authorization codes. |
| The provider of a tenant | The identity provider of a tenant, outside of the deployment. |
| The operator | The person who runs the deployment. |

The logs are structured JSON: every line has a `msg` and the fields of the
event. The metrics are at `/metrics` and they need the token of the
metrics (`HUB_METRICS_TOKEN`).

---

## The provider of a tenant is down

**What the operator sees.** The logins of that tenant are refused with
`502 upstream_unavailable` and the metric `hub_logins_total{result="refused"}`
grows. The other tenants keep working: the provider is called per tenant.

**What to do.**

1. Check that the provider answers:
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://login.acme.example/.well-known/openid-configuration
   ```
2. Check that the deployment reaches it: the same call from the pod of a
   replica.
3. If the provider is down, there is nothing to do: Hub fails the login
   of that tenant and the other tenants are untouched. The alert is the
   one of the rate of the refusals of the login.
4. When the provider answers again, the logins resume by themselves: the
   discovery document and the keys are cached for ten minutes.

**What not to do.** Do not raise the timeout of the provider: a provider
that is slow must not hold the logins (the deadline is
`HUB_IDP_TIMEOUT_MS`, 5 s by default).

---

## The database is down

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
3. **The replicas do not start** against a database they cannot reach:
   the migration of the schema runs before the listener accepts. This is
   on purpose: Hub does not start against a schema it does not understand.
   A replica that cannot start is visible in the rollout of the
   deployment.
4. When the database answers, the replicas start and the readiness turns
   green by itself.

**The decisions are not cached.** There is no decision to serve while the
database is down: a decision that cannot be computed is a denial.

---

## The store is down

**What the operator sees.** The logins that reach the exchange fail: the
code cannot be stored. The metric `hub_store_errors_total{store="redis"}`
grows. The decisions keep working: they do not touch the store.

**What to do.**

1. Check the store:
   ```bash
   redis-cli -u "$HUB_REDIS_URL" ping
   ```
2. **A store that is down is an error and never a silent allowance**: the
   login does not succeed without the code. A caller who sees the
   failure retries the login.
3. If the deployment is a single node, it can be started with
   `HUB_ALLOW_MEMORY_STATE=true`: the codes then live in the process and
   they are lost when it restarts. A deployment with several replicas
   cannot: the codes of one replica are unknown to the others.

---

## The secret of the deployment is rotated

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
   secret. A failure leaves the stored secrets exactly as they were: the
   whole rotation is one transaction.
3. Change `HUB_SECRET_ENCRYPTION_KEY` in the deployment and roll it.
4. Check that the logins of the tenant still work: `scripts/admin-smoke.ts`
   against the deployment.

### The key of the signing (`HUB_SIGNING_KEY`)

1. Generate the new key: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.
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

Change the value and roll the deployment. The gateway is configured with
the same value (spec §12.2): change it on both sides, the gateway
first.

---

## The deployment of a tenant is wrong

A tenant is registered with the wrong issuer, the wrong client id or the
wrong redirect uri: the logins of that tenant fail and the other tenants
are untouched.

**What to do.**

1. Find the tenant:
   ```bash
   curl -sS https://hub.example.com/v1/admin/tenants \
     -H "authorization: Bearer $HUB_ADMIN_TOKEN"
   ```
2. Correct it with the same call (the slug is the key, the call is an
   upsert):
   ```bash
   curl -sS -X POST https://hub.example.com/v1/admin/tenants \
     -H "authorization: Bearer $HUB_ADMIN_TOKEN" \
     -H "content-type: application/json" \
     -d '{"slug":"acme","displayName":"Acme Inc","issuer":"https://login.acme.example",
          "idpClientId":"hub-acme","idpClientSecret":"…",
          "idpRedirectUri":"https://hub.example.com/oauth/tenant/callback",
          "clientId":"shuttle-acme","clientSecret":"…"}'
   ```
3. The discovery document and the keys of the provider are cached for ten
   minutes: a corrected tenant that still fails is a cache. Wait ten
   minutes or roll the deployment.

**A tenant that names a client id of another tenant is a `409
conflict`**: the client id of a gateway belongs to one tenant (spec §3.1).

---

## The signing key of the deployment is missing

**What the operator sees.** The service starts and it warns: `the service
cannot issue a token: it has no signing key`. The logins fail at the
exchange and the JWKS is empty.

**What to do.** Set `HUB_SIGNING_KEY` and `HUB_SIGNING_KID` and roll the
deployment. In production the environment refuses to start without them
(spec §4.4).

---

## The deployment of Hub is slow

1. The readiness: `503 not-ready` means the database does not answer.
2. The metrics: `hub_decision_duration_seconds` shows the latency of the
   decisions by tenant; `hub_store_errors_total` shows the failures of
   the stores.
3. The log of the statements: a statement that is slower than 50 ms is a
   warning (`the statement is slow`).
4. The pool: the number of the connections of the database that are used
   by Hub is in `pg_stat_activity`.
