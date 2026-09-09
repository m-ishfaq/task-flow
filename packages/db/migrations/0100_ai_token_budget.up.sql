-- 0100 — Phase 15 §3.2: an AI token budget, resolved through the SAME
-- four-tier entitlement chain 0062 built for telephony's cap, rather than a
-- new override mechanism next to it.
-- (ai/phase-15-ai-copilot-and-permissions.md §3.2; PLAN.md §13 row 15)
--
-- The spec's draft imagined a standalone "platform-admin override per org"
-- for this. `apps/api/src/billing/entitlement-resolver.ts` already resolves
-- exactly this shape of value — a nullable ceiling, per plan, with a
-- per-org operator override that wins — for `telephony_cap_cents`,
-- `automation_runs_per_hour` and `turn_issuance_per_day`. Building a second,
-- parallel override table for one more ceiling would give an operator two
-- different places to look for "what limits does this org have" depending
-- on which module they mean, which is the drift `entitlement-resolver.ts`'s
-- own header warns a second implementation invites. This adds a fourth
-- column to the same two tables instead — an expand step, nothing dropped.
--
-- Same nullable-ceiling convention as every column beside it: NULL means
-- UNLIMITED, 0 means none-at-all, and a negative value is neither while
-- comparing false against every usage total — which is why both CHECKs
-- below forbid it, exactly as `plans_telephony_cap_nonnegative` does.

ALTER TABLE billing.plans
  ADD COLUMN ai_token_budget_monthly_cents bigint;

ALTER TABLE billing.plans
  ADD CONSTRAINT plans_ai_token_budget_nonnegative
  CHECK (ai_token_budget_monthly_cents IS NULL OR ai_token_budget_monthly_cents >= 0);

ALTER TABLE billing.org_entitlements
  ADD COLUMN ai_token_budget_monthly_cents bigint;

ALTER TABLE billing.org_entitlements
  ADD CONSTRAINT org_entitlements_ai_token_budget_nonnegative
  CHECK (ai_token_budget_monthly_cents IS NULL OR ai_token_budget_monthly_cents >= 0);
