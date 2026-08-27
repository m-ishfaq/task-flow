ALTER TABLE platform.operational_events
  DROP CONSTRAINT operational_events_kind_check;

ALTER TABLE platform.operational_events
  ADD CONSTRAINT operational_events_kind_check
    CHECK (kind IN ('mail', 'billing_webhook', 'billing_sweep'));
