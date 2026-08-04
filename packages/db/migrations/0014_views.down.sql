-- Revert 0014 — saved views.
--
-- One table, self-contained: nothing references `work.views`, so its indexes,
-- constraints and RLS policy all go with it. The forward migration adds no
-- column to an existing table, which is what makes the reversal this small.
--
-- Note what is lost and is not recoverable by re-running the up file: every
-- saved arrangement, including shared ones a team had settled on. That is
-- inherent to a down migration on a table that holds user data rather than a
-- shortcoming of this one — the same is true of 0011's statuses. It is worth
-- stating because `migrate:verify` runs up -> down -> up routinely against
-- `taskflow_test`, and a reader could reasonably assume the round trip is
-- lossless anywhere it succeeds.

DROP TABLE IF EXISTS work.views;
