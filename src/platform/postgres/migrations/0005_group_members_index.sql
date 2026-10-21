-- The index of the membership of the groups (spec §3.5, §8.5).
--
-- The membership of a group is a list of the principals of the group and
-- not a table of its own. The question that is asked on every decision is
-- "which groups hold this principal", and the predicate that answers it
-- is a containment: `groups.members @> array[principal]`.
--
-- The index of the containment is a GIN index on the array. Without it
-- the predicate cannot be served by an index, and every decision that
-- reads a grant of a group walks the groups of the tenant and reads
-- every member list of them.

create index groups_members_gin on groups using gin (members);
