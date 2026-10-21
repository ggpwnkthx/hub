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
[IMPLEMENTATION.md](IMPLEMENTATION.md) §4. The service is not built yet:
milestone M0 is the first one.
