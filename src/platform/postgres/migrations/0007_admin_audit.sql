-- The audit of the administration (spec §10.1, §10.12).
--
-- The audit is what an operator of the platform asks for when a grant
-- appears that nobody remembers: who changed it, when, and from which
-- address. A log line answers that question only while the logs of the
-- deployment are shipped, are kept and are searchable; a table answers
-- it for as long as the table is there.
--
-- The table is not one of the five tables of the domain model: it holds
-- no tenant, no principal and no grant, and it is not scoped by the
-- isolation of the tenants, because the administration of the platform is
-- not the administration of a tenant. It is a table of the infrastructure,
-- like the table of the migrations.
--
-- The row of an audit never carries a secret: it carries the name of the
-- action, the identifier of the thing that changed, the tenant it
-- belongs to, the operator, the address and the request.

create table admin_audit (
  id uuid primary key default gen_random_uuid(),
  -- The moment of the change.
  at timestamptz not null default now(),
  -- What happened: `tenant.created`, `grant.revoked`, and so on.
  action text not null,
  -- The identifier of the thing that changed.
  target_id text,
  -- The slug of the tenant, when the change belongs to one.
  tenant text,
  -- The fingerprint of the credential of the operator: it names the
  -- operator without naming its secret.
  operator text,
  -- The address of the socket of the call.
  address text,
  -- The identifier of the request, as it is in the logs of the service.
  request_id text
);

-- The audit is read from the most recent change to the oldest one.
create index admin_audit_at on admin_audit (at desc);

-- The audit of a tenant is read on its own.
create index admin_audit_tenant on admin_audit (tenant, at desc);
