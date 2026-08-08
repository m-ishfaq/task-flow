-- Down for 0032 — Phase 7 Wave 1: the telephony safety rails.
--
-- Children before parents, the ordering tenancy-seed.ts's clearTenant already
-- documents for Work: comms.subaccount_orgs and comms.subaccounts both
-- reference identity.orgs, and nothing in this migration references anything
-- else in it, so the five drops are independent.

DROP TABLE IF EXISTS comms.webhook_nonces;
DROP TABLE IF EXISTS comms.spend_ledger;
DROP TABLE IF EXISTS comms.spend_policy;
DROP TABLE IF EXISTS comms.subaccount_orgs;
DROP TABLE IF EXISTS comms.subaccounts;
