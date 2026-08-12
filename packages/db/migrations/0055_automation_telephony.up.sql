-- 0055 — Phase 10 Wave 4: automation telephony (ai/phase-10-automation.md §5.5)
--
-- The cost-bearing automation actions (`call.place`, `sms.send`) run through
-- the SAME outbound gate a human's call runs through — same geo table, same
-- org freeze, same subaccount check, same rolling cap, same velocity limiter
-- — because that chokepoint is what makes an unattended caller subject to
-- every control an attended one is. What §5.5 adds on top is exactly two
-- things, and both are here:
--
--   1. LEDGER ATTRIBUTION. `comms.spend_ledger.kind` gains 'automation_call'
--      and 'automation_sms', so unattended spend is a kind the org cap sums
--      and `spendReport` groups, never a new table. The sub-budget below is a
--      SUM over exactly these two kinds. The provider is never asked to price
--      them — a call costs what a call costs, and services pass the base kind
--      to `estimateCostCents` — but the CHECK is the authority on what kinds
--      may exist, so it widens rather than being replaced.
--
--   2. THE SUB-BUDGET. `comms.spend_policy.automation_cap_cents`, the org's
--      separate ceiling for automation-initiated spend, checked IN ADDITION
--      to (never instead of) `cap_cents`. NULL means "no separate ceiling" —
--      the org cap alone bounds automation, which is the pre-feature
--      behaviour.
--
-- Why a second column rather than folding automation into the one cap: a
-- single shared cap means a runaway rule can consume the allowance a human
-- needs for a real customer call, and the human finds out by being refused.
-- A broken rule burns its OWN allowance and stops; the phone still works for
-- people. This is the same "attended and unattended spend are different
-- risks" argument that separates the automation execution budget
-- (`platform.automation_budget`, 0047) from the org's hourly rule budget.

ALTER TABLE comms.spend_policy
  ADD COLUMN automation_cap_cents bigint;

-- A negative sub-budget would refuse everything, which sounds safe and is a
-- silent outage — the identical trap `spend_policy_cap_nonnegative` guards
-- `cap_cents` against. Zero is the honest way to say "automation may not
-- spend at all".
ALTER TABLE comms.spend_policy
  ADD CONSTRAINT spend_policy_automation_cap_nonnegative
  CHECK (automation_cap_cents IS NULL OR automation_cap_cents >= 0);

ALTER TABLE comms.spend_ledger
  DROP CONSTRAINT spend_ledger_kind_valid;

ALTER TABLE comms.spend_ledger
  ADD CONSTRAINT spend_ledger_kind_valid CHECK (
    kind IN ('call', 'sms', 'number_purchase', 'verification',
             'automation_call', 'automation_sms')
  );
