-- 0021 — per-channel retention, legal hold, and guest access
-- (PLAN.md §3.2, §16; ai/phase-5-chat.md §3.7, §3.8)
--
-- ==========================================================================
-- LEGAL HOLD IS A COLUMN ON THE MESSAGE, NOT A SEPARATE TABLE
-- ==========================================================================
--
-- §3.7 requires that the hold check happen INSIDE the same statement as the
-- delete, not as a separate read before it:
--
--     DELETE ... WHERE created_at < :cutoff AND NOT legal_hold
--
-- A message placed on hold between a "which messages are eligible" query and
-- the DELETE that follows is the race this design has to close by
-- construction. A `legal_holds` join table would still allow that DELETE to be
-- written correctly — but it would also allow it to be written as two steps,
-- and the two-step version looks right, passes review, and loses held messages
-- only when a hold is placed during the few milliseconds a sweep is running.
-- A column makes the correct query the SHORTEST one to write.
--
-- Per-message rather than per-channel, and both rather than either: `held_at`
-- on the message covers "preserve this conversation", and
-- `retention_hold` on the channel covers "preserve everything here" without
-- needing a row per message. §7.5 left the granularity open; this answers it
-- as both, because a hold placed on a channel must also cover messages posted
-- AFTER the hold, which a per-message flag alone cannot express.
--
-- ==========================================================================
-- A NULL RETENTION WINDOW MEANS KEEP FOREVER
-- ==========================================================================
--
-- Not "use a default". A default that lived in code would silently start
-- deleting messages the day someone changed the constant, across every channel
-- that had never opted in — which is the single most destructive thing this
-- table could be made to do. Deletion requires an explicit, per-channel number.

ALTER TABLE chat.channels
  ADD COLUMN retention_days integer,
  -- Blanket hold: every message in this channel is exempt, including ones
  -- written after the hold was placed.
  ADD COLUMN retention_hold boolean NOT NULL DEFAULT false;

-- A window of zero would mean "delete everything immediately", which is never
-- what anyone means and is what a mis-parsed empty form field produces.
ALTER TABLE chat.channels ADD CONSTRAINT channels_retention_days_positive
  CHECK (retention_days IS NULL OR (retention_days >= 1 AND retention_days <= 3650));

ALTER TABLE chat.messages
  -- Null means not held. A timestamp rather than a boolean: "since when" is the
  -- first question asked about a hold, and a boolean cannot answer it.
  ADD COLUMN held_at timestamptz,
  ADD COLUMN held_by uuid REFERENCES identity.users (id) ON DELETE SET NULL;

-- The sweep's own query: the oldest un-held messages in one channel. Partial on
-- `held_at IS NULL` so held messages are not merely filtered out but absent
-- from the index the sweep scans.
CREATE INDEX messages_retention_idx
  ON chat.messages (org_id, channel_id, created_at)
  WHERE held_at IS NULL AND deleted_at IS NULL;

-- Every message currently under hold, for the compliance surface that has to
-- list them. Small by design — a hold is exceptional.
CREATE INDEX messages_held_idx
  ON chat.messages (org_id, held_at)
  WHERE held_at IS NOT NULL;

-- --------------------------------------------------------------------------
-- Guest access (§3.8)
--
-- A guest holds a relation tuple on specific channels and NO org role that
-- grants anything (`GUEST` is an empty permission list in packages/policy).
-- That already works: `authz.relationship_tuples` needs no change, because a
-- guest's membership is the same (user, 'member', channel:{id}) row an ordinary
-- member's is.
--
-- What DOES need recording is that a membership is a guest's, and when it
-- lapses. `expires_at` already exists on the tuple and is enforced in
-- `loadTuples`' WHERE clause rather than by a sweep — so a guest's access stops
-- working at the moment it lapses, not whenever a cleanup next runs.
--
-- So this migration adds nothing for guests except a way to SEE them, which the
-- compliance export and the channel roster both need. Stated explicitly because
-- "guest access needs a new table" is the obvious assumption and it is wrong:
-- the whole point of §3.8's tuple design is that it does not.
-- --------------------------------------------------------------------------

-- Which tuples were granted as guest access, as opposed to ordinary membership.
-- Nullable and defaulted false: every existing tuple is a member's.
ALTER TABLE authz.relationship_tuples
  ADD COLUMN is_guest boolean NOT NULL DEFAULT false;

-- "Who are the guests in this org, and what can they reach" — the access review
-- query. Partial, because guests are a small fraction of all tuples.
CREATE INDEX tuples_guest_idx
  ON authz.relationship_tuples (org_id, subject_id, object_type, object_id)
  WHERE is_guest;
