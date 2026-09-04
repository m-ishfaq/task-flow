-- 0094 — the trial plan (ai/phase-12-wave4-plans.md's own deferred "what is a
-- trial entitled to" question, landing alongside the flags.ts registry-default
-- inversion it depends on).
--
-- Every module flag flips from defaultValue: true to defaultValue: false in
-- the same change (packages/feature-flags/src/flags.ts) — the registry
-- default stops meaning "on for everyone" and starts meaning "nothing
-- granted", the shape `analytics` already used. That is what makes a plan's
-- feature list a REAL restriction for the first time instead of a decorative
-- label. But an org with plan_id = NULL resolves through that same registry
-- default — so the moment it flips, a trialing org (plan_id = NULL since
-- migration 0063's own deliberate choice) would lose every module instead of
-- previewing the product.
--
-- This is the plan that fills that gap: a non-purchasable, full-access tier
-- every new org is placed on immediately, so the trial keeps working the way
-- ai/phase-12-wave4-plans.md §3.6 already described it ("trial entitlements...
-- lands on Free with no Docs") instead of resolving to nothing, and Free —
-- once its own feature list is filled in via the console — becomes a real,
-- felt downgrade for the first time.
--
-- `is_active = false`: this must never appear in the OWNER-facing upgrade
-- picker (which filters on is_active) and must never be assignable to an
-- EXISTING org by an operator via plans.setOrgPlan (which already refuses an
-- inactive plan for exactly this "not sold" reason) — a paying customer
-- choosing "Trial" from a dropdown, or an operator moving an established org
-- onto it, are both wrong. `createOrg` writes plan_id = 'trial' directly in
-- its own INSERT, which does not go through that gate — the one, deliberate
-- door onto this plan.
--
-- The id is a hardcoded literal in org.service.ts (TRIAL_PLAN_ID), not a
-- second is_trial marker column alongside is_default. is_default is a column
-- because an operator retiring or replacing the landing plan is a real,
-- recurring business decision (§3.6). Which plan IS the trial is structural —
-- it is the plan this migration creates and org.service.ts's own transaction
-- assigns — not something meant to move to a different existing plan without
-- a corresponding code change regardless of a flipped flag.
--
-- Limits are deliberately small, not absent: full FEATURE access is safe to
-- hand out for free (it costs database rows), but telephony spend is real
-- carrier cost from the first call, so the trial gets just enough budget to
-- prove the feature works, never enough to be worth abusing. Enforced by the
-- same spend gate every other plan's cap goes through, unchanged.
INSERT INTO billing.plans (
  id, name, description, sort_order, is_active, is_default,
  stripe_product_id, features,
  telephony_cap_cents, automation_runs_per_hour, turn_issuance_per_day,
  telephony_included_cents, telephony_markup_pct
) VALUES (
  'trial',
  'Trial',
  '14-day full-access preview, not sold directly — every new organization starts here.',
  -1,
  false,
  false,
  NULL,
  ARRAY['chat', 'docs', 'telephony', 'tqlTextSyntax', 'automation', 'publicApi'],
  150,   -- $1.50 — enough to prove a call or SMS works, not enough to abuse
  15,    -- automation runs/hour — enough to see a rule fire, not run a pipeline
  30,    -- TURN credential issuances/day
  0,
  0
)
ON CONFLICT (id) DO NOTHING;

-- Existing orgs already mid-trial (plan_id NULL, billing_status 'trialing')
-- move onto it now — the whole reason this migration cannot just add a row
-- and stop. Without this, every currently-trialing org goes from "sees
-- everything" to "sees nothing" the instant this deploys, because their
-- plan_id stays NULL and the registry default they fall through to just
-- flipped from true to false in the same release. Scoped tightly to
-- trialing + NULL: a canceled org transiently sitting at NULL is the sweep's
-- own state to resolve, not this migration's to guess at.
UPDATE identity.orgs
   SET plan_id = 'trial'
 WHERE plan_id IS NULL
   AND billing_status = 'trialing';
