-- 0095 — adds an operator-configurable sales/contact email to the
-- platform-wide branding singleton (migration 0073).
--
-- Closes a real hardcoding gap: BillingSection's "Enterprise — contact us"
-- tile had no configured address to send someone to except a literal string
-- in the component. This is the same table every other "one deployment,
-- one brand" fact already lives on (product name, logo, accent palette),
-- so it gets the same treatment rather than a bespoke settings row: NULL
-- until an operator sets it (mirrors logo_key/favicon_key, both nullable
-- for the identical reason — nothing to show until someone uploads one),
-- read through the same `taskflow_app` SELECT grant and the same
-- `branding.public` route the login page already calls.
ALTER TABLE platform.branding
  ADD COLUMN sales_email text;
