-- 0095 — telephony caps sized against what each plan actually collects, and
-- Pro's stray Analytics grant closed. Found and decided during PR #132's
-- review, before this product has a single real paying customer.
--
-- ==========================================================================
-- THE CAP WAS SIZED AS "SOUNDS GENEROUS FOR THE PRICE", NOT AGAINST RISK
-- ==========================================================================
--
-- billing.plans.telephony_cap_cents is a ceiling on real Twilio spend — paid
-- to the carrier in near-real-time, independent of whether the org ever pays
-- the overage invoice for usage past telephony_included_cents (the prepaid,
-- bundled allowance). A cap sized as a MULTIPLE of the subscription price
-- means the platform's worst-case exposure on a single bad signup — a
-- stolen card, a chargeback, simple non-payment — comfortably exceeds what
-- was collected. That was true of every paid tier: Starter's $50 cap against
-- a $19/mo price, Pro's $250 against $49, and Business genuinely unlimited
-- (NULL) behind the exact same unvetted, self-serve Stripe checkout as the
-- other two, just a higher price tag. None of it had ever been checked
-- against actual dollars at risk — it was inherited from migration 0063's
-- fail-safe seed and packages/seed/src/modules/billing.catalog.ts's initial
-- literal, neither written with this ratio in mind.
--
-- The corrected caps are NOT scaled to price. They are a flat, small,
-- per-tier FRAUD BACKSTOP: Starter $15, Pro $50, Business $100 (Free stays
-- $0 — it is never granted the telephony feature at all). Business drops
-- from unlimited to $100 specifically because "no ceiling on spend" was a
-- marketing promise sitting behind a card-only signup with zero vetting —
-- the plan's own description is corrected in the same statement so the
-- console and the pricing copy cannot say something the data no longer
-- backs. telephony_included_cents and the markup percentages are UNCHANGED:
-- those were already sized as a fraction of what a plan collects, and hold
-- up under the same review.
--
-- Applied as a straightforward, unconditional UPDATE rather than the
-- narrower "only if it still matches the original seed" guard used
-- elsewhere in this codebase for plan-data corrections — there is no
-- production customer base for any of these rows to have diverged from
-- yet, by the project owner's own account, not assumed here.
--
-- ==========================================================================
-- PRO'S STRAY ANALYTICS GRANT
-- ==========================================================================
--
-- Migration 0063 seeded 'pro' with EVERY registry flag, including
-- 'analytics', as a fail-safe for existing Stripe subscribers before any
-- route consulted plan features at all (0063's own header: "reductions are
-- then a deliberate operator action... not a side effect of a schema
-- change"). packages/seed/src/modules/billing.catalog.ts, written once the
-- real tier design existed, correctly withholds 'analytics' from Pro — it
-- is Business's one point of differentiation (CLAUDE.md's Phase 11 entry:
-- "the first real feature difference between pro and business, which
-- previously differed only on limits and price") — but the seed module
-- skips any plan id that already exists, so that correction never reached
-- the live row. This is the one place it finally does.

UPDATE billing.plans
   SET features   = array_remove(features, 'analytics'),
       updated_at = now()
 WHERE id = 'pro';

UPDATE billing.plans
   SET telephony_cap_cents = 1500,
       updated_at          = now()
 WHERE id = 'starter';

UPDATE billing.plans
   SET telephony_cap_cents = 5000,
       updated_at          = now()
 WHERE id = 'pro';

UPDATE billing.plans
   SET telephony_cap_cents = 10000,
       description         = 'Everything, with generous usage limits and priority support.',
       updated_at          = now()
 WHERE id = 'business';
