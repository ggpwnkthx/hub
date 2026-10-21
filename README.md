# Hub

Hub is an OpenID Connect broker and an access decision service for the
platform that Shuttle fronts.

- It brokers the login of a caller against the identity provider of a
  **tenant** and issues its own tokens to a **Shuttle** gateway.
- It maps the external identity `(tenant, subject)` to a **principal**.
- It answers the decision contract the gateway already speaks,
  `POST /v1/decisions`, over a table of **grants**.
- It is administered with five `curl` endpoints.

The whole domain model is four tables: `tenants`, `users`, `permissions`,
`grants`.

| Document | What it holds |
| --- | --- |
| [SPEC.md](SPEC.md) | The normative behavior. The only document that changes the contract. |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | How it is built, in what order, and what has to be true before it carries a customer. |
| [BUILD-PROMPT.md](BUILD-PROMPT.md) | The prompt that starts the build, with the map of the reference. |

## The reference

Shuttle, the gateway this service brokers for, is a **separate
repository**. It is read-only here and is never modified.

| | |
| --- | --- |
| The repository | `https://github.com/ggpwnkthx/shuttle.git` |
| The local clone | `../shuttle` |
| The version this service is built against | the commit in [shuttle.ref](shuttle.ref) |

The compatibility suite (`test/compatibility/`) runs the gateway, unchanged,
against this service, and the build fails when the tree of the reference is
touched.

## The status

The plan of the first release is in
[IMPLEMENTATION.md](IMPLEMENTATION.md) §4. The skeleton (milestone M0) is
built: the process starts, validates its environment, answers the probes
and drains on a signal.

## Running it

```bash
bun install
bun run src/main.ts
```

Without a database in the environment, a development machine runs the
**embedded PostgreSQL** of the process (`pglite`) in `./.hub/pglite`: the
same PostgreSQL as the one of a deployment, so the migrations of the
production are the migrations of the development. `HUB_DATABASE_URL`
names a server (`postgres://…`) or another embedded database
(`pglite://<path>`); a production environment must name a server.

The environment is read in `src/runtime/env.ts` and validated as a whole:
a value that cannot be understood stops the process and the message names
the variable. The variables are in [SPEC.md](SPEC.md) §4.

| Probe | What it answers |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok","service":"hub","version":"0.1.0"}` |
| `GET /readyz` | `200` when the database answers, `503 {"status":"draining"}` during a drain, `503 {"status":"not-ready"}` otherwise |

The tests run on the embedded PostgreSQL too:

```bash
bun test
HUB_TEST_DATABASE_URL=postgres://hub:hub@localhost:5432/hub bun test test/integration
```

The image is built with `docker build -f Dockerfile .`: it runs as a user
that is not root and the base image is pinned by digest.
