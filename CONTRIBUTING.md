# Contributing to Hub

Hub is a service whose **contract is a document**. The behaviour of the
service is written down in [docs/spec.md](docs/spec.md), and a change of
behaviour is a change of that document first, in the same commit as the
code. A pull request that changes the behaviour and does not change the
specification is a pull request that changes the contract of a service
that carries a customer.

## The order of a change

1. **The specification.** `docs/spec.md` is normative: the behaviour of
   the service is what it says. A change of behaviour is a change of
   the specification first.
2. **The code.** The rules live in the domains
   (`src/domains/`), the handlers are thin (`src/app/`), the adapters
   are the storage (`src/platform/`) and the composition root wires them
   (`src/runtime/`). The boundaries are checked by
   `bun run architecture`.
3. **The other documents.** `docs/api.md` holds the wire format,
   `docs/operations.md` the running of the service, `docs/security.md`
   the review of the security model, and `CHANGELOG.md` the releases and
   the changes of the contract of each one.
4. **The tests.** A rule that has no test is a rule that is not
   implemented.

The tests of the repository are the mirror of the layers:

| Kind | Where | What it proves |
| --- | --- | --- |
| Unit | `src/domains/*/*.test.ts` | The rules of the domains. |
| Contract | `test/contract/` | The behaviour of the HTTP surface. |
| Integration | `test/integration/` | The behaviour against a real PostgreSQL and a real Redis. |
| Architecture | `test/architecture/` | The boundaries, the numbers of the documents, the routes and the documents. |
| Tooling | `test/tooling/` | The runner of the compatibility suite. |
| Compatibility | `test/compatibility/` | The **real gateway of Shuttle, unchanged, against Hub**. |

## The commands

```bash
bun install
bun run test         # the tests of this repository
bun run test:compat  # the real gateway of the reference, against Hub
bun run test:all     # the two
bun run typecheck    # tsc --noEmit
bun run lint         # biome lint
bun run format       # biome format --write .
bun run architecture # the import boundaries
```

The compatibility suite clones the gateway of the reference at the
commit that `compatibility.json` pins. It needs the network, or a
checkout that is already prepared (`HUB_SHUTTLE_PATH`). The manual is in
[docs/compatibility.md](docs/compatibility.md).

The integration tests run on the embedded PostgreSQL of the process by
default. A compose file brings the real PostgreSQL and the real Redis up
for the tests that need them:

```bash
docker compose up -d
HUB_TEST_DATABASE_URL=postgres://hub:hub@localhost:5432/hub \
HUB_TEST_REDIS_URL=redis://localhost:6379/0 bun run test
```

## How to write here

The house style of the documents and of the comments is plain and
declarative:

- **Say what is true, and say it once.** A rule that is written in two
  places is a rule that is written in one place and contradicted in the
  other.
- **Name the subject.** "The comparison of the secrets is in constant
  time" is a rule; "the secrets are compared safely" is not.
- **A sentence is a sentence.** The documents of this repository are
  read by people and by tools: a long sentence that carries three rules
  is three sentences.
- **A number is a number.** "Nine endpoints" is nine in the code and
  nine in the documents, and a test holds them together.
- **English, and no other language.** The documents, the comments and
  the messages of the logs are in English.

## The commits

A commit is one change, and its message says what it changes:

```
feat: the administration has a credential per tenant
fix: the secrets of a deployment are not short
docs: the routes and the documents agree
```

The style of the repository is the one of the messages: the subject says
what the change does, in the present tense, without a prefix of a type
beyond `feat`, `fix`, `docs`, `test`, `chore` and `refactor`.
