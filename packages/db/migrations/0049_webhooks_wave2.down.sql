-- 0049 — outbound webhooks (ai/phase-10-automation.md, Wave 2)

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
