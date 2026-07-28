-- Reverses 0003.
--
-- Dropped in dependency order rather than with CASCADE, for the reason given in
-- 0002: CASCADE would silently take whatever a later migration attached to
-- these tables, and up -> down -> up in CI exists to find that out before a
-- production rollback does.

DROP TABLE IF EXISTS identity.webauthn_challenges;
DROP TABLE IF EXISTS identity.webauthn_credentials;
