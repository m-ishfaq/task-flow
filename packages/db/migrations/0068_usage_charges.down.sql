-- Down for 0068. Dropping the table takes its policies, indexes and grants
-- with it; the schema and the roles predate this migration and stay.
DROP TABLE IF EXISTS billing.usage_charges;

-- The schema-level USAGE the up granted taskflow_billing_sweep. Revoked here
-- because this migration is what introduced it — the role reached nothing in
-- `billing` before 0068, and leaving a schema open on the way down would make
-- down-then-up a different database than a clean up.
REVOKE USAGE ON SCHEMA billing FROM taskflow_billing_sweep;
