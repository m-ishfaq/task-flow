-- Down for 0100 — the AI token budget columns.

ALTER TABLE billing.org_entitlements
  DROP CONSTRAINT IF EXISTS org_entitlements_ai_token_budget_nonnegative;
ALTER TABLE billing.org_entitlements
  DROP COLUMN IF EXISTS ai_token_budget_monthly_cents;

ALTER TABLE billing.plans
  DROP CONSTRAINT IF EXISTS plans_ai_token_budget_nonnegative;
ALTER TABLE billing.plans
  DROP COLUMN IF EXISTS ai_token_budget_monthly_cents;
