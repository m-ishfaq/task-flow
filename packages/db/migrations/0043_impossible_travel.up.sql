-- 0043 — device inventory & impossible-travel detection, the data half
-- (Phase 12 Wave 2 §3.4, ai/phase-12-wave2.md)
--
-- §3.4's device inventory and impossible-travel detection deliberately build
-- on data that already exists — `identity.sessions` is the honest "a device
-- is an active session" unit, and `platform.push_subscriptions` supplies the
-- "can receive push" fact. Two columns on `identity.sessions` are all the new
-- schema this needs:
--
--   1. `country` — the ISO 3166-1 alpha-2 country the session signed in
--      from, recorded on EVERY session whose IP resolves to a country
--      (geolocation is offline and country-level only, per §3.4's decision).
--      Null when the IP is private/reserved/documentation space or the geo
--      lookup has nothing for it. Storing the country on every session — not
--      just flagged ones — is what makes the NEXT login able to compare
--      against this one: the previous session's country is a stored fact,
--      never a lookup performed later against a database that may have
--      changed.
--   2. `impossible_travel_at` — set when THIS sign-in was flagged by the
--      travel check (country differs from the account's most recent active
--      session and the implied speed exceeds the threshold). Null on every
--      normal sign-in. The flag is a stored fact about that login, never
--      recomputed at read time, because the sessions a future reader would
--      compare against keep changing.
--
-- Neither column changes privileges: `identity.sessions` has no RLS by
-- design (the identity module reaches it through withGlobalScope), and an
-- ALTER on an existing table creates no table and needs no grants — unlike
-- 0036's lesson about tables created in a schema with default privileges.

ALTER TABLE identity.sessions
  ADD COLUMN country text,
  ADD COLUMN impossible_travel_at timestamptz;

COMMENT ON COLUMN identity.sessions.country IS
  'ISO 3166-1 alpha-2 country of the sign-in IP, when it resolves to one; null for private/reserved/documentation ranges and unknown addresses (Phase 12 Wave 2 §3.4).';
COMMENT ON COLUMN identity.sessions.impossible_travel_at IS
  'Set when this sign-in was flagged by impossible-travel detection; null on every normal sign-in (Phase 12 Wave 2 §3.4).';
