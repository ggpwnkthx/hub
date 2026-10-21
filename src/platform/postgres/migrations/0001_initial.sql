-- The four tables of Hub (spec §3). The fifth one, `groups`, came later
-- with the groups of the principals (spec §3.5).
--
-- The whole domain model of Hub is in this file: there is no table "for
-- later". A feature that needs a fifth table is a feature that has to be
-- paid for first (spec §13).

-- One row per customer. It carries the registration of the provider of the
-- tenant and the registration of the gateway of the tenant.
create table tenants (
  id uuid primary key default gen_random_uuid(),
  -- The stable name of the tenant, the name the operator uses.
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,63}$'),
  -- The name shown to a human.
  display_name text not null,
  -- A disabled tenant denies every decision and refuses every login.
  enabled boolean not null default true,
  -- At most one tenant is the default (spec §5.2).
  is_default boolean not null default false,
  -- Whether an unknown external identity creates a principal row.
  auto_provision boolean not null default false,
  -- The domain of the tenant; a hint, never an authorization.
  email_domain text unique,
  -- The registration of the provider of the tenant.
  idp_issuer text not null,
  idp_client_id text not null,
  -- The client secret of Hub at the provider, encrypted at rest (spec §4.3).
  idp_client_secret bytea not null,
  idp_redirect_uri text not null,
  idp_scopes text[] not null default array['openid', 'email', 'profile'],
  idp_algorithms text[] not null default array['RS256'],
  -- The registration of the gateway of the tenant at Hub.
  client_id text not null unique,
  -- The secret of the gateway of the tenant, encrypted at rest.
  client_secret bytea not null,
  -- Whether the gateway of this tenant may log in principals of others.
  shared_client boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one tenant is the default: the second one is a conflict.
create unique index tenants_one_default on tenants ((is_default)) where is_default;

-- One row per principal. It is the identity of the platform.
create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- The `sub` of the provider of the tenant: the mapping key is the pair
  -- (tenant, subject) and never the e-mail (spec §6.2).
  external_subject text not null,
  -- The last e-mail seen at the provider. A display value, never a key.
  email text,
  -- The last name seen at the provider.
  display_name text,
  -- A disabled principal is refused at the login and denied at every
  -- decision.
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_tenant_subject unique (tenant_id, external_subject),
  -- The pair is unique so a grant can carry its tenant in a foreign key.
  constraint users_id_tenant unique (id, tenant_id)
);

-- A named capability. It is a role of the platform: it travels in the
-- `roles` claim and it is what a grant gives.
create table permissions (
  id uuid primary key default gen_random_uuid(),
  -- The tenant that owns the permission, or null when it belongs to the
  -- catalogue of the platform.
  tenant_id uuid references tenants (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  description text,
  -- A disabled permission is never given by a grant.
  enabled boolean not null default true
);

-- The unique index uses a coalesce: null is not equal to null in a unique
-- index of PostgreSQL, and the catalogue of the platform would otherwise
-- accept two rows with the same key.
create unique index permissions_tenant_key
  on permissions (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- The policy of the platform: this principal holds this permission, on
-- this workspace, on this route, until this date.
create table grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  -- The principal of the grant. A grant can never name a principal of
  -- another tenant: the foreign key carries the tenant.
  user_id uuid not null,
  permission_id uuid not null references permissions (id),
  -- The workspace of the grant, or null for every workspace of the tenant.
  workspace_id text,
  -- The route of the grant, or null for every route.
  route_id text,
  -- Null when the grant does not expire.
  expires_at timestamptz,
  -- Null while the grant is alive: a revoked grant is kept, it is not
  -- deleted.
  revoked_at timestamptz,
  -- Who granted it, for the audit log.
  granted_by text,
  created_at timestamptz not null default now(),
  constraint grants_user_tenant foreign key (user_id, tenant_id) references users (id, tenant_id)
);

-- The unique index uses a coalesce for the same reason as the one of the
-- permissions: a grant of "every workspace" and a grant of "the workspace
-- ''" have to be two different rows.
create unique index grants_live_scope
  on grants (tenant_id, user_id, permission_id, coalesce(workspace_id, ''), coalesce(route_id, ''))
  where revoked_at is null;

-- The grants of the principal: the query of the decision is an EXISTS
-- over this index (spec §8.5).
create index grants_user_live on grants (user_id) where revoked_at is null;
