-- Down for 0070. Returns the sweep role to the four columns 0059 gave it.
-- The period-close scan will then fail with `permission denied for table orgs`
-- again, which is the correct consequence of removing the grant it needs.
REVOKE SELECT (stripe_subscription_id) ON identity.orgs FROM taskflow_billing_sweep;
