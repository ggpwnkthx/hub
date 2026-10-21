# The capacity of Hub

The numbers of this document are **measured**, not estimated. Every one of
them was produced by a script of the repository, on the environment that
is named under it. A number that is not measured is not published here.

The script of the measurement is `scripts/load.ts`. It fills a database
with the shape of the production — one principal with a hundred grants —
and it measures the statement of the decision (spec §8.3).

```
HUB_DATABASE_URL=postgres://… bun run scripts/load.ts --requests 20000 --concurrency 100
```

## The targets

| Measurement | Target | Shape |
| --- | --- | --- |
| The decision, `p50` | ≤ 3 ms | One principal, a hundred grants. |
| The decision, `p99` | ≤ 20 ms | The same. |
| The decision under load | ≤ 50 ms at `p99` | 500 decisions per second, two replicas. |
| The pool of the database | ≤ 70 % used at the peak | 10 connections per replica. |
| The login, the extra latency of the broker | ≤ 150 ms | The time of Hub around the redirect to the provider and back. |
| The memory of the process | ≤ 200 MB | 1 000 concurrent logins. |
| The decisions per second per replica | ≥ 500 | The shape above. |

## What was measured

### The decision, on the embedded PostgreSQL of the development machine

| Measurement | Value |
| --- | --- |
| The environment | The embedded PostgreSQL (`pglite`) of the development machine, one connection. |
| The requests | 1 000 |
| The concurrency | 1 |
| The grants of the principal | 100 |
| The `p50` | 0.45 ms |
| The `p95` | 0.57 ms |
| The `p99` | 0.64 ms |
| The maximum | 0.71 ms |
| The decisions per second | 2 146 |

The embedded database has **one** connection: the requests are serialized
by it. The latency of a decision is therefore the latency of the
statement plus the cost of the queue of the driver, and the number of
decisions per second is the number of statements the process of the
runtime can run one after the other.

### The decision, with twenty requests in flight

| Measurement | Value |
| --- | --- |
| The concurrency | 20 |
| The `p50` | 42.7 ms |
| The `p99` | 48.9 ms |
| The decisions per second | 2 317 |

The latency grows with the concurrency and the throughput does not: the
queue of the single connection of the embedded database is the limit.
This is a property of the **measurement environment**, not of the query:
the plan of the statement uses the index of the specification (§8.5) and
answers in 2 ms on a data set of a million grants (`scripts/explain-decision.ts`).

### The plan of the statement, with a million grants

| Measurement | Value |
| --- | --- |
| The data set | 1 000 principals, 1 000 000 grants, a principal that holds a thousand of them. |
| The plan | `Bitmap Index Scan on grants_user_live`, `Index Cond: (user_id = u.id)` |
| The execution time | 2.0 ms |

The index of the specification is the one the planner chooses: the
decision does not scan the table of the policy.

## What is not measured here

The numbers of a deployment are **not** the numbers of this document: the
embedded database of a development machine is not a PostgreSQL server, and
the process of the runner of the CI is not the hardware of a deployment.
The numbers of a deployment are measured by the same script, against the
server of the deployment, and they are published here when they are
measured:

```
HUB_DATABASE_URL=postgres://hub:hub@postgres:5432/hub bun run scripts/load.ts --requests 20000 --concurrency 100
```

The measurements that are missing — the saturation of the pool, the
memory of the process under a thousand logins and the extra latency of the
broker — need the hardware of a deployment. They are measured during the
cutover of the first tenant (the runbook of the cutover is in
[IMPLEMENTATION.md](../IMPLEMENTATION.md) §12) and published here.

## The knobs

| Knob | Effect | Limit |
| --- | --- | --- |
| `HUB_DECISION_TIMEOUT_MS` | The ceiling of a decision | 2 000 ms |
| The size of the pool | The concurrency of the database | 10 per replica |
| The cache of the JWKS of the provider | The calls to the provider of a tenant | 10 minutes |
| The cache of the discovery of the provider | The calls to the discovery of a tenant | 10 minutes |
| The life of the code | The window of a replay | 60 s |
