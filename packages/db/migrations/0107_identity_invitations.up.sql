-- 0107 — identity: email invitations
--
-- `member.service.ts`'s `addMember` has always required the invited address to
-- already hold a TaskFlow account, and its own doc comment named exactly why:
-- "inviting an address that has never signed up needs an invitations table, a
-- mailed token, and an acceptance flow that decides what happens when the
-- invited address later registers by another route... it deserves its own
-- slice." This migration is that slice.
--
-- Two tables, not one, for the same "resolve the tenant BEFORE you can open a
-- scope" problem `comms.subaccount_orgs` (0032) and `billing.customer_orgs`
-- (0059) already solved once each:
--
--   * `identity.invitations` carries everything about the invitation — the
--     email, the role, who sent it, its status — and is an ordinary
--     tenant-isolated table, read and written only from inside
--     `withOrgScope(orgId)` once the caller (an org admin) already knows
--     which org they are acting in.
--   * `identity.invitation_lookup` exists ONLY so `acceptInvitation` — called
--     by someone who is NOT YET a member of the org, holding nothing but the
--     opaque token from their email — can learn WHICH org that token belongs
--     to before any scope can open. It carries no more than the two columns
--     that answer that one question, on the identical "holds nothing worth
--     protecting" reasoning `scripts/check-migration-rls.mjs` already accepts
--     for its two siblings. Deleted the moment the invitation is accepted or
--     revoked (see `invitation.service.ts`), so a consumed or dead token
--     cannot even resolve an org afterward.
--
-- `role` excludes 'owner' — the same restriction `addMember` already enforces
-- via `isDirectlyAssignable`, kept here as a second, structural line of
-- defense: Owner is reached only by `transferOwnership`, never by invitation.

CREATE TABLE identity.invitations (
  id                uuid        PRIMARY KEY,
  org_id            uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- Normalized (lowercased, trimmed) the same way identity.users.email_normalized
  -- is — comparisons against an invited user's own account always go through
  -- the normalized form on both sides.
  email             text        NOT NULL,
  role              text        NOT NULL CHECK (role IN ('admin', 'member', 'guest')),

  status            text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),

  token_hash        text        NOT NULL,

  invited_by        uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  accepted_user_id  uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  accepted_at       timestamptz,

  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One PENDING invitation per (org, email) — re-inviting an address that
-- already has one rotates that SAME row's token rather than creating a
-- second, so a stale earlier link stops working the moment a newer one is
-- sent. A partial index, not a plain unique one: an org may legitimately
-- invite the same address again after an earlier invitation was accepted,
-- revoked, or expired, and those history rows must not collide.
CREATE UNIQUE INDEX invitations_org_email_pending_key
  ON identity.invitations (org_id, lower(email))
  WHERE status = 'pending';

-- Settings' "Pending invitations" list.
CREATE INDEX invitations_org_idx
  ON identity.invitations (org_id, created_at)
  WHERE status = 'pending';

ALTER TABLE identity.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.invitations FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invitations_tenant_isolation ON identity.invitations;
CREATE POLICY invitations_tenant_isolation ON identity.invitations
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- The pre-tenant lookup — see header. No RLS: see the exemption named in
-- scripts/check-migration-rls.mjs (RLS_EXEMPT), holding the same
-- token_hash -> org_id shape as comms.subaccount_orgs and
-- billing.customer_orgs hold subaccount_sid/stripe_customer_id -> org_id.
-- --------------------------------------------------------------------------

CREATE TABLE identity.invitation_lookup (
  token_hash text PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE
);
