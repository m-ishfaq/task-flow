-- 0063 — Phase 12 Wave 4, slice 1: give identity.orgs.plan_id a real referent
-- (ai/phase-12-wave4-plans.md §3.2)
--
-- 0059 added `plan_id text` with no foreign key and no catalog to point at,
-- because there was no catalog. The only writer is webhook-apply.service.ts,
-- which sets the bare literal 'pro' when a subscription activates; every other
-- row is NULL. So the live value set across every database is exactly
-- {NULL, 'pro'}, and this migration has to make 'pro' resolve to something
-- before it can constrain the column.
--
-- ==========================================================================
-- THE SEEDED PLANS PRESERVE THE STATUS QUO — THEY DO NOT DESIGN THE PRICING
-- ==========================================================================
--
-- Two rows, and only two, because two is what referential integrity requires:
-- 'pro' because rows already reference it, and 'free' because
-- BILLING_DEFAULT_PLAN_ID has to resolve at boot. A third tier is the
-- operator's to create in the console, which is the whole point of the wave --
-- seeding a full price list here would be this migration deciding the product's
-- pricing, permanently, in a file that may never be edited again.
--
-- 'pro' is seeded with EVERY flag in the registry. That is deliberate and it is
-- the fail-safe direction: nothing reads plan features until slice 2, and when
-- slice 2 lands, an org that is paying today must not silently lose a module
-- because this migration guessed a smaller feature set. Reductions are then a
-- deliberate operator action with an audit entry, not a side effect of a
-- schema change. If the registry gains a flag later, `pro` does not gain it
-- automatically — which is correct: a new module is a pricing decision.
--
-- Neither row carries a stripe_product_id, because a migration cannot call
-- Stripe. Existing 'pro' orgs are unaffected — they hold a live Stripe
-- subscription already, made against the old BILLING_STRIPE_PRICE_ID_PRO --
-- and the console will show Pro as having no configured price until an
-- operator adds one, which is an accurate statement about a database carried
-- over from the env-var world rather than a defect.
--
-- ==========================================================================
-- plan_id STAYS NULLABLE
-- ==========================================================================
--
-- A trialing org genuinely has no plan yet, and inventing one here would be
-- answering slice 3's question ("what is a trial entitled to?") in slice 1,
-- from a migration, with no way to revisit it. NULL keeps meaning "not on a
-- plan"; the resolver's answer for that case arrives with the trial flow.

INSERT INTO billing.plans (id, name, description, sort_order, is_active, is_default, features)
VALUES
  (
    'free',
    'Free',
    'Core Work, for teams evaluating TaskFlow or past their trial.',
    0,
    true,
    true,
    '{}'
  ),
  (
    'pro',
    'Pro',
    'Everything currently shipped. Seeded from migration 0063 to preserve existing subscribers'' access; tune the feature set in the platform console.',
    10,
    true,
    false,
    -- Mirrors packages/feature-flags/src/flags.ts as of this migration.
    -- telephonyLiveCredentials is excluded on purpose: it is release plumbing
    -- that starts real carrier spend and is declared perOrg: false, so it is
    -- not a thing a plan may grant (ai/phase-7-voice.md §8.5).
    ARRAY['chat', 'docs', 'telephony', 'tqlTextSyntax', 'automation', 'publicApi', 'analytics']
  )
ON CONFLICT (id) DO NOTHING;

-- Every live value is now either NULL or a row in billing.plans, so the
-- constraint can go on without a backfill UPDATE. Stated as an assertion
-- rather than assumed: if some environment carries a plan_id this migration
-- did not anticipate, the ALTER below fails loudly here rather than the
-- application discovering a dangling reference later.
ALTER TABLE identity.orgs
  ADD CONSTRAINT orgs_plan_id_fk
    FOREIGN KEY (plan_id) REFERENCES billing.plans (id)
    ON DELETE RESTRICT;

-- The console's "how many orgs are on this plan" count, and the plan-archival
-- guard that has to answer the same question before retiring a tier.
CREATE INDEX orgs_plan_id_idx ON identity.orgs (plan_id) WHERE plan_id IS NOT NULL;

COMMENT ON COLUMN identity.orgs.plan_id IS
  'References billing.plans (0063). NULL means not on a plan — the state a trialing org is in until the trial flow lands (ai/phase-12-wave4-plans.md §3.6). ON DELETE RESTRICT because no role holds DELETE on billing.plans anyway; the constraint states the invariant a second time, where a reader of this table will see it.';
