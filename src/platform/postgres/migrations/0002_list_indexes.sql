-- The indexes of the two list endpoints (spec §10.5, §10.8).
--
-- The lists are ordered by the newest first and they are paginated: the
-- index carries the order of the page and the tenant, so a page is a
-- range of the index and not a sort of the table.

-- The principals of a tenant, the newest first.
create index users_tenant_created on users (tenant_id, created_at desc, id desc);

-- The lookup of a principal by its e-mail: it is a display value, never
-- a key, so the index is partial and the rows without one are not in it.
create index users_email on users (email) where email is not null;

-- The grants of a tenant, the newest first.
create index grants_tenant_created on grants (tenant_id, created_at desc, id desc);

-- The grants of a principal, the newest first.
create index grants_user_created on grants (user_id, created_at desc, id desc);

-- The live grants of a tenant: the question "who may use this workspace"
-- is asked over the grants that are not revoked.
create index grants_tenant_live on grants (tenant_id, created_at desc, id desc)
  where revoked_at is null;
