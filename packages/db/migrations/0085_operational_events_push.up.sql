-- 0085 — the operations dashboard learns about push (migration 0061).
--
-- `platform.operational_events` answers "did a system action succeed or
-- fail" for mail, a billing webhook, and the billing sweep — and, until
-- now, nothing else. Push notifications went through `notification-push.ts`
-- with NO equivalent: a send outcome was folded into an in-memory counter
-- logged at `debug` (invisible unless LOG_LEVEL=debug) and otherwise
-- vanished the moment the tick finished. An operator asking "did that
-- broadcast's push actually reach anyone" had no answer short of grepping
-- container logs — the exact gap 0061's own header says this table exists
-- to close, just never wired up for this one channel.
--
-- Widens the closed CHECK rather than loosening it to free text, matching
-- 0061's own "a typo here is a row nothing can ever query back out" —
-- the same discipline as 0046's `documents_entity_type_check` for the
-- identical reason.

ALTER TABLE platform.operational_events
  DROP CONSTRAINT operational_events_kind_check;

ALTER TABLE platform.operational_events
  ADD CONSTRAINT operational_events_kind_check
    CHECK (kind IN ('mail', 'billing_webhook', 'billing_sweep', 'push'));
