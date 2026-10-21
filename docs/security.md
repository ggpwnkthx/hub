# The security review of Hub

The review is the one of the checklist of production readiness
([IMPLEMENTATION.md](../IMPLEMENTATION.md) §11.2), item by item. Every
item is answered with a fact: a test, a measurement or a piece of code.
The findings that are open are listed at the end.

## The findings

| # | What was reviewed | Result | Where |
| --- | --- | --- | --- |
| 1 | **The enumeration of the identifiers.** The administrative endpoints answer the id of the thing they created: they are guarded by the token of the administration and the operator is the only caller. The decisions answer `the principal does not exist` and `the principal does not have the role of the workspace`: the difference tells a caller that a subject exists. The caller of the decisions is the gateway, which is trusted, and the gateway hides the reason from the caller (spec §8.4). | Accepted | `src/domains/authorization/decision.ts` |
| 2 | **The timing of the answers.** The tokens of the administration, of the decisions and of the metrics are compared in constant time: the two values are hashed first, so the comparison does not depend on the length of the secret. The state of a login is authenticated: a state that was changed does not decrypt. | Fixed | `src/observability/secrets.ts`, `src/domains/identity/state.ts` |
| 3 | **The injection of SQL.** Every statement is parameterised. The identifiers of the tables and of the columns are constants of the code: no value of a caller ever reaches a statement as text. | No finding | `src/platform/postgres/` |
| 4 | **The SSRF of the `idp_issuer`.** A tenant registers the issuer of its provider, and Hub calls that address. The address is checked before the call: the host is resolved and every address it resolves to has to be a public one. A deployment of production refuses the private addresses; a development machine accepts them (the fixtures of the tests are on the loopback). | Fixed | `src/platform/bun/address.ts` |
| 5 | **The redirect of the provider.** The calls to the providers of the tenants do not follow a redirect: a provider that answers with a redirect cannot send the credentials of the deployment somewhere else. | Fixed | `src/platform/bun/http.ts` |
| 6 | **The XSS of the refusal pages.** The pages of the refusals of the login escape everything they show: the code of the refusal, its title and its text. | Fixed | `src/app/pages.ts` |
| 7 | **The secrets in the logs.** The logger redacts a token, a secret, a cookie, a password and an `Authorization` header wherever they appear, in the fields and in the text of a message. The bearer token of a message is removed. The values of a statement are never written: only the statement itself. | Fixed | `src/observability/logging.ts`, `src/platform/postgres/trace.ts` |
| 8 | **The secrets at rest.** The two client secrets of a tenant are encrypted with AES-256-GCM under `HUB_SECRET_ENCRYPTION_KEY` before they are written. A service without a key refuses to write a tenant: it never stores a secret in clear. | Fixed | `src/platform/postgres/secrets.ts` |
| 9 | **The state of a login.** It is encrypted, it is authenticated, it is single use (it is deleted whatever the outcome of the callback is) and it lives ten minutes. | Fixed | `src/domains/identity/state.ts` |
| 10 | **The authorization code.** It is opaque, it is stored under a hash of itself, it lives sixty seconds, it is single use and it is bound to the client, to the redirect uri and to the challenge of the PKCE. | Fixed | `src/domains/provider/code.ts`, `src/domains/provider/exchange.ts` |
| 11 | **The failure is a denial.** A database that is down, a store that is down, a provider that is slow and a decision that does not answer in time are all denials: the gateway fails closed on anything that is not a successful answer. | Fixed | `src/app/decisions.ts` |
| 12 | **The reason never reaches a caller.** The reasons are for the operator and they are in the log of the decision. The answer of the decision carries the reason because the contract of the gateway asks for it, and the gateway hides it from the caller. | Accepted | `src/app/decisions.ts` |
| 13 | **The image.** It runs as a user that is not `root`, it has no shell and it carries no tool of the build. The base image is pinned by digest. | Fixed | `Dockerfile` |
| 14 | **The password of the database.** It is not in the image: it comes from the environment, and the rotation is the deployment of a new secret. | No finding | `src/runtime/env.ts` |
| 15 | **The rate limit of the administration.** A burst of failed authentications is refused with `429`, and an address that used up its budget is refused whatever it presents. | Fixed | `src/domains/administration/limiter.ts` |
| 16 | **The limits of the process.** The body of an administrative call is at most 64 KiB, the calls to the providers have a deadline (`HUB_IDP_TIMEOUT_MS`) and the decisions have a deadline (`HUB_DECISION_TIMEOUT_MS`). | Fixed | `src/app/administration.ts`, `src/domains/identity/provider-client.ts` |
| 17 | **The redirection of the browser.** The redirect uri of the gateway comes from the authorization request of the gateway and it is the one that is registered at the tenant. The state of the gateway travels with the request and it is checked by the gateway. | Accepted | `src/app/login.ts` |
| 18 | **The cookies.** The state of a login is `HttpOnly`, `SameSite=Lax`, `Secure` in production and its path is the callback of the login. | Fixed | `src/app/login.ts` |
| 19 | **The credentials of the decisions.** Two schemes are accepted (spec §8.8): the bearer token of the deployment, which is the scheme of the gateway of the reference and is **not scoped**, and the credentials of a tenant, which are scoped to that tenant. The secret of a tenant is compared in constant time and is never written to a log. A gateway that presents the credentials of a tenant cannot ask about the principals of the other tenants: the answer is the one of a principal that does not exist, so it does not tell the gateway that the subject exists somewhere else. | Fixed | `src/app/decisions.ts` |
| 20 | **The isolation of the tenants.** The application isolates the tenants, and the database is the backstop of that isolation: the four tables have the row level security of PostgreSQL and their policy is the tenant of the statement. A statement that forgets the tenant is refused by PostgreSQL itself. The scope is local to the transaction, so a pooled connection never carries the scope of another request. A production deployment refuses to start with a role that bypasses the policies (a superuser, or a role with `BYPASSRLS`): the isolation would be a promise and not a rule. | Fixed | `src/platform/postgres/scope.ts`, `src/platform/postgres/migrations/0003_tenant_isolation.sql` |

## The findings that are open

| # | Finding | Severity | Plan |
| --- | --- | --- | --- |
| 1 | The reason of a decision tells the gateway whether a subject exists. | Low | The gateway is the only caller and it hides the reason. A future that needs a reason that says nothing about the existence of a subject would change the vocabulary of spec §8.7 — a change of the specification first. |
| 2 | The window of the limiter of the administration is the one of the process: the replicas have one window each, so the limit of a deployment is the limit of a replica times the number of the replicas. | Low | The administration surface is small and the limit is a protection against a hammering, not a quota. |
| 3 | The bearer token of the decisions is not scoped: the gateway that presents it may ask about any principal of the platform, and the secret is shared by every gateway of the deployment. | Medium | The gateway of the reference only speaks the bearer token, so the scheme cannot be removed without a change of the gateway. Hub already accepts the credentials of a tenant, which are scoped (spec §8.8): a deployment moves its gateways to them and the shared secret loses its power. The rotation of the token remains a change of the environment of every gateway at the same time. |

No finding is above "low".
