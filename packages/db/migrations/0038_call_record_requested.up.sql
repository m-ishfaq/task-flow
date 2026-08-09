-- 0038 — comms.calls records whether recording was REQUESTED, separately from
-- whether an announcement is required (ai/phase-7-voice.md §3.5).
--
-- ## The bug this closes
--
-- `placeCall` took `record: boolean` and persisted no column for it. The intent
-- was folded into `announcement_required`:
--
--     announcement_required = input.record ? consent.announcementRequired : false
--
-- and the TwiML route — which runs LATER, when the carrier fetches the call's
-- instructions — had to reconstruct the caller's intent from that one boolean.
--
-- That is recoverable in an ALL-PARTY jurisdiction, where `true` can only have
-- come from `record: true`. It is not recoverable in a ONE-PARTY jurisdiction:
-- `consent.announcementRequired` is false there, so a recorded call and an
-- unrecorded one both store `false` and are indistinguishable afterwards.
--
-- GB, CA, IE, NZ, IN and ZA are all one-party in packages/telephony's table, so
-- this was not an exotic corner — recording simply did not work for a large
-- share of destinations, and the route resolved the ambiguity toward NOT
-- recording. That default was the right way to be wrong (recording someone who
-- did not consent is the serious error, and is criminal in several places), but
-- it is a workaround for missing data, not a design.
--
-- ## Why a column rather than a cleverer inference
--
-- There is no inference available. The two cases are byte-identical in the row.
-- The only fix is to write down what the caller asked for, which is also the
-- honest thing for an audit trail to contain: "recording was requested" and "an
-- announcement was required" are two different facts about a call, and a
-- compliance review two years from now needs both, not one standing in for the
-- other.
--
-- ## Safety of the default
--
-- DEFAULT false, NOT NULL. Every pre-existing row becomes "recording was not
-- requested", which is correct for every row where it can be checked
-- (announcement_required = true implies it WAS requested, but those calls are
-- long finished and their TwiML was fetched under the old inference — there is
-- nothing left to decide for them). A default of true would retroactively claim
-- consent decisions nobody made.
--
-- The `calls_recording_after_announcement` CHECK is untouched: it adjudicates
-- recording_started_at against announcement_played_at, and remains the thing
-- the database will not let be wrong. This column feeds the decision; that
-- constraint still polices the outcome.

ALTER TABLE comms.calls
  ADD COLUMN record_requested boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN comms.calls.record_requested IS
  'Whether the caller asked for this call to be recorded. Distinct from announcement_required, which is the consent rule''s answer — in a one-party jurisdiction a recorded call requires no announcement, so the two cannot be collapsed.';
