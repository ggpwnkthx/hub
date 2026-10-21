# The prompt that starts the build of Hub

Copy everything below the line into the session of the agent that builds
the service. It is written to be self-contained: an agent that has never
seen this repository can start from it.

---

You are building **Hub**, a new Bun service. You are in its workspace:
`/home/orca/projects/ggpwnkthx/hub`. This repository holds nothing but
Hub.

## Where the things are

### This workspace (Hub)

| What | Where |
| --- | --- |
| **The specification of Hub** (normative) | `SPEC.md` |
| **The implementation guide** (the plan) | `IMPLEMENTATION.md` |
| The pinned version of the gateway | `shuttle.ref` |
| The code | `src/`, `test/` — created by milestone M0 and the ones after |

### The reference (Shuttle), a separate repository

Shuttle is the application gateway Hub brokers for. **It is not part of
this repository and it is never modified.** It is a read-only reference,
and it is where the contracts Hub has to satisfy are written.

| What | Where |
| --- | --- |
| The local clone of the reference | `/home/orca/projects/ggpwnkthx/shuttle` (next to this workspace) |
| How to get it again | `git clone https://github.com/ggpwnkthx/shuttle.git ../shuttle` |
| The version Hub is built against | the commit in `shuttle.ref` (`git -C ../shuttle checkout $(cat shuttle.ref)`) |
| The contract of the gateway | `../shuttle/docs/spec.md` |
| The architecture of the gateway | `../shuttle/docs/architecture.md` |
| The decisions of the gateway | `../shuttle/docs/decisions.md` |
| The operations of the gateway | `../shuttle/docs/operations.md` |
| The client of the access service | `../shuttle/src/domains/workspace-access/` — **Hub implements the other end of this contract** |
| The relying party of the gateway | `../shuttle/src/domains/authentication/oidc.ts` — **Hub is the provider it talks to** |
| The shape of a service in this codebase | `../shuttle/src/runtime/env.ts`, `../shuttle/src/runtime/composition.ts`, `../shuttle/src/app/`, `../shuttle/src/observability/` |
| The fixtures of the gateway | `../shuttle/services/oidc-provider.ts`, `../shuttle/services/access-fixture.ts`, `../shuttle/services/fixture-guard.ts` |
| The contract suite of the gateway | `../shuttle/test/contract/` |
| The architecture checker | `../shuttle/scripts/architecture.ts` |
| The CI of the gateway | `../shuttle/.github/workflows/ci.yml` |

Read `SPEC.md` and `IMPLEMENTATION.md` **first**, in that order. The spec
says what the service does; the guide says how it is built, in what order,
and what has to be true before it carries a customer. The guide is a plan
that moves; the spec is the contract.

Then read, of the reference:

- `../shuttle/docs/spec.md` — especially §5 (authentication), §6 (workspace
  access) and §7 (the header policy). These are the parts Hub has to fit
  into.
- `../shuttle/src/domains/workspace-access/` — the request and the answer
  of the decision, exactly as the gateway sends them.
- `../shuttle/src/domains/authentication/oidc.ts` — the relying party of
  the gateway. The discovery document, the JWKS, the claims (`sub`,
  `email`, `roles`), the `client_secret_basic` authentication of the
  token endpoint and the `nonce` are fixed by that file.
- `../shuttle/src/runtime/env.ts`, `../shuttle/src/runtime/composition.ts`,
  `../shuttle/src/app/` — the conventions of a service in this codebase:
  the environment is validated as a whole, the domains are pure, the
  adapters are assembled by the composition root.
- `../shuttle/scripts/architecture.ts` and `../shuttle/docs/architecture.md`
  — the rules of the imports, which Hub copies.

## What the service is, in one paragraph

Hub is an OpenID Connect **broker**: it is the client of the identity
provider of a tenant and, at the same time, the OpenID Connect **provider**
of a Shuttle gateway. A browser logs in at the provider of the tenant,
Hub maps the external identity `(tenant, subject)` to a principal row, and
Hub issues its own tokens to the gateway. Hub also answers the decision
contract the gateway already speaks — `POST /v1/decisions`, with
`{subject, workspaceId, routeId, roles}` and `{allow, reason}` — over a
table of grants, and it is administered with five `curl` endpoints. The
whole domain model is four tables: `tenants`, `users`, `permissions`,
`grants`.

## The rules, which do not move

1. **The gateway is not modified.** The reference is a separate
   repository and is read-only: never commit in it, never edit a file in
   it, never fork it to make a test pass. The compatibility suite
   (`test/compatibility/`) proves it: it runs the gateway, unchanged, at
   the commit of `shuttle.ref`, against Hub, and the build fails when the
   tree of the reference is touched.
2. **The spec is the contract.** A change of behavior is a change of
   `SPEC.md` first, in the same commit as the code. A decision is written
   down with its evidence — a measurement, a test, a document — before it
   is implemented. Never an intuition.
3. **The schema reserves nothing for a future.** No column that is always
   `null`, no empty table, no flag nobody reads. SAML, the console, SCIM,
   the directory sync and the linking of accounts are deferred until a
   named customer pays for them (spec §13), and a test asserts that they
   are absent.
4. **One rule, one domain, one test file next to it.** A rule that has no
   test is a rule that is not implemented.
5. **The boundaries are checked by the build, not by a review.** The
   architecture checker of the gateway is copied and extended for Hub.
6. **A failure is a denial.** A database that is down, a store that is
   down, a provider that is slow, a secret that is missing: the service
   never guesses in the direction of allowing.
7. **No secret, token or cookie reaches a log line, and no error of a
   dependency reaches a caller.**

## What to do now

Start with **milestone M0 — the skeleton** of `IMPLEMENTATION.md`: tasks
`HUB-001` to `HUB-007`. It is the foundation every other milestone stands
on, and it is small enough to be finished in one sitting.

M0 delivers: the layout of the project with its `package.json`,
`tsconfig.json` and `biome.json`; the environment of `SPEC.md` §4 read
once and validated as a whole (a value that cannot be understood stops the
process); the listener, the structured logs with the redaction, the
request id and the drain; the probes `/healthz` and `/readyz`; the
architecture checker; the CI workflow; and the image.

Work in the order of the tasks of the guide, and follow the conventions
of the gateway: the same `biome.json`, the same `tsconfig.json`, the same
shape of `src/runtime/env.ts`, the same way of writing a log line and the
same way of refusing a request. Read `../shuttle/src/app/`,
`../shuttle/src/runtime/` and `../shuttle/src/observability/` before
writing them, and mirror what is there.

The exit criteria of M0, from the guide, are:

- `bun run typecheck`, `bun run lint` and `bun test` pass.
- The architecture checker fails the build on a forbidden import.
- The image starts with an empty environment and refuses to start in
  production with a structured error that names the missing secret.
- `SIGTERM` produces a drain: the readiness answers `503 draining`, the
  process exits within five seconds.
- The image is under 200 MB and runs as a user that is not `root`.

## How to work

- Read the section of `SPEC.md` that the task implements, and the section
  of `../shuttle/docs/spec.md` it touches, before writing the code.
- Write the test of the rule in the same commit as the rule.
- Run `bun test`, `bun run typecheck` and `bun run lint` before you
  declare a task done.
- Keep the tasks of the guide up to date: a task that is not in the table
  of §5 does not exist, and a task that turns out to need a decision is
  not decided in the code.
- When a task of the guide is ambiguous, choose the reading that keeps the
  spec and the guide consistent, write the choice in the pull request,
  and move on. Do not stop to redesign.
- Report the state at the end: the tasks that are done, the ones that are
  open, the decisions you took, and the first thing you would do next.

Start now with `HUB-001` and `HUB-002`.
