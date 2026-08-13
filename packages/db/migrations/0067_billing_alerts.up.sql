-- 0067 — remembering which billing alerts have already been sent
-- (Phase 12 Wave 4)
--
-- ==========================================================================
-- WHY A TABLE RATHER THAN A FLAG IN MEMORY
-- ==========================================================================
--
-- The usage alerts fire from a check that runs on every outbound call and
-- SMS. Without a durable record of "already warned", an org sitting at 81% of
-- its cap emails its owner on every single call for the rest of the month.
--
-- An in-process Set would fix that until the next deploy, and then forgive
-- everyone — which is precisely the reasoning `rtc.turn_issuance` already
-- gives for counting TURN credentials in Postgres rather than in memory: a
-- restart is a state an operator reaches by accident and an attacker reaches
-- on purpose.
--
-- ==========================================================================
-- ONE ROW PER (ORG, ALERT, PERIOD), AND THE PERIOD IS THE POINT
-- ==========================================================================
--
-- `period_start` is what makes this self-resetting. The spend cap is a
-- ROLLING 30-day window, so there is no billing period boundary to hang a
-- reset on — instead each alert records the window it was sent for, and a new
-- window naturally has no row. Nothing has to sweep this table for it to stop
-- suppressing next month's warning.
--
-- The primary key is the dedupe. Sending is an INSERT ... ON CONFLICT DO
-- NOTHING, and the row count tells the caller whether it was the first — so
-- two workers racing on the same threshold send exactly one email between
-- them, decided by Postgres rather than by a check-then-act that both pass.

CREATE TABLE billing.alerts_sent (
  org_id       uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- Closed set. A typo here is an alert that silently never dedupes, which
  -- surfaces as the exact email storm this table exists to prevent.
  alert        text        NOT NULL
                 CHECK (alert IN ('usage_80', 'usage_100', 'usage_over', 'trial_ending')),

  -- The window this alert belongs to. For usage alerts, the start of the
  -- rolling window it was computed over; for trial_ending, the trial's own
  -- end date, so moving a trial re-arms the warning.
  period_start timestamptz NOT NULL,

  sent_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, alert, period_start)
);

ALTER TABLE billing.alerts_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.alerts_sent FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alerts_sent_tenant_isolation ON billing.alerts_sent;
CREATE POLICY alerts_sent_tenant_isolation ON billing.alerts_sent
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The app role writes these: the spend check that notices a threshold runs
-- inside an ordinary org scope. DELETE is revoked — 0059's ALTER DEFAULT
-- PRIVILEGES grants all four, and "forget that we warned them" is not
-- something application code should be able to do by accident, because the
-- consequence is the email storm rather than a missing row.
REVOKE DELETE ON billing.alerts_sent FROM taskflow_app;
GRANT SELECT, INSERT ON billing.alerts_sent TO taskflow_app;

COMMENT ON TABLE billing.alerts_sent IS
  'Durable "already warned" markers, keyed by (org, alert, period). Prevents an org past a usage threshold emailing its owner on every subsequent call (migration 0067).';
