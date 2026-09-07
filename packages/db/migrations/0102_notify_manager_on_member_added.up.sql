-- 0102 — notify the manager when a new report joins (Phase 15 §8, checklist item 2)
--
-- §8's own deferral note said this needed a real database read —
-- `notification.projection.ts`'s `plan*` functions are deliberately pure, and
-- "who is this new hire's manager" needs one (`people.membership_profiles.
-- manager_user_id`, Phase 11.5) — and that read is resolved by the CALLER
-- (`drainNotifications`), never inside the pure planning function, the exact
-- pattern that file already uses for `actorLabel` (migration 0087).
--
-- Two things this migration does, for the identical reasons 0071/0087 did
-- them for the sibling `member.added`/`member.role_changed` kinds:
--
-- 1. Widen `notifications_kind_valid` for the new kind. `subject_type` stays
--    'membership' unchanged — the manager's notification names the SAME new
--    member's membership the recipient's own "you were added" notification
--    does, so `notificationPath`'s existing 'membership' -> '/settings' case
--    (0071) already covers it with no code change.
--
-- 2. Grant `taskflow_audit` a column-limited, RLS-permissive read of
--    `people.membership_profiles` — the identical 0037 shape used for
--    `identity.orgs.status`. That table carries the ORDINARY tenant policy
--    (0031 §3: "unlike people.profiles"), keyed on `app.org_id`, which
--    `taskflow_audit` never sets (it writes on behalf of the outbox
--    projection, scoping each row by the org NAMED on it, not a session
--    variable) — so a plain GRANT would see zero rows, exactly as 0037's own
--    header explains for the identical shape. `taskflow_audit` already holds
--    USAGE ON SCHEMA people (0088, added after 0087 forgot it and took down
--    the whole notification pipeline for want of a schema grant) — that
--    lesson is why this migration grants BOTH the table privilege and the
--    schema USAGE (redundant here since 0088 already holds it, but making
--    the pairing explicit in the same migration that adds the table grant
--    is cheaper than trusting a reader to know where to look).

ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention',
      'call.missed',
      'webhook.disabled',
      'member.added', 'member.role_changed', 'member.removed',
      'operator_broadcast',
      'member.report_joined'
    ));

GRANT USAGE ON SCHEMA people TO taskflow_audit;

GRANT SELECT (org_id, user_id, manager_user_id) ON people.membership_profiles TO taskflow_audit;

DROP POLICY IF EXISTS membership_profiles_audit_read ON people.membership_profiles;
CREATE POLICY membership_profiles_audit_read ON people.membership_profiles
  FOR SELECT TO taskflow_audit
  USING (true);
