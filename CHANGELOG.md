# The changelog of Hub

The releases of Hub, the newest first. A release is a tag, and the tag
names the version of the package: the workflow of the release refuses a
tag that does not.

The **contract** of a release is the specification of that release
([`docs/spec.md`](docs/spec.md)): a change of behaviour is a change of
the specification first, in the same commit as the code. The table
below names the changes of the contract; the rest of a release is the
work that carries it.

## Unreleased

The work that the release `1.0.0` carries, before the tag.

### The contract

- **A key of a permission is a name inside a tenant.** Two tenants hold
  their own permission of the same key, and the grant of a tenant never
  names the permission of another tenant. Before, the second tenant of a
  deployment was refused with `403 forbidden` on a routine call
  (`PUT /v1/admin/grants`), because the first tenant owned the key.
  (spec §3.3, spec §10.6)
- **The bearer token of the deployment is deprecated.** It keeps
  working — the gateway of the reference sends it — but the service
  writes a notice in its log, once, the first time a decision presents
  it, and the notice names the scheme to use instead: the credentials of
  a tenant, which are scoped to it. (spec §8.8)

### The release

- **The image is built once.** The release publishes the build, and
  every gate of the release — the probes, the decisions, the refusals,
  the drain, the scan and the compatibility suite — runs against the
  **digest** of that build. The image that was tested is the image that
  runs. A release whose gates failed withdraws its image from the
  registry.
- **The compatibility suite runs against the published image.** The
  release starts the image by its digest and points the suite at it
  (`HUB_EXTERNAL_URL`); the suite never starts a Hub of its own when
  the environment names one.
- **The tag of the release is cut by the workflow.** When the version of
  the package goes up, the workflow `tag.yml` creates and pushes the tag
  `v<version>` — after the CI of the commit is green, and only when the
  versions of the project agree. The workflows of the release run on
  that tag.
- The version of the release is checked to be the version of a release:
  three numbers, and no pre-release.

### The documentation

- The numbering of the sections of the specification is stable: the
  access context is §9, the administration is §10, and the test
  `test/architecture/spec-references.test.ts` refuses a reference that
  points at nothing.

## 0.2.0

- The compatibility suite prepares the pinned revision of the gateway of
  the reference itself: the runner clones it, checks out the pinned
  commit, installs its dependencies and asserts that its tree is the one
  of the commit, before and after the run. The pin lives in
  `compatibility.json` and nowhere else.
- The pin of the reference is the release `0.5.0` of the gateway.

## 0.1.0

The first release of Hub: the milestones M0 to M9 are closed.

- **The login of the callers.** Hub brokers the login against the
  provider of a tenant, maps the external identity to a principal, and
  issues its own tokens to the gateway.
- **The decisions.** Hub answers the decision contract that the gateway
  of Shuttle already speaks, over a table of grants.
- **The access context contract.** The capabilities of a principal, for
  a data backend that needs more than a boolean.
- **The administration.** Nine endpoints and the audit of the changes,
  in a table.
- **The operations.** The probes, the metrics, the alerts, the runbooks,
  the drain, the backup and the restore.
- **The delivery.** The image and the standalone binaries, built by the
  tag of the release.
