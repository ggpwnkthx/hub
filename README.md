# Hub

An OpenID Connect **broker** and an **access decision service**. It
authenticates a caller against the identity provider of a tenant, maps the
external identity to a principal, issues its own tokens to a Shuttle
gateway, and answers the decision contract that gateway already speaks.

**The documentation is in [`docs/`](docs/README.md).**

| Document | What it holds |
| --- | --- |
| [docs/spec.md](docs/spec.md) | The normative behavior: the contract of the service. |
| [docs/api.md](docs/api.md) | The HTTP surface: every endpoint, its request, its answer. |
| [docs/architecture.md](docs/architecture.md) | How the code is laid out and what the build checks. |
| [docs/operations.md](docs/operations.md) | Deployment, configuration, probes, alerts, runbooks, capacity. |
| [docs/security.md](docs/security.md) | The security model and the review, with the open findings. |
| [docs/release.md](docs/release.md) | Readiness, the cutover of a tenant, the delivery, the known limits. |
| [docs/compatibility.md](docs/compatibility.md) | The pinned gateway of the reference and the runner of the compatibility suite. |

## The projects it is part of

| Project | Repository | What it is |
| --- | --- | --- |
| Hub | [ggpwnkthx/hub](https://github.com/ggpwnkthx/hub) | This repository: the OpenID Connect broker and the access decision service. |
| Shuttle | [ggpwnkthx/shuttle](https://github.com/ggpwnkthx/shuttle) | The HTTP gateway. It is the client of Hub: it authenticates a caller at Hub, it asks Hub for a decision and it forwards the identity of the principal to the upstream. |
| Depot | [ggpwnkthx/depot](https://github.com/ggpwnkthx/depot) | The backend of the platform. It reads the access context of Hub at `/v1/access-context` to know what a caller may do. |

The three are separate repositories and separate services. Hub talks to
them over HTTP and over OpenID Connect, and it depends on neither of
them at runtime: the compatibility suite runs the **real** gateway of
Shuttle, unchanged, against Hub, and the pin of that reference lives in
[`compatibility.json`](compatibility.json).

```bash
bun install
HUB_SECRET_ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) bun run src/main.ts

bun run test        # the tests of this repository
bun run test:compat # the real gateway of Shuttle, unchanged, against Hub
bun run test:all    # the two
```
