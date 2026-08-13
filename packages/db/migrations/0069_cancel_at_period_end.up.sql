-- 0069 — "this subscription is set to stop"
-- (Phase 12 Wave 4; the gap clicking the button made obvious)
--
-- ==========================================================================
-- WHAT WAS BROKEN
-- ==========================================================================
--
-- `cancelPlan` called the processor and wrote NOTHING to this database. Its
-- comment gave a correct reason for not writing `billing_status` — the
-- subscription is live until the period ends, and flipping the status early
-- locks out someone who has paid through the end of the month — and then
-- stopped there, as though "do not write the status" meant "do not write
-- anything".
--
-- So the fact never landed anywhere we could read. `getOverview` kept
-- computing `renews`, the settings page kept saying "Renews 13 Sep" and kept
-- offering the Cancel button that had already been pressed, and the Resume
-- button appeared only once `billing_status` became `canceled` — which is
-- AFTER the period ends, by which time resuming is a different action.
-- Clicking Cancel returned 200 with a date in it and changed nothing anybody
-- could see.
--
-- ==========================================================================
-- WHY ITS OWN COLUMN, AND NOT A BILLING_STATUS VALUE
-- ==========================================================================
--
-- "Cancels at period end" and "is cancelled" are different facts about
-- different moments, and the whole failure above came from having a column
-- for only the second. An org here is ACTIVE: it has every feature it pays
-- for, its invoices are current, and it may change its mind. Encoding that as
-- a status value would put a live paying customer in a state every
-- authorization path reads as ended.
--
-- Same reasoning Wave 3 used for keeping `billing_status` separate from Wave
-- 1's operator-controlled `status`, and Wave 4 for `pending_plan_id`: a
-- SCHEDULED change is its own fact, sitting beside the current one rather
-- than overwriting it early.
--
-- ==========================================================================
-- A MIRROR, LIKE current_period_end
-- ==========================================================================
--
-- The processor owns this. We record what it last told us, and
-- `reconcileSubscription` re-reads it — so a cancellation performed in the
-- processor's own customer portal (which this app links to) shows up here on
-- the next reconcile rather than never. Information only: nothing gates on
-- it, and nothing should start to. Access is decided by `billing_status` and
-- the entitlement resolver, exactly as before.

ALTER TABLE identity.orgs
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN identity.orgs.cancel_at_period_end IS
  'The subscription is set to stop at current_period_end rather than renew. Mirrored from the processor; information only, never an authorization input. The org is still fully active until the date arrives (migration 0069).';
