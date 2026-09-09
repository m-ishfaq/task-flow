-- 0103 — authz: role default grants (Phase 15 §8 checklist item 3)
--
-- §8's own deferral note for this item: "there is no 'role -> default
-- member_grants' config table anywhere in this codebase yet — building one
-- is new state, not a new action wrapping existing state, and deserves its
-- own review." This is that table.
--
-- ## A THIRD mechanism, and why it is not the other two
--
-- `authz.relationship_tuples` (0005) grants a relation on one RESOURCE.
-- `authz.member_grants` (0097) grants one PERMISSION to one MEMBERSHIP, with
-- no resource at all. This table grants one PERMISSION to every member who
-- HOLDS one ROLE, going forward — a template `member_grants` rows are
-- stamped from, at membership-creation time, never a live authorization
-- source of its own. `can()` never reads this table directly; only
-- `member_grant.apply_role_defaults` (the new automation action) does, and
-- only to decide which `authz.member_grants` rows to write. Folding this
-- into `member_grants` itself (a NULL membership_id meaning "every future
-- member of this role") would make every reader of that table's own
-- `member_grants_membership_idx` handle a case that isn't really about one
-- membership at all — a config template and a granted capability are
-- different things with different lifecycles, the same reasoning that kept
-- `member_grants` a second mechanism rather than folding INTO
-- `relationship_tuples` in the first place (0097's own header).
--
-- ## Real DELETE, unlike member_grants' revoked_at
--
-- `member_grants` never deletes a row because a REVOKED grant is a fact
-- about history someone might need to explain later ("why did Raj have
-- call:place for three weeks in March"). This table has no such history to
-- preserve — it is standing CONFIGURATION ("what does a new Member get by
-- default"), the identical shape `platform.flag_overrides` already has, not
-- a historical record of what was granted to whom and when. Changing an
-- org's bundle for the `member` role is an edit, not an event.
--
-- ## No CHECK on `permission`, for the identical reason 0097 gives
--
-- Which permissions are ELIGIBLE for a role's default bundle is the SAME
-- `GRANTABLE_PERMISSIONS` list `member-grant.service.ts` already validates
-- against for an individual grant — a narrower, product-decision list that
-- changes independently of the permission catalog, and belongs in
-- application code (the new `role-default-grant.service.ts`) rather than a
-- migration edit every time the eligible set changes.
--
-- `role`, unlike `permission`, DOES get the same CHECK
-- `identity.memberships.role` already has (migration 0004) — the role
-- catalog itself (`packages/policy/src/roles.ts`'s ROLES) is a stable,
-- closed set that does not change the way the grantable-permission list
-- does, so constraining it in the schema costs nothing and catches a typo
-- at write time rather than at read time.

CREATE TABLE authz.role_default_grants (
  id         uuid        PRIMARY KEY,
  org_id     uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  permission text        NOT NULL,

  created_by uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (org, role, permission) — a real UNIQUE constraint, not the
-- partial index member_grants needs for its revoked-but-not-deleted rows,
-- because there is only ever one live row per triple here.
CREATE UNIQUE INDEX role_default_grants_unique
  ON authz.role_default_grants (org_id, role, permission);

-- "What does this role get by default" — the read
-- `member_grant.apply_role_defaults` issues on every execution.
CREATE INDEX role_default_grants_role_idx
  ON authz.role_default_grants (org_id, role);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — the ordinary tenant policy, identical shape to
-- authz.member_grants (0097). taskflow_app needs no separate GRANT: 0001's
-- ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA authz
-- already covers SELECT/INSERT/UPDATE/DELETE on every table this schema
-- gets, this one included.
-- --------------------------------------------------------------------------
ALTER TABLE authz.role_default_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.role_default_grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_default_grants_tenant_isolation ON authz.role_default_grants;
CREATE POLICY role_default_grants_tenant_isolation ON authz.role_default_grants
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
