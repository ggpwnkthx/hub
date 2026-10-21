-- The rotation of the secret of the gateway of a tenant (spec §4.3).
--
-- The secret of the gateway of a tenant is presented by the gateway on
-- every call of the decisions. A rotation of it is a change of the
-- credential of the gateway and of the credential of Hub at the same
-- time, and a deployment that changes one of them before the other one
-- refuses every call in between.
--
-- The secret that is replaced is kept for a while: the two secrets are
-- accepted during the window, and the old one stops being accepted when
-- the window is over. The rotation is then a rolling one: the gateway is
-- changed first, the tenant is changed second, and the old secret is
-- dropped by the deployment that owns it.
--
-- The secret of the provider of the tenant is not kept: Hub is the one
-- that presents it, and a provider that rotates it invalidates the old
-- one itself.

alter table tenants add column previous_client_secret bytea;

alter table tenants add column previous_client_secret_until timestamptz;
