-- The empty scope is the scope of the platform.
--
-- The scope of a tenant is set with `set_config('hub.tenant_id', …,
-- true)`, which sets it for the transaction that asks for it.
-- PostgreSQL reverts it when the transaction ends, and it leaves the
-- **placeholder** of the setting on the session: `current_setting
-- ('hub.tenant_id', true)` answers `''` and not `null` on a connection
-- that has run a scoped statement.
--
-- A policy that reads `current_setting(…) is null` therefore treats
-- every row of the platform as invisible on such a connection: the
-- administration of the platform stops working on the second call, on
-- the connection of the pool that served the first one, and the write
-- of a principal is refused by the policy of the table. The pool makes
-- the leak certain: a connection of a pool is a connection that is
-- reused.
--
-- The empty scope is the scope of the platform, and the policies are
-- rewritten with it. The rows of a tenant are still hidden from a
-- connection that carries the scope of that tenant: the rule of the
-- isolation is not weakened, it is stated the way PostgreSQL holds it.

drop policy tenants_tenant_scope on tenants;
create policy tenants_tenant_scope on tenants
  using (
    nullif(current_setting('hub.tenant_id', true), '') is null
    or id::text = current_setting('hub.tenant_id', true)
  );

drop policy users_tenant_scope on users;
create policy users_tenant_scope on users
  using (
    nullif(current_setting('hub.tenant_id', true), '') is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );

drop policy permissions_tenant_scope on permissions;
create policy permissions_tenant_scope on permissions
  using (
    nullif(current_setting('hub.tenant_id', true), '') is null
    or tenant_id is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );

drop policy grants_tenant_scope on grants;
create policy grants_tenant_scope on grants
  using (
    nullif(current_setting('hub.tenant_id', true), '') is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );

drop policy groups_tenant_scope on groups;
create policy groups_tenant_scope on groups
  using (
    nullif(current_setting('hub.tenant_id', true), '') is null
    or tenant_id::text = current_setting('hub.tenant_id', true)
  );
