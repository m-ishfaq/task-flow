-- 0062 — Phase 12 Wave 4, slice 1: the plan catalog
-- (ai/phase-12-wave4-plans.md §3.2, §3.3)
--
-- ==========================================================================
-- THE GRANT TRAP THIS MIGRATION WALKS INTO, AND THE REVOKES THAT CLOSE IT
-- ==========================================================================
--
-- 0059 declared, when it created this schema:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA billing
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;
--
-- So EVERY table this migration creates is fully writable by the application
-- role the instant it exists, before a single GRANT below runs. A migration
-- that carefully granted `taskflow_app` SELECT only would be describing a
-- database it had not produced: the table would be INSERT/UPDATE/DELETE-able
-- anyway, and the migration would read as though it were not.
--
-- This is migration 0036's lesson, verbatim, one schema over. 0035 claimed
-- `platform.operators` was SELECT-only for taskflow_app and granted exactly
-- that; 0001's identical ALTER DEFAULT PRIVILEGES on schema `platform` had
-- already given the app role full CRUD, and it took explicit REVOKEs to close.
-- It was found by a test connecting as the real role, not by reading the
-- migration — which is why §6's suite asserts these REVOKEs the same way.
--
-- A migration that creates a table in a schema with default privileges must
-- say what the table must NOT have, not only what it should.
--
-- ==========================================================================
-- NOBODY MAY DELETE A PLAN OR A PRICE, EVER
-- ==========================================================================
--
-- `identity.orgs.plan_id` references a plan (0063), and every historical
-- `plan_prices` row is what an existing subscriber is still billed against
-- (§3.2's grandfathering). A DELETE would either be refused by the foreign
-- key or would orphan a live subscription. So the catalog is append-and-
-- archive: `is_active = false` retires a plan, `is_current = false` retires a
-- price, and no role holds DELETE on either table — not taskflow_app, not
-- taskflow_platform_admin. The same "the grant is the guarantee" reasoning
-- 0007 uses for the audit log being append-only.
--
-- ==========================================================================
-- billing.plans AND billing.plan_prices ARE GLOBAL — NO org_id, NO RLS
-- ==========================================================================
--
-- A plan belongs to no tenant; it is the thing tenants are ON. Same shape as
-- platform.operators and platform.flag_overrides. Because neither table
-- carries an org_id at all, scripts/check-migration-rls.mjs's org_id-gated
-- checks never look at them — unlike billing.customer_orgs, which DOES carry
-- an org_id and therefore needs an explicit RLS_EXEMPT entry to say it
-- deliberately has none. Nothing to add there for these two.
--
-- billing.org_entitlements is the opposite case: it is per-org, so it gets
-- ordinary tenant-isolation RLS plus the permissive operator policies 0035
-- established for identity.orgs.

-- --------------------------------------------------------------------------
-- billing.plans — the catalog itself
-- --------------------------------------------------------------------------
CREATE TABLE billing.plans (
  -- A stable slug, not a uuid: it is written into identity.orgs.plan_id, read
  -- back in the console and in logs, and quoted in support conversations.
  -- 'pro' survives a database restore into a new environment; a uuid means
  -- every plan reference has to be joined before a human can read it.
  id                        text        PRIMARY KEY,

  name                      text        NOT NULL,
  description               text,
  -- Display order in the plan picker. Not derived from price: a "contact us"
  -- tier and a free tier both need a deliberate position.
  sort_order                integer     NOT NULL DEFAULT 0,
  -- Sellable. An inactive plan keeps working for orgs already on it and
  -- disappears from the picker — retiring a tier must never eject its tenants.
  is_active                 boolean     NOT NULL DEFAULT true,
  -- Where a trial lands when it expires with no subscription (§3.6), and where
  -- a canceled subscription lands. Exactly one row may carry it; see the
  -- partial unique index below.
  is_default                boolean     NOT NULL DEFAULT false,

  -- NULL for a plan with no paid price — the free tier has no Stripe Product
  -- and no plan_prices rows, and checkout is never reached for it.
  stripe_product_id         text,

  -- FlagName[], validated against FLAG_NAMES in the service rather than by a
  -- CHECK, because the database cannot know the registry. The precedent is
  -- packages/seed/src/modules/platform.admin.ts, which validates its own
  -- override list the same way and for the same stated reason: a flag renamed
  -- below the check's notice is a row the evaluator silently ignores.
  features                  text[]      NOT NULL DEFAULT '{}',

  -- The three ceilings. NULL means UNLIMITED; 0 means none-at-all. Both are
  -- real, different states, and 0032's own comment on spend_policy.cap_cents
  -- is why 0 rather than a negative number says "no spend": a negative cap
  -- refuses everything while looking like a configured value.
  telephony_cap_cents       bigint,
  automation_runs_per_hour  integer,
  turn_issuance_per_day     integer,

  -- Usage billing (§3.8). `included` is what the subscription already covers;
  -- past it, overage accrues at cost x (1 + markup/100). Both are plan-level
  -- pricing policy, never a gate — the cap above remains the only hard stop,
  -- refused by checkOutboundAllowed exactly as it is today.
  telephony_included_cents  bigint      NOT NULL DEFAULT 0,
  telephony_markup_pct      integer     NOT NULL DEFAULT 0,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  CONSTRAINT plans_id_is_a_slug
    CHECK (id ~ '^[a-z][a-z0-9_-]{1,30}$'),
  CONSTRAINT plans_name_present
    CHECK (length(btrim(name)) > 0),
  -- A ceiling of NULL is unlimited and a ceiling of 0 is nothing; a NEGATIVE
  -- ceiling is neither, and would compare false against every usage value.
  CONSTRAINT plans_telephony_cap_nonnegative
    CHECK (telephony_cap_cents IS NULL OR telephony_cap_cents >= 0),
  CONSTRAINT plans_automation_runs_nonnegative
    CHECK (automation_runs_per_hour IS NULL OR automation_runs_per_hour >= 0),
  CONSTRAINT plans_turn_issuance_nonnegative
    CHECK (turn_issuance_per_day IS NULL OR turn_issuance_per_day >= 0),
  CONSTRAINT plans_included_nonnegative
    CHECK (telephony_included_cents >= 0),
  -- 0 is passthrough at cost. The upper bound is a typo guard, not a policy:
  -- 1000% is 11x cost, and anything past it is far more likely a misplaced
  -- decimal in a console field than a deliberate margin.
  CONSTRAINT plans_markup_sane
    CHECK (telephony_markup_pct BETWEEN 0 AND 1000),
  -- An included allowance on a plan that cannot be billed for it is a number
  -- with no consumer: the free tier has no subscription to attach an overage
  -- invoice item to.
  CONSTRAINT plans_included_needs_a_product
    CHECK (telephony_included_cents = 0 OR stripe_product_id IS NOT NULL)
);

-- Exactly one default plan, enforced by the database rather than by a service
-- that remembers to clear the previous one. A unique index on a constant
-- expression, restricted to the rows that carry the flag, is the standard
-- shape for "at most one row may be true" — and at-most-one is what matters:
-- zero is caught at boot by BILLING_DEFAULT_PLAN_ID failing to resolve, where
-- TWO would silently make "which plan does an expiring trial land on" depend
-- on row order.
CREATE UNIQUE INDEX plans_one_default_key ON billing.plans ((true)) WHERE is_default;

CREATE UNIQUE INDEX plans_stripe_product_id_key
  ON billing.plans (stripe_product_id)
  WHERE stripe_product_id IS NOT NULL;

-- The plan picker's read: active plans, in display order.
CREATE INDEX plans_active_sort_idx ON billing.plans (sort_order) WHERE is_active;

COMMENT ON COLUMN billing.plans.features IS
  'FlagName[] from packages/feature-flags. Resolved into FlagContext.orgOverrides — the per-org tier that has existed since Phase 0 and had no consumer until this wave (ai/phase-12-wave4-plans.md §3.4). Gates PRODUCT SURFACE only; can() is never consulted through it.';
COMMENT ON COLUMN billing.plans.telephony_cap_cents IS
  'The CEILING an org''s comms.spend_policy.cap_cents may not exceed — not the value itself. NULL = unlimited, 0 = no spend. Replaces TELEPHONY_MAX_SPEND_CAP_CENTS as the bound a compromised Owner credential cannot move (§3.1).';
COMMENT ON COLUMN billing.plans.is_default IS
  'Where an expiring trial and a canceled subscription land (§3.6). At most one row, by partial unique index.';

-- --------------------------------------------------------------------------
-- billing.plan_prices — many per plan, exactly one current per interval
-- --------------------------------------------------------------------------
--
-- The partial unique index below IS the grandfathering mechanism (§3.2).
-- Repricing Pro from $29 to $39 archives the $29 row and inserts a $39 row;
-- existing subscriptions keep billing against the archived Stripe Price,
-- which Stripe honours indefinitely, and only new checkouts resolve
-- `is_current`. Nothing about an existing customer's charge changes because
-- somebody edited a number in a console.
CREATE TABLE billing.plan_prices (
  -- Database-generated, like platform.operational_events (0061) and for the
  -- same stated reason: this table sees a handful of rows per plan per year,
  -- not millions, so UUIDv7's index-locality argument does not apply and a
  -- DEFAULT means the writer needs no application dependency for it.
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  plan_id          text        NOT NULL REFERENCES billing.plans (id) ON DELETE RESTRICT,
  interval         text        NOT NULL CHECK (interval IN ('month', 'year')),
  amount_cents     bigint      NOT NULL CHECK (amount_cents >= 0),
  currency         text        NOT NULL DEFAULT 'usd',

  -- NULL only in the window between our INSERT and the provider call
  -- returning. §3.9 writes Stripe FIRST and this row second precisely so that
  -- window does not exist in practice: an orphaned Stripe Price is inert,
  -- where a catalog row with no price id is an Upgrade button that 500s.
  stripe_price_id  text,

  is_current       boolean     NOT NULL DEFAULT true,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plan_prices_currency_is_iso4217
    CHECK (currency ~ '^[a-z]{3}$'),
  -- The half-state this forbids: a row that is both archived and current.
  -- Retiring a price is two column writes, and a service that does one of
  -- them leaves the catalog with a retired price still being sold.
  CONSTRAINT plan_prices_archived_is_not_current
    CHECK (archived_at IS NULL OR is_current = false)
);

CREATE UNIQUE INDEX plan_prices_current_key
  ON billing.plan_prices (plan_id, interval)
  WHERE is_current;

CREATE UNIQUE INDEX plan_prices_stripe_price_id_key
  ON billing.plan_prices (stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

CREATE INDEX plan_prices_plan_id_idx ON billing.plan_prices (plan_id);

COMMENT ON TABLE billing.plan_prices IS
  'Append-and-archive. Many rows per (plan, interval); exactly one current, enforced by plan_prices_current_key. An archived row is what a grandfathered subscriber is still billed against (ai/phase-12-wave4-plans.md §3.2).';

-- --------------------------------------------------------------------------
-- billing.org_entitlements — the operator override, tier 1 of four (§3.1)
-- --------------------------------------------------------------------------
--
-- Outranks the plan, which is what makes it useful and what makes it
-- dangerous: "every Pro org has Docs" becomes "unless somebody decided
-- otherwise". Three things pay for that, and two of them are in this table --
-- `reason` cannot be empty, and `expires_at` exists so a temporary grant does
-- not become permanent by being forgotten. The third is the console rendering
-- the SOURCE of every resolved value.
--
-- DELTAS, not a replacement set. A full `features` override would freeze the
-- org at the feature list it had the day the override was written: add
-- Analytics to Business six months later and the one org with an override
-- silently does not get it, with nothing reporting that it did not.
CREATE TABLE billing.org_entitlements (
  org_id                    uuid        PRIMARY KEY REFERENCES identity.orgs (id) ON DELETE CASCADE,

  features_add              text[]      NOT NULL DEFAULT '{}',
  features_remove           text[]      NOT NULL DEFAULT '{}',

  -- NULL means "no override, inherit the plan" for each independently — which
  -- is why these are nullable where the plan's own columns are not. An
  -- override that had to restate every ceiling would drift from the plan the
  -- moment the plan changed.
  telephony_cap_cents       bigint,
  telephony_included_cents  bigint,
  telephony_markup_pct      integer,
  automation_runs_per_hour  integer,
  turn_issuance_per_day     integer,

  reason                    text        NOT NULL,
  expires_at                timestamptz,

  set_by                    uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
  set_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT org_entitlements_reason_present
    CHECK (length(btrim(reason)) > 0),
  -- A feature in both arrays has no defined answer, and picking one silently
  -- would make the resolver's precedence depend on which branch was written
  -- first. `&&` is array overlap.
  CONSTRAINT org_entitlements_no_contradiction
    CHECK (NOT (features_add && features_remove)),
  CONSTRAINT org_entitlements_telephony_cap_nonnegative
    CHECK (telephony_cap_cents IS NULL OR telephony_cap_cents >= 0),
  CONSTRAINT org_entitlements_included_nonnegative
    CHECK (telephony_included_cents IS NULL OR telephony_included_cents >= 0),
  CONSTRAINT org_entitlements_markup_sane
    CHECK (telephony_markup_pct IS NULL OR telephony_markup_pct BETWEEN 0 AND 1000),
  CONSTRAINT org_entitlements_automation_runs_nonnegative
    CHECK (automation_runs_per_hour IS NULL OR automation_runs_per_hour >= 0),
  CONSTRAINT org_entitlements_turn_issuance_nonnegative
    CHECK (turn_issuance_per_day IS NULL OR turn_issuance_per_day >= 0)
);

-- The expiry sweep's scan, and small enough to stay a partial index: most
-- overrides are permanent, so indexing the NULLs would be indexing the table.
CREATE INDEX org_entitlements_expires_at_idx
  ON billing.org_entitlements (expires_at)
  WHERE expires_at IS NOT NULL;

-- Tenant isolation, generated form, repeated verbatim from packages/db/src/rls.ts
-- exactly as every other tenant table. An org reads its OWN override (the
-- billing page shows "Docs: on — operator override"); the permissive policies
-- below are what let the operator role see and write every org's.
ALTER TABLE billing.org_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.org_entitlements FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_entitlements_tenant_isolation ON billing.org_entitlements;
CREATE POLICY org_entitlements_tenant_isolation ON billing.org_entitlements
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- --------------------------------------------------------------------------
-- Grants — and the REVOKEs the schema's default privileges make mandatory
-- --------------------------------------------------------------------------

-- See this file's header. Without these three lines the application role can
-- rewrite the price catalog, and the GRANTs below would be documentation
-- rather than enforcement.
REVOKE INSERT, UPDATE, DELETE ON billing.plans            FROM taskflow_app;
REVOKE INSERT, UPDATE, DELETE ON billing.plan_prices      FROM taskflow_app;
REVOKE INSERT, UPDATE, DELETE ON billing.org_entitlements FROM taskflow_app;

-- What taskflow_app keeps: SELECT, and nothing else. The owner-facing plan
-- picker and the billing page both read the catalog; RLS confines the
-- entitlement read to the caller's own org.
GRANT SELECT ON billing.plans            TO taskflow_app;
GRANT SELECT ON billing.plan_prices      TO taskflow_app;
GRANT SELECT ON billing.org_entitlements TO taskflow_app;

-- The operator role. USAGE is granted here because 0059 gave it to
-- taskflow_app only — USAGE resolves names and grants no access to any object
-- (0007's comment, restated by 0036), so this is the prerequisite rather than
-- the permission.
GRANT USAGE ON SCHEMA billing TO taskflow_platform_admin;

GRANT SELECT, INSERT, UPDATE ON billing.plans       TO taskflow_platform_admin;
GRANT SELECT, INSERT, UPDATE ON billing.plan_prices TO taskflow_platform_admin;
-- DELETE here, and only here: removing an override is restoring the plan's own
-- answer, which loses nothing. Removing a PLAN or a PRICE would orphan a live
-- subscription, which is why no role holds DELETE on either.
GRANT SELECT, INSERT, UPDATE, DELETE ON billing.org_entitlements TO taskflow_platform_admin;

-- Permissive policies OR together with the tenant-isolation one above — the
-- same property 0004 documents for orgs_self_read and 0035 relies on for the
-- org directory. The operator sees and writes every org's override;
-- taskflow_app's view is unchanged by their existence.
DROP POLICY IF EXISTS org_entitlements_platform_admin_read ON billing.org_entitlements;
CREATE POLICY org_entitlements_platform_admin_read ON billing.org_entitlements
  FOR SELECT TO taskflow_platform_admin
  USING (true);

DROP POLICY IF EXISTS org_entitlements_platform_admin_write ON billing.org_entitlements;
CREATE POLICY org_entitlements_platform_admin_write ON billing.org_entitlements
  FOR INSERT TO taskflow_platform_admin
  WITH CHECK (true);

DROP POLICY IF EXISTS org_entitlements_platform_admin_update ON billing.org_entitlements;
CREATE POLICY org_entitlements_platform_admin_update ON billing.org_entitlements
  FOR UPDATE TO taskflow_platform_admin
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS org_entitlements_platform_admin_delete ON billing.org_entitlements;
CREATE POLICY org_entitlements_platform_admin_delete ON billing.org_entitlements
  FOR DELETE TO taskflow_platform_admin
  USING (true);
