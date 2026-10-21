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

```bash
bun install
HUB_SECRET_ENCRYPTION_KEY=$(printf 'a%.0s' {1..64}) bun run src/main.ts
bun test
```
