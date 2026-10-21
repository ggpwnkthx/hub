-- The isolation of the tenants, enforced by the database (spec §3.7).
--
-- The application already isolates the tenants: the keys of the four
-- tables carry the tenant, the foreign keys refuse a grant that names a
-- principal of another tenant, and every statement that reads a tenant
-- reads it by its id. This migration is the **backstop**: a statement
-- that forgets the tenant is refused by PostgreSQL itself.
--
-- The policy is permissive when the setting is not set. A statement that
-- is not scoped to a tenant (the administration, the decision of the
-- bearer token of the deployment) sees the whole platform, and that is
-- what it needs. A statement that is scoped to a tenant sets the setting
-- `hub.tenant_id`, and it sees the rows of that tenant and nothing else.
--
-- The setting is set with `set_config(..., true)`: it is local to the
-- transaction, so a pooled connection never carries the scope of another
-- request.

alter table tenants enable row level security;
alter table tenants force row level security;

create policy tenants_tenant_scope on tenants
  using (
    current_setting('hub.tenant_id', true) is null
    or id::text = current_setting('hub.tenant_id', true)
  );

alter table users enable row level security;
alter table users force row level security;

create policy users_tenant_scope on users
  using (
    current_setting('hub.tenant_id', true) is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );

alter table permissions enable row level security;
alter table permissions force row level security;

-- The catalogue of the platform (a permission without a tenant) is
-- visible from every tenant: it is not the data of a tenant.
create policy permissions_tenant_scope on permissions
  using (
    current_setting('hub.tenant_id', true) is null
    or tenant_id is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );

alter table grants enable row level security;
alter table grants force row level security;

create policy grants_tenant_scope on grants
  using (
    current_setting('hub.tenant_id', true) is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );
