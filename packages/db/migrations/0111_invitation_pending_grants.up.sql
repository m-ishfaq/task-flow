-- 0111 — identity: pending grants attached to an invitation
--
-- Closes a real workflow gap in Work's guest-access flow (`guest-access
-- .service.ts`), found from a direct report: inviting an external
-- collaborator into a single project required TWO separate admin steps —
-- add them as a Guest-role member of the ORG first (via the generic Members
-- section, itself requiring an existing account or a separate mailed
-- invitation), THEN return to the project's own Guest access section to
-- grant project access. Someone with no TaskFlow account yet had no path
-- through this at all from the project side.
--
-- This table lets `createInvitation` (`tenancy/invitation.service.ts`)
-- attach ONE pending relationship grant to an invitation at the moment it is
-- sent, and `acceptInvitation` apply it the instant the invitee accepts —
-- collapsing "invite as Guest, then separately grant project access" into
-- one admin action, with the grant taking effect automatically on
-- acceptance rather than needing a second visit from the admin.
--
-- Deliberately generic (`object_type`/`object_id`/`relation`), the same
-- shape `authz.relationship_tuples` itself already uses, rather than a
-- `project_id` column naming Work specifically — grants are already a
-- cross-module primitive (`tenancy/grant.service.ts`'s `grant()` is called
-- from Work, Chat and Docs alike), so this table stays inside identity's own
-- schema and needs no FK into a resource table it does not own. Work's own
-- `guest-access.service.ts` is simply the first caller to populate it with
-- `object_type = 'project'`.
--
-- One row per invitation, not a list: this door only ever attaches a single
-- project grant per invite today, and a second use case can widen this to a
-- real one-to-many table if it ever needs to.

CREATE TABLE identity.invitation_pending_grants (
  invitation_id uuid        PRIMARY KEY REFERENCES identity.invitations (id) ON DELETE CASCADE,
  org_id        uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  object_type   text        NOT NULL,
  object_id     uuid        NOT NULL,
  relation      text        NOT NULL,

  -- Mirrors `authz.relationship_tuples.is_guest` — a review/audit marker
  -- only, carried through to the real tuple `grant()` writes on acceptance.
  is_guest      boolean     NOT NULL DEFAULT false,

  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE identity.invitation_pending_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.invitation_pending_grants FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invitation_pending_grants_tenant_isolation
  ON identity.invitation_pending_grants;
CREATE POLICY invitation_pending_grants_tenant_isolation
  ON identity.invitation_pending_grants
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
