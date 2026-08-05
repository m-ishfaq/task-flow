-- Revert 0017 — chat channels, membership and messages.
--
-- Dropped child-first. `messages` references `channels` and itself, so dropping
-- `channels` first would fail on the dependent constraint rather than cascade —
-- and `DROP TABLE ... CASCADE` would work but would also drop anything a LATER
-- migration attached to these tables without saying so in the output.
--
-- Channel MEMBERSHIP is not dropped here, because it is not in this schema:
-- it lives in `authz.relationship_tuples` as (user, 'member', channel:{id}),
-- for the reasons the up migration sets out at length. Reverting this migration
-- therefore leaves tuples naming channels that no longer exist. That is
-- harmless by the design `authz.ts` already documents — there is deliberately no
-- foreign key on `object_id`, and a dangling tuple grants access to nothing
-- because loading the resource fails before the engine is ever consulted.
--
-- What is lost and is not recoverable by re-running the up file: every message
-- anyone has written. That is inherent to a down migration on user data — the
-- same caveat 0014 records for saved views — and it is worth stating here
-- because `migrate:verify` runs up -> down -> up against `taskflow_test` on a
-- routine basis, which can leave the impression the round trip is lossless.

DROP TABLE IF EXISTS chat.messages;
DROP TABLE IF EXISTS chat.channels;
