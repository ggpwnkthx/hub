# The backup and the restore of Hub

The data of Hub is the five tables: `tenants`, `users`, `permissions` and
`grants`. Everything else is derived: the state of a login lives in the
cookie of the browser, the code of a login lives in the store for sixty
seconds, and the tokens are signed.

**A backup of the database is a backup of Hub.** The store of the codes
is not backed up: a code that is lost is a login that has to start again.

## The dump

The dump is a `pg_dump` of the database of the deployment, in the custom
format, compressed:

```bash
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --file "hub-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$HUB_DATABASE_URL"
```

The dump is written outside of the pod, and it is kept where the backups
of the platform are kept. The rule of the retention is the one of the
platform; a dump that is older than the retention of the platform is
deleted.

## The restore

```bash
createdb --owner=hub hub_restore
pg_restore --dbname=hub_restore --no-owner --no-privileges \
  --exit-on-error hub-20260108T100000Z.dump
```

The restore is rehearsed, in an environment that is not the production,
before every change of the process of the backup. The rehearsal answers
three questions:

1. Does the dump restore without an error? (`pg_restore --exit-on-error`)
2. Are the five tables there, with their constraints and their indexes?
   ```sql
   select count(*) from tenants;
   select count(*) from users;
   select count(*) from permissions;
   select count(*) from grants;
   select indexname from pg_indexes where tablename = 'grants';
   ```
3. Does the restored database accept the code of the current release? Run
   the service against it with `HUB_ENVIRONMENT=development` and the
   probes: the migrations are applied on a database that is already
   up to date and nothing changes.

## The target of the recovery

| Measurement | Target |
| --- | --- |
| The time of the recovery point | 24 h |
| The time of the recovery | 2 h |
| The rehearsal | Once a quarter, on the environment of the rehearsal |

The numbers are the ones of the checklist of production readiness; they
are measured during the rehearsal and published here when they are
measured.

## The migrations and the backup

The migrations of Hub are backward compatible for one release: a
rollback of the image does not need a rollback of the schema. The
migration that removes a column is two releases after the one that stops
using it.

A dump that is taken before a migration is restored into a database whose
schema is the old one: the runner of the migrations applies the
migrations that are missing ✓ — the bookkeeping of the migrations is in
the database itself (`hub_schema_migrations`).
