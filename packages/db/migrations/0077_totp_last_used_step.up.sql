-- 0077 — one TOTP code, one use.
--
-- `verifyTotpCode` accepts the current 30-second step and one either side, so
-- a code stays valid for up to 90 seconds. Nothing recorded which step a user
-- had already spent, so within that window the same six digits could be
-- submitted repeatedly — a code captured from a shoulder-surf, a phishing
-- relay, or a request body that reached a log was replayable.
--
-- `packages/security/src/totp.ts` described this as "a code is single-use in
-- practice". It was not single-use in any sense: the property was never
-- implemented, only assumed from the shortness of the window.
--
-- RFC 6238 §5.2 is explicit that the verifier MUST NOT accept a second OTP for
-- the same time-step, and names exactly this column as the implementation:
--
--   > The verifier ... MUST NOT accept the second attempt of the OTP after the
--   > successful validation has been issued for the first OTP.
--
-- Nullable, and unset for every existing credential. A NULL means "no step has
-- been spent yet", which is the correct reading for a credential enrolled
-- before this column existed — the alternative (defaulting to 0) says the same
-- thing more obscurely, and defaulting to "now" would refuse a legitimate
-- login for the first 30 seconds after the migration ran.
--
-- No RLS: `identity.totp_credentials` is a non-tenant table, exactly as 0040
-- created it.
ALTER TABLE identity.totp_credentials
  ADD COLUMN last_used_step bigint;

COMMENT ON COLUMN identity.totp_credentials.last_used_step IS
  'The last TOTP time-step spent by a successful login. A code at or below this step is refused as a replay (RFC 6238 section 5.2).';
