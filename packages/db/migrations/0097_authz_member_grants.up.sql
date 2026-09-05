-- 0097 — authz: member grants (ai/phase-15-ai-copilot-and-permissions.md §1)
--
-- The tuple system in 0005 lets one person be granted a relation on one
-- RESOURCE ("Raj is a commenter on this board"). It has no shape for "give
-- Raj the org-wide ability to place calls" — an ORG-LEVEL permission has no
-- resource for a tuple to point at, and packages/policy's own
-- `ORG_LEVEL_PERMISSIONS` deliberately refuses to let a tuple satisfy one
-- (see permissions.ts's block comment on why that exclusion exists).
--
-- Member grants are a second, parallel mechanism for exactly that shape:
-- one row naming one membership and one permission, with no object at all.
-- Not folded into relationship_tuples, on purpose — teaching
-- `nearestApplicable()` a resource-less code path would blur the one
-- invariant that makes it safe to reason about: a tuple always names an
-- object.
--
-- A grant only ever ADDS capability on top of a role; it is never a way to
-- take one away. Removing a capability a role would otherwise grant (e.g.
-- "this specific Member should NOT have call:place") is a different,
-- harder problem — narrowing — and is deliberately not this migration.
--
-- `revoked_at` rather than DELETE, mirroring identity.sessions and
-- comms.suppressions: a revoked grant stays visible in history instead of
-- disappearing from the row nobody can then explain seeing.

CREATE TABLE authz.member_grants (
  id            uuid        PRIMARY KEY,
  org_id        uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  membership_id uuid        NOT NULL REFERENCES identity.memberships (id) ON DELETE CASCADE,

  -- One of PERMISSIONS in packages/policy. Deliberately no CHECK enumerating
  -- the full catalog here (unlike relationship_tuples' object_type CHECK) —
  -- which permissions are ELIGIBLE for a member grant is a narrower,
  -- product-decision list that changes independently of the permission
  -- catalog itself, and belongs in application code
  -- (apps/api/src/tenancy/member-grant.service.ts) where it can be a
  -- reviewed, named array rather than a migration edit every time the
  -- eligible set changes. A permission this build has never heard of grants
  -- nothing (packages/policy's isPermission guard), which is safe.
  permission    text        NOT NULL,

  granted_by    uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),

  -- NULL means active. Set, never deleted, once revoked — see header.
  revoked_at    timestamptz
);

-- One ACTIVE grant per (membership, permission). A partial index rather than
-- a plain unique index: re-granting a permission that was previously revoked
-- must be possible (a second row, not an update to the first), so the two
-- history rows for the same membership/permission pair are expected and the
-- uniqueness constraint must only ever see one of them as "live" at a time.
CREATE UNIQUE INDEX member_grants_active_unique
  ON authz.member_grants (membership_id, permission)
  WHERE revoked_at IS NULL;

-- The read on every request that resolves a subject (resolve.ts's
-- loadMemberGrants, alongside loadTuples) — active grants for one membership.
CREATE INDEX member_grants_membership_idx
  ON authz.member_grants (org_id, membership_id)
  WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
-- --------------------------------------------------------------------------
ALTER TABLE authz.member_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.member_grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_grants_tenant_isolation ON authz.member_grants;
CREATE POLICY member_grants_tenant_isolation ON authz.member_grants
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- No self-read policy, same reasoning as relationship_tuples (0005): a
-- member grant is only ever read inside an org scope, once membership has
-- already resolved which org the caller is acting in.
