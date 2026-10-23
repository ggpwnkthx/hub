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

The work that the next release carries.

### The contract

- **The flags of a tenant that belong to the platform are the work of the
  operator of the platform.** A credential of a tenant may not change the
  `shared_client` of its tenant, nor the `is_default` of the platform: a
  call that carries a value that is not the value of the row is a `403
  forbidden` (spec §10.1). The shared client moves the logins of the
  platform, and the default tenant routes the logins of the shared
  clients: they are not the decision of a tenant operator.
- **The credentials of a gateway are always scoped to their tenant.** A
  tenant whose `shared_client` is true may log in the principals of the
  other tenants, and its decisions are still scoped to its own tenant:
  the scope of a decision is the scope of the credential, and not a flag
  that a row carries. The bearer token of the deployment is the only
  scheme that is not scoped, and it is deprecated (spec §8.8). **A
  deployment whose gateway uses a shared client and asks about the
  principals of the other tenants moves its gateway to the bearer token
  of the deployment**: the credentials of a tenant no longer reach the
  principals of the other tenants.
- **The budget of the limiter of the administration is spent by the calls
  that fail.** A call that authenticates itself is answered, whatever the
  address presented before: an address that used up its budget cannot
  lock out the operator that holds the token (spec §10.1).
- **The call to a provider is made to the address that was checked.** The
  guard of the addresses resolves the host of the provider and pins the
  address it resolved to, and the call is made to that address, with the
  name of the host in the `Host` header and in the name the certificate
  is checked against. The name of the host is never resolved a second
  time (spec §6.1).
- **The answers carry the headers of a browser.** Every answer carries
  `x-content-type-options`, `x-frame-options` and `referrer-policy`, a
  page of a refusal carries a `content-security-policy`, and the answer
  of the token endpoint carries `cache-control: no-store` and `pragma:
  no-cache`: a token is never stored by a cache (spec §5.6).

### The rest

- The answer of a provider is read up to one MiB: a provider that answers
  more than that is not reachable.
- A cookie of the state of a login that is not a valid escape refuses the
  login with `400 login_state_invalid` instead of `500`.
- The export of the audit in CSV quotes a cell that begins with the
  character of a formula: a spreadsheet reads a value, not a formula.

## 1.0.1

A **PATCH** release: the behaviour of the service does not change, and
the contract of the specification does not change either. The release
carries the pin of the reference at the release `1.3.0` of the gateway
and the documents that follow it.

The release is the one that proves the published image against the
gateway of the release `1.3.0`: the release `1.0.0` was proven against
the gateway of the release `1.2.0`.

### The release

- **The pin of the reference is the release `1.3.0` of the gateway.** The
  release `1.3.0` of the gateway gives the deployment a control plane of
  its own — a separate process that acts on the shared state — and lets
  the route table live in the shared state instead of in a file. The
  contracts Hub speaks are extended and never changed: the protocol of
  the decisions, the tokens of Hub and the headers of the identity are
  the ones the gateway already speaks, and the file of the route table
  is still the default. The pin of `compatibility.json` moves to the
  commit of the release, the suite is green against it, and the tree of
  the reference is not modified by the run.

## 1.0.0

The release that closes the milestones of Hub: the service brokers the
login of a caller against the provider of a tenant, it issues its own
tokens to the gateway, it answers the decisions of the gateway, and the
administration of the whole thing is nine `curl` calls and an audit that
is exported.

The contract of the release is the specification
([docs/spec.md](docs/spec.md)), and it changed since the release `0.2.0`:
the administration has a credential per tenant, a denial carries the
code of its reason, the secrets of a deployment may be in a file, the
grants of a tenant are scoped to it, and the shared secret of the
decisions is optional and deprecated.

The compatibility suite runs the real gateway of Shuttle, unchanged,
against the published image of the release, and the gateway it is run
against is the release `1.2.0` of it.

### The contract

- **The administration has a credential per tenant.** A deployment may
  name its credentials in `HUB_ADMIN_TOKENS`, a json object of bearer
  tokens and of their scopes. A credential of a tenant may only act for
  that tenant — a call that names another one is a `403 forbidden`, the
  lists it reads are the lists of its tenant, and the filter of a query
  cannot widen them — and it may carry the **name** of its operator, and
  the audit of a change names the operator and not the fingerprint of a
  shared secret. `HUB_ADMIN_TOKEN` keeps working and keeps the scope of
  the platform. (spec §4.6, spec §10.1)
- **A denial carries the code of its reason.** The answer of `POST
  /v1/decisions` carries `reasonCode` beside the free text of the reason:
  `missing_role` for a denial of a role, `access_denied` for every other
  denial. The gateway counts the code when the service sends one and
  counts the text of the reason when it does not, so the code and the text
  always agree: the metric of the gateway is the same with the gateway of
  the reference and with the next one, and a reason that is reworded does
  not change it. The gateway of the reference ignores the field; the next
  one reads it. (spec §8.2, spec §8.7)
- **A secret of the deployment may be in a file.** Every secret of the
  environment may be given as `HUB_<NAME>_FILE` instead of `HUB_<NAME>`:
  the file holds the value and the trailing newline is removed. A
  variable and its file are not set at the same time, and a file that
  cannot be read stops the service. It is how a secret reaches a
  container: a secret of a deployment is a file that a secret manager
  writes, and a private key in a variable of the environment is a
  private key that a shell mangles. (spec §4.5)
- **The secrets of a deployment are not short and not the values of the
  example.** Every bearer token of the environment is at least 16 bytes
  long, and a production deployment refuses to start when one of them is
  shorter, or when one of its secrets is a value of `.env.example` or a
  secret that is one repeated character (`000…0`, `111…1`). The length of
  a secret is the first thing that is tried, and the example file is
  published: a deployment that copied it into a production one kept a
  published secret. (spec §4.1, spec §4.4)
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
- **The bearer token of the deployment is optional.** It is not required
  in a production environment any more: a deployment that does not set
  `HUB_ACCESS_TOKEN` accepts only the credentials of a tenant, and the
  bearer scheme is refused with `401 unauthorized`. This is the end of
  the migration of the third open finding of the security review, and it
  was unreachable while the token was required. (spec §4.4, spec §8.8)
- **The previous token of the decisions without the token it replaced is
  refused at the start.** A deployment that removes the shared secret
  removes it entirely: a `HUB_PREVIOUS_ACCESS_TOKEN` without a
  `HUB_ACCESS_TOKEN` is a configuration error, and the service says so
  instead of starting with the secret it believes it has removed.
  (spec §4.3.1)
- **The code of a login belongs to the client that began it.** With a
  shared client, the tenant of the login may be another one, and the
  code and the audience of the tokens belonged to the tenant of the
  login: the gateway, which presents the client id it is registered
  with, was refused with `invalid_grant`. The shared client — the
  escape hatch of the topology of one gateway for several tenants — did
  not work at all. (spec §5.2)
- **The rate limit of the administration is the limit of the
  deployment.** The count of the failed authentications is held by the
  shared store and not by the memory of the process: a deployment of
  several replicas does not accept five times the budget. The second
  open finding of the security review is closed. (spec §10.1)
- **The database checks the membership of the groups.** The membership
  is a list of ids and a list has no foreign key: a constraint trigger
  refuses a member that is not a principal of the tenant of the group,
  and the refusal is the `404` of the administration. The model of Hub
  is still five tables. (spec §3.5)
- **The audit of the administration is exported.** The endpoint of the
  audit answers `csv` and `jsonl` besides `json`: the rows leave the
  platform in a file that a spreadsheet or a script reads. The audit was
  a table and not a report; it is a table and a file now. (spec §10.12)
- **The administration writes batches.** `POST /v1/admin/users` and
  `PUT /v1/admin/grants` carry a list in their body: one call writes a
  hundred principals or a hundred grants instead of a hundred calls. It
  is the call that onboards a tenant, and it is the **same** endpoints:
  the administration surface is still nine endpoints. Every item is
  written on its own and audited, and the answer names the outcome of
  every one of them. (spec §10.4, spec §10.6)

### The release

- **The dead code is a gate.** The build fails when the repository holds
  a file that no program reaches, or an export that no file imports:
  `knip` reads the source, the tests and the scripts, and names what
  nothing uses. `bun run dead-code` is the gate and `bun run
  dead-code:fix` removes the exports it finds. The check found the file
  of the shared store that no program reached, and the hundred and
  sixty-two exports that no file imported — among them the fifteen
  symbols that nothing used at all: they are gone, and the surface of
  the domains is the one the code uses.
- **The capacity of the decision is a gate.** The measurement of the CI
  fails the build when the decision is outside of its thresholds: a
  decision that got slower — a plan that changed, an index that was
  dropped — is a failure of the build and not a number in a log. The
  thresholds of the CI are far above the targets of the operations, so
  the gate catches a regression and not a busy runner.
  (docs/operations.md)
- **The dependencies are scanned and they are kept.** `bun audit` runs on
  every build, and Dependabot opens the pull request that moves a pinned
  version: the versions are pinned, and the scan of the tree is what
  says that a pinned version is not a known one.
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
- **The pin of the reference is the release `1.2.0` of the gateway.**
  The gateway of the reference was three releases behind: the release
  `1.0.0` froze its contracts and removed the symmetric format of the
  signature of the identity, the release `1.1.0` added the code of the
  reason of a denial to the protocol of the access service, and the
  release `1.2.0` requires an expiry on a bearer token and bounds its
  lifetime with the moment it was issued. The pin of
  `compatibility.json` moves to the commit of the release, the suite is
  green against it, and the tree of the reference is not modified by the
  run.
- **The suite proves the contract of the bearer token.** The
  compatibility suite now holds a route that accepts a bearer token, and
  it plays the client that the gateway is: it logs a browser in at the
  provider of the tenant, it exchanges the code at the token endpoint of
  Hub, and it presents the access token to the gateway. The gateway of
  the release `1.2.0` refuses a bearer token that carries no expiry, and
  it bounds the lifetime of a token with the moment it was issued: the
  token of Hub carries the two, and its lifetime is five minutes. The
  suite proves that the gateway refuses the id token of Hub as a bearer
  credential too: it travels through the browser, and it carries a
  nonce. (spec §7.2)
- **The tag of the release is cut by the workflow.** When the version of
  the package goes up, the workflow `tag.yml` creates and pushes the tag
  `v<version>` — after the CI of the commit is green, and only when the
  versions of the project agree. The workflows of the release run on
  that tag.
- **The integration tests have a schema of their own.** Every file of
  `test/integration/` runs in a schema of its own against a server: the
  rows of a file do not share their rows with the rows of another file,
  and a second run of the suite starts from a schema that is empty. The
  file of the schema of Hub ran in the schema `public` and shared it
  with everything else that wrote there, so the second run of the suite
  against the same server was refused on a row that was already there.
  (test/integration/database.ts, test/integration/schema.test.ts)
- The version of the release is checked to be the version of a release:
  three numbers, and no pre-release.

### The documentation

- **The contract with the gateway of the release `1.2.0` is written
  down.** The claims of the access token of Hub are a table, and the two
  rules that the gateway applies to a bearer token are named: the token
  has to carry an expiry, and the gateway bounds its lifetime with the
  moment it was issued. The table of §13 says what the releases `1.0.0`,
  `1.1.0` and `1.2.0` of the gateway changed, and §8.8 says that the
  gateway of the reference presents the shared token and nothing else: it
  has no scheme for the credentials of a tenant. The guide of the
  operations names the two variables that a production deployment of the
  gateway asks for since the release `1.0.0`.
  (spec §7.2, spec §8.8, spec §13, docs/operations.md)
- **The guide of a contribution.** `CONTRIBUTING.md` holds the order of a
  change — the specification first, the code, the other documents, the
  tests — the commands, the tests of each layer and the style of the
  repository. The template of a pull request asks the two questions that
  matter: what the change does, and the contract it changes.
- **The dependencies of a development machine.** A compose file brings
  the PostgreSQL and the Redis of a deployment up, so that the tests
  that need them run on a machine and not only in the CI.
- **The database of the development machine is PostgreSQL 18.** The
  compose file, the jobs of the CI and the gates of the release run
  PostgreSQL 18, and the embedded PostgreSQL of a development machine is
  that version: one version everywhere, so a migration that the tests
  accept is a migration the CI accepts. A deployment names the server it
  uses and the service does not read its version — the version of the
  database of a deployment is the choice of the operator.
  (docs/operations.md)
- **The topology of a shared client is written in one place.** §1.4 said
  that the schema does not allow one gateway for several tenants, and
  §5.2 described the escape hatch that does: the client id is unique,
  and a shared client is a tenant whose gateway may log in the
  principals of the other tenants. The two now say the same thing.
- **The routes and the documents agree.** A test reads the routes the
  application registers and the routes the documents name, and the two
  sets have to be the same one: a route that is added is documented in
  the same commit, and a route that is removed is removed from the
  documents in the same commit. (`test/architecture/routes.test.ts`)
- **The environment of the workflows starts a production deployment.**
  A test reads the secrets that the workflows name and holds that the
  service starts with them: a workflow that names a secret the service
  refuses is a workflow that fails in the middle of a release, and the
  refusal is now a failure of the build and not of a release.
  (`test/architecture/workflows.test.ts`)
- **The number of the administration is the number of the code.** The
  test that holds the documents and the code on the size of the
  administration reads the number from the code instead of carrying it:
  a surface that grows is a surface that the documents may describe with
  its new number, and the test names the documents that were not
  changed. (`test/architecture/counts.test.ts`)
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
