# Hub — documentation

Hub is an **OpenID Connect broker** and an **access decision service**. It
authenticates a caller against the identity provider of a *tenant*, maps
the external identity to a *principal*, and answers the decision contract
that a [Shuttle](https://github.com/ggpwnkthx/shuttle) gateway already
speaks.

The whole domain model is five tables — `tenants`, `users`,
`permissions`, `grants`, `groups` — and the whole administration surface
is eight `curl` endpoints that change something, plus one that reads the
audit of the changes.

| Document | What it holds |
| --- | --- |
| [spec.md](spec.md) | **The normative contract.** The behavior of the service. A change of behavior is a change of this document first. |
| [api.md](api.md) | The HTTP surface: every endpoint, its request, its answer, its errors, with `curl` examples. |
| [architecture.md](architecture.md) | How the code is laid out, the boundaries the build checks, the two flows, the data model. |
| [operations.md](operations.md) | Running it: configuration, deployment, probes, metrics, alerts, runbooks, backup, capacity. |
| [security.md](security.md) | The security model and the item-by-item review, with the findings that are open. |
| [release.md](release.md) | Shipping it: readiness, the cutover of a tenant, the delivery of the image, what is still open. |

A reference to `§N` in the code, in the tests or in these documents is a
reference to a section of [spec.md](spec.md).

## Running it

```bash
bun install
HUB_SECRET_ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) bun run src/main.ts
```

Without a database in the environment, a development machine runs the
**embedded PostgreSQL** of the process (`pglite`) in `./.hub/pglite`: the
same PostgreSQL as the one of a deployment, so the migrations of the
production are the migrations of the development. `HUB_DATABASE_URL` names
a server (`postgres://…`) or another embedded database (`pglite://<path>`);
a production environment must name a server.

The tests run on the embedded PostgreSQL too:

```bash
bun test
HUB_TEST_DATABASE_URL=postgres://hub:hub@localhost:5432/hub bun test test/integration
```

The other commands:

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome lint
bun run format      # biome format --write .
bun run architecture # the import boundaries
```

## The gateway it brokers for

Shuttle is a **separate repository** and is read-only here. The version
this service is built against is the commit in [`../shuttle.ref`](../shuttle.ref).
The compatibility suite (`test/compatibility/`) runs the gateway,
unchanged, against this service, and the CI fails when the tree of the
reference is touched.

## The state of the release

Version `0.1.0`. The milestones M0 to M9 are closed: the process starts,
validates its environment, answers the probes, drains on a signal,
brokers the login of a caller, issues its own tokens, answers the
decisions of a gateway, and runs the gateway of the reference against
itself, unchanged.

What is **not** done is written down in [release.md](release.md) §6. It is
a short list, and it is a list of facts, not of intentions.
