-- 0098 — backfill individual telephony grants, then trim the Member role
-- (ai/phase-15-ai-copilot-and-permissions.md §1, the "contract" step).
--
-- 0097 added `authz.member_grants` as a way to give ONE person a permission
-- without changing their role — but it only ever ADDS capability. Nothing
-- about it removed `call:place`/`call:read`/`sms:send`/`sms:read`/
-- `phoneNumber:read` from the Member role's own default list, so every
-- Member kept full telephony access exactly as before, regardless of
-- whether anyone had ever used the new mechanism. That is the actual gap:
-- individual grants meant nothing while the role itself already handed the
-- same five permissions to everyone.
--
-- This migration is the "migrate" step of expand-migrate-contract: it seeds
-- an explicit grant for every membership that currently gets these five
-- permissions from the Member role, so existing access is PRESERVED. The
-- "contract" half — actually removing them from `MEMBER` in
-- `packages/policy/src/roles.ts` — ships as application code in the same
-- deploy as this migration; migrations run before the new code starts
-- serving traffic, so the compensating grants already exist by the time the
-- trimmed role list does.
--
-- Admin keeps these five on its role list, unchanged — a deliberate,
-- explicit decision (not an oversight the way Member's flat grant was):
-- Admins are a smaller, more trusted group, and Admin already holds
-- `recording:read`, which Member does not, so telephony access has never
-- been role-uniform in this catalog. Only Member's default is being
-- narrowed; Owner and Admin are untouched.
--
-- `gen_random_uuid()`, not the app's UUIDv7 minting — these rows are seeded
-- by SQL, not by a service, and there is no product meaning to their
-- relative creation order (see 0012's identical reasoning). `granted_by` is
-- NULL rather than naming an actor: nobody made this decision, the
-- migration is preserving a decision the role matrix already made for
-- them. For the same reason this does NOT emit `member_grant.created`
-- events into the outbox — the event exists to answer "who changed this
-- person's access, and when", and attributing a backfill to no one, at
-- migration time rather than the moment of a real decision, would misstate
-- both halves of that record. Nothing about a member's ACTUAL access
-- changes as a result of this migration; it only makes explicit what the
-- role matrix already granted implicitly, one deploy before that grant
-- would otherwise disappear.

INSERT INTO authz.member_grants (id, org_id, membership_id, permission, granted_by, granted_at)
SELECT
  gen_random_uuid(),
  m.org_id,
  m.id,
  p.permission,
  NULL,
  now()
FROM identity.memberships m
CROSS JOIN (
  VALUES
    ('phoneNumber:read'),
    ('call:place'),
    ('call:read'),
    ('sms:send'),
    ('sms:read')
) AS p(permission)
WHERE m.role = 'member'
  AND m.status = 'active'
ON CONFLICT (membership_id, permission) WHERE revoked_at IS NULL DO NOTHING;
