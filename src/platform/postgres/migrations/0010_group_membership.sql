-- The membership of the groups, checked by the database (spec §3.5).
--
-- The membership of a group is a list of the ids of its members, and a
-- list has no foreign key: the database cannot know that a member is a
-- principal of the tenant of the group. The application knows it — the
-- administration refuses a member that is not a principal of the tenant
-- with a `404` — but the constraint of the model belongs to the schema,
-- and not to the application.
--
-- A constraint trigger checks the membership when the group is written:
-- every member is a principal of the tenant of the group. It is deferred
-- to the end of the transaction, so a principal that is created in the
-- same transaction as the group is seen.
--
-- The membership is not a table of its own: the model of Hub is five
-- tables (spec §3), and the membership is part of the row of the group.
-- The cost of that choice is that the membership is not paginated and
-- that the decision pays the price of the containment of the list.

-- The code of the failure of the membership.
--
-- It is the code of the check of a constraint of PostgreSQL, with the
-- name of the constraint of Hub: the application turns it into the
-- `404` of a member that is not a principal (spec §10.9).
create or replace function hub_check_group_membership() returns trigger
language plpgsql as $$
declare
  member uuid;
begin
  for member in select unnest(new.members) loop
    if member is null then
      raise exception 'the membership of a group holds an empty member'
        using errcode = '23514', constraint = 'groups_membership_is_principals';
    end if;
    if not exists (
      select 1 from users where users.id = member and users.tenant_id = new.tenant_id
    ) then
      raise exception 'the member % is not a principal of the tenant of the group', member
        using errcode = '23514', constraint = 'groups_membership_is_principals';
    end if;
  end loop;
  return new;
end;
$$;

create constraint trigger groups_membership_is_principals
  after insert or update of members on groups
  deferrable initially deferred
  for each row execute function hub_check_group_membership();
