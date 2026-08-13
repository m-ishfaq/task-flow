-- 0061 — the operations dashboard's own table and role.
--
-- A DIFFERENT question from platform.operator_audit_log (0035): that table
-- answers "what did an OPERATOR do" (a hash-chained, compliance-grade
-- record of human actions taken through the platform console). This table
-- answers "did a SYSTEM action succeed or fail" — a mail send, a Stripe
-- webhook, a sweep tick — for an operator who currently has NO way to tell
-- the two apart without SSHing into the box and grepping container logs.
-- No hash chain here on purpose: nothing here is a human decision to be
-- held accountable for, so the chain-under-a-lock machinery 0007/0035 both
-- need would be protecting nothing.
--
-- GLOBAL, not per-org — the same shape as platform.operators/
-- platform.operator_audit_log, and for a stronger reason than either:
-- mail delivery (a password reset, a verification link before an org
-- exists) frequently has NO org at all. `identity.orgs` FORCE RLS's own
-- withOrgScope would return zero rows for exactly the events this table
-- exists to capture first.
--
-- No org_id column at all, so scripts/check-migration-rls.mjs's org_id-gated
-- checks never even look at this table — there is nothing here for RLS to
-- filter, unlike billing.customer_orgs/comms.subaccount_orgs, which DO carry
-- an org_id and need an explicit RLS_EXEMPT entry to say so.
--
-- ONE role, taskflow_ops_events, holding BOTH INSERT and SELECT — not the
-- claim-role split taskflow_billing_sweep uses. That split exists when a
-- narrow role SCANS across tenants and a separate, ordinary connection does
-- the write; here there is no tenant to scan across and no write this role
-- could do that would violate isolation, because there is no isolation
-- boundary on this table to violate. Writers are apps/api (mail delivery,
-- billing webhooks) and apps/worker (the sweep's heartbeat); the reader is
-- apps/api/src/platform-admin's own route. All three connect as the same
-- role, over their own connection pool, the same way multiple processes
-- already share taskflow_webhook/taskflow_automation.

-- id is DATABASE-generated (gen_random_uuid(), built into Postgres core
-- since 13 — no extension needed), unlike this codebase's domain tables
-- (cards, users, ...), which mint UUIDv7 application-side for index
-- locality at real volume (packages/security/src/uuid.ts's own header).
-- This table sees dozens of rows a day, not millions, so that argument does
-- not apply, and a DEFAULT here means the writer role needs no application
-- dependency it would not otherwise have.
CREATE TABLE platform.operational_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Closed set, not a free-form string — a typo here is a row nothing can
  -- ever query back out. Extend the CHECK when a new source is wired in
  -- rather than widening it to text.
  kind        text        NOT NULL
                CHECK (kind IN ('mail', 'billing_webhook', 'billing_sweep')),
  outcome     text        NOT NULL CHECK (outcome IN ('success', 'failure')),
  -- A redacted identifier: an email address, a Stripe event id. Never a
  -- token, a link, or anything that authenticates something — the same
  -- discipline the existing mail-queue onFailure callback already applies
  -- to its own log line (packages/mail/src/queue.ts's own comment).
  target      text,
  -- Structured, redacted context specific to `kind` — e.g. { attempts } for
  -- mail, { stripeEventType } for a webhook, { trialsExpired,
  -- gracesCanceled } for a sweep tick. Same redaction discipline as `target`.
  detail      jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- Both reads this table exists to answer: "show me the last N events" (the
-- console's default view) and "show me the last N of just this kind" (the
-- kind filter). No org_id to index on — there is none.
CREATE INDEX operational_events_occurred_at_idx
  ON platform.operational_events (occurred_at DESC);
CREATE INDEX operational_events_kind_occurred_at_idx
  ON platform.operational_events (kind, occurred_at DESC);

-- The ROLE itself is created in docker/postgres/init/02-roles.sql, never
-- here — taskflow_migrator is NOCREATEROLE by design (0033's own header has
-- the same lesson, learned the same way).

GRANT USAGE ON SCHEMA platform TO taskflow_ops_events;
GRANT SELECT, INSERT ON platform.operational_events TO taskflow_ops_events;

-- taskflow_platform_admin already holds unrestricted SELECT/INSERT/UPDATE on
-- most of the platform schema (0035), but NOT on a table this migration is
-- the one creating — granted explicitly rather than assumed, matching
-- 0035's own per-table grants to that role.
GRANT SELECT ON platform.operational_events TO taskflow_platform_admin;
