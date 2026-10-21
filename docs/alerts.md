# The alerts of Hub

An alert is a question that somebody has to answer. The rules below are
the ones that the checklist of production readiness asks for
([IMPLEMENTATION.md](../IMPLEMENTATION.md) §11.2); every one of them is
answered by a metric of the service.

The metrics are at `/metrics` and they need `HUB_METRICS_TOKEN`.

| Metric | Type | Labels |
| --- | --- | --- |
| `hub_decisions_total` | counter | `result` (`allow`, `deny`), `tenant` |
| `hub_decision_duration_seconds` | histogram | `tenant` |
| `hub_logins_total` | counter | `result` (`success`, `refused`, `error`), `tenant` |
| `hub_admin_requests_total` | counter | `endpoint`, `status` |
| `hub_store_errors_total` | counter | `store` (`redis`, `postgres`) |

The label of the tenant is bounded: a hundred tenants and then
`overflow`. Neither a caller nor a provider can grow the number of the
series without limit.

## The rules

| # | The alert | The expression | For how long | What it means |
| --- | --- | --- | --- | --- |
| 1 | **The rate of the denials** | `rate(hub_decisions_total{result="deny"}[5m]) / rate(hub_decisions_total[5m]) > 0.2` | 10 min | A fifth of the requests are denied. It is either a deployment of a tenant that grants nothing, or an attack. The reason of the denial is in the log of the decision (`missingRole`, `principalMissing`, `principalDisabled`, `tenantDisabled`). |
| 2 | **The latency of the decision** | `histogram_quantile(0.99, rate(hub_decision_duration_seconds_bucket[5m])) > 0.02` | 5 min | The decision is on the path of every request of the gateway. The target is 20 ms at the `p99` (the numbers of the capacity are in [capacity.md](capacity.md)). |
| 3 | **The failures of the login** | `rate(hub_logins_total{result!="success"}[10m]) > 0.1` | 10 min | The logins of the tenants fail. The provider of a tenant is down, the tenant is disabled or the state of the login is refused. The runbook is in [runbooks.md](runbooks.md). |
| 4 | **The failures of the stores** | `rate(hub_store_errors_total[5m]) > 0` | 5 min | The database or the store is not reachable. The readiness turns `503` and the deployment is taken out of the rotation. |
| 5 | **The saturation of the pool** | `pg_stat_activity_count{application_name='hub'} > 7` | 5 min | The pool of the database is at 70 % (10 connections per replica). The decisions are slower and the logins wait. |
| 6 | **The age of the migrations** | `time() - max(hub_migrations_applied_at_seconds) > 86400` | 1 h | The schema of the database is a day older than the code of the deployment: the deployment did not apply its migrations. The replicas refuse to start against a schema they do not understand (spec §3.6). |
| 7 | **The refusals of the administration** | `rate(hub_admin_requests_total{status="401"}[5m]) > 0` | 5 min | Somebody tries to guess the token of the administration. The limiter refuses the address after five failures (`429`). |
| 8 | **The readiness** | `probe_success{job="hub"} == 0` | 2 min | The replicas do not answer their readiness: the database does not answer or the deployment is draining. |

## The rules that need a metric of the platform

| # | The alert | Where |
| --- | --- | --- |
| 9 | The replicas are not ready | The probe of the readiness of the deployment (`/readyz`). |
| 10 | The memory of the process | The memory of the pod of the deployment (200 MB, the target of the capacity). |
| 11 | The certificate of the ingress | The certificate of the ingress of the deployment. |
| 12 | The backup of the database | The age of the last dump ([backup.md](backup.md)). |

## What an alert does not do

An alert never restarts a replica by itself: a replica that cannot reach
the database restarts and fails again, and the restarts hide the cause.
The alert is read by a person, and the person follows the runbook.
