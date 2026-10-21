-- The groups of the principals (spec §3.5).
--
-- A group is a set of principals of a tenant. A grant may name a group
-- instead of a principal: the grant then holds for every member of the
-- group. The fifth table of the domain was asked for by the operator of
-- the platform (spec §13).
--
-- The membership is a list of the principals of the group and not a table
-- of its own: it is written in one statement by the call of the
-- administration, and it is read by the decision of a principal.

create table groups (
  id uuid primary key default gen_random_uuid(),
  -- The tenant of the group.
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- The name of the group, the name the operator uses.
  key text not null check (key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- The name shown to a human.
  display_name text,
  -- The principals of the group. Every member is a principal of the
  -- tenant at the moment the membership is written.
  members uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint groups_tenant_key unique (tenant_id, key),
  -- The pair is unique so a grant can carry the tenant of its group in a
  -- foreign key.
  constraint groups_id_tenant unique (id, tenant_id)
);

-- A grant names exactly one subject: a principal or a group.
alter table grants alter column user_id drop not null;
alter table grants add column group_id uuid;
alter table grants add constraint grants_one_subject
  check ((user_id is null) <> (group_id is null));
alter table grants add constraint grants_group_tenant
  foreign key (group_id, tenant_id) references groups (id, tenant_id) on delete cascade;

-- The live grants of a group: the question "who may use this workspace"
-- is asked over the grants that are not revoked, and the grants of a
-- group are read by the group.
create index grants_group_live on grants (group_id) where revoked_at is null and group_id is not null;

-- The live grants of a group are unique by the scope of the group, like
-- the live grants of a principal.
create unique index grants_live_group_scope
  on grants (tenant_id, group_id, permission_id, coalesce(workspace_id, ''), coalesce(route_id, ''))
  where revoked_at is null and group_id is not null;

-- The isolation of the tenants reaches the new table as well (spec §3.9).
alter table groups enable row level security;
alter table groups force row level security;

create policy groups_tenant_scope on groups
  using (
    current_setting('hub.tenant_id', true) is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );
