-- The redirect uris of the gateway of the tenant (spec §3.1, §5.2).
--
-- The gateway is the client of Hub in the OpenID Connect flow of the
-- browser: it sends the url it wants the browser to come back to, and
-- Hub sends the code of the login there. That url is a value a caller
-- controls, so Hub checks it against the ones the gateway is registered
-- with: a url that is not registered is never sent a code.
--
-- The column is a list because the url of a gateway changes: the new one
-- is registered before the gateway is moved, and the old one is removed
-- after. A tenant whose list is empty refuses every login, which is the
-- answer of a deployment that has not registered its gateway yet.

alter table tenants add column client_redirect_uris text[] not null default '{}';
