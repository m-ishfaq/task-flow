-- 0049 — outbound webhooks (ai/phase-10-automation.md, Wave 2)
--
-- A row this migration's own feature wrote (kind = 'webhook.disabled',
-- subject_type = 'webhook' — delivery.ts's own pairing) has no narrower
-- value to demote to once the CHECKs below are restored — see 0083's
-- down.sql for why this needs NO FORCE/FORCE bracketing rather than a plain
-- DELETE: platform.notifications is FORCE ROW LEVEL SECURITY (0022), which
-- applies row security to the table OWNER too, and the only policy
-- admitting taskflow_migrator here is scoped by app.org_id — unset during
-- a migration, so an unbracketed DELETE silently matches zero rows.
ALTER TABLE platform.notifications NO FORCE ROW LEVEL SECURITY;

DELETE FROM platform.notifications WHERE kind = 'webhook.disabled';

ALTER TABLE platform.notifications FORCE ROW LEVEL SECURITY;

-- Restore the 0027 kind list (the webhook-disable kind goes with the tables).
ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_kind_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_kind_valid
    CHECK (kind IN (
      'chat.mention', 'chat.direct', 'chat.thread_reply',
      'card.assigned', 'card.comment_mention', 'card.due_soon',
      'page.comment_mention',
      'call.missed'
    ));

-- Restore the 0042 subject types (the webhook kind goes with the tables).
ALTER TABLE platform.notifications
  DROP CONSTRAINT notifications_subject_type_valid;

ALTER TABLE platform.notifications
  ADD CONSTRAINT notifications_subject_type_valid
    CHECK (subject_type IN ('message', 'card', 'page', 'call'));

DROP TABLE IF EXISTS platform.webhook_deliveries;
DROP TABLE IF EXISTS platform.webhooks;
