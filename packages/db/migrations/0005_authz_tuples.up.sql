-- 0005 — authz: relationship tuples (PLAN.md §7.2, §8.2)
--
-- The Zanzibar-lite half of the authorization model. Flat roles cannot express
-- "this guest is in #incidents", "this contractor may edit one page subtree",
-- or "the platform team owns that project". Those are relations between a
-- subject and an object, and forcing them into roles produces either a role
-- explosion or a pile of inline special cases — which is the thing guardrail 7
-- exists to prevent.
--
-- The policy engine in packages/policy already consumes these. What it consumes
-- are tuples ALREADY RESOLVED to a single user: a team-subject tuple is
-- expanded through identity.team_members by the loader, so the engine stays
-- pure — no I/O, no async, identical behaviour in the API, a worker, the socket
-- gateway, and the UI.

CREATE TABLE authz.relationship_tuples (
  id           uuid        PRIMARY KEY,
  org_id       uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- A tuple's subject is a user or a team. Storing the type alongside the id,
  -- rather than two nullable columns, is what makes the unique index below
  -- express "one grant per subject per object" without a partial index per
  -- case. The application never dereferences subject_id by guessing the table.
  subject_type text        NOT NULL,
  subject_id   uuid        NOT NULL,

  -- Mirrors RELATIONS in packages/policy. Asserted equal by a test in this
  -- package: a relation the engine has never heard of grants nothing, which is
  -- safe but silent, and the silence is what makes drift worth a test.
  relation     text        NOT NULL,

  -- Mirrors RESOURCE_TYPES in packages/policy, for the same reason. The object
  -- id is opaque here: this table intentionally has NO foreign key to boards,
  -- pages, or channels, because those tables arrive in later phases and a
  -- tuple's meaning does not depend on the row still existing. Cleanup on
  -- delete is the owning service's job, and a dangling tuple grants access to
  -- nothing, since the resource lookup fails first.
  object_type  text        NOT NULL,
  object_id    uuid        NOT NULL,

  granted_by   uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  -- Time-boxed access — a contractor's grant that lapses on its own. NULL means
  -- no expiry. Enforced by the loader's WHERE clause, not by a sweep, so an
  -- expired grant stops working at the moment it expires rather than whenever
  -- the next cleanup job happens to run.
  expires_at   timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tuples_subject_type_valid CHECK (subject_type IN ('user', 'team')),
  CONSTRAINT tuples_relation_valid
    CHECK (relation IN ('owner', 'editor', 'commenter', 'viewer', 'member')),
  CONSTRAINT tuples_object_type_valid
    CHECK (object_type IN (
      'org', 'member', 'team', 'project', 'board', 'card', 'channel', 'message',
      'space', 'page', 'comment', 'attachment', 'automation', 'webhook',
      'integration', 'phoneNumber', 'call', 'sms', 'recording', 'audit', 'apiToken'
    ))
);

-- One row per (subject, relation, object). Re-granting an existing relation is
-- then an idempotent upsert rather than a duplicate, which matters because the
-- engine treats "every tuple at the nearest distance is restrictive" as a
-- capping decision — a duplicate viewer row must not change that arithmetic.
CREATE UNIQUE INDEX tuples_unique_grant
  ON authz.relationship_tuples (org_id, subject_type, subject_id, relation, object_type, object_id);

-- The loader's query, run once per request: every tuple for this user and their
-- teams. Ordered by subject so the two halves of the union hit the same index.
CREATE INDEX tuples_subject_idx
  ON authz.relationship_tuples (org_id, subject_type, subject_id);

-- The reverse question — "who has access to this board?" — for the permission
-- debug page (§10.7) and for cleanup when a resource is deleted.
CREATE INDEX tuples_object_idx
  ON authz.relationship_tuples (org_id, object_type, object_id);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
-- --------------------------------------------------------------------------
ALTER TABLE authz.relationship_tuples ENABLE ROW LEVEL SECURITY;
ALTER TABLE authz.relationship_tuples FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS relationship_tuples_tenant_isolation ON authz.relationship_tuples;
CREATE POLICY relationship_tuples_tenant_isolation ON authz.relationship_tuples
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- No self-read policy here, unlike identity.memberships. Tuples are only ever
-- read inside an org scope — by the time the loader runs, membership has
-- already resolved which org the caller is acting in. Adding one "for symmetry"
-- would widen every user-scoped transaction for no caller that needs it.
