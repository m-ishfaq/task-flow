-- 0055 down — automation telephony (ai/phase-10-automation.md §5.5)
--
-- Reverse of the up migration: drop the sub-budget column and its CHECK, then
-- narrow the ledger kind constraint back to the original four. Rows written
-- with an automation kind would be refused by the narrowed CHECK on any
-- future write to that table — which is the correct contract step for a
-- feature being withdrawn: existing rows survive, new writes of the removed
-- kinds stop being legal.

ALTER TABLE comms.spend_ledger
  DROP CONSTRAINT spend_ledger_kind_valid;

ALTER TABLE comms.spend_ledger
  ADD CONSTRAINT spend_ledger_kind_valid CHECK (
    kind IN ('call', 'sms', 'number_purchase', 'verification')
  );

ALTER TABLE comms.spend_policy
  DROP CONSTRAINT spend_policy_automation_cap_nonnegative;

ALTER TABLE comms.spend_policy
  DROP COLUMN automation_cap_cents;
