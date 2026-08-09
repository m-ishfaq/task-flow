-- Reverses 0038.
--
-- Dropping the column returns the TwiML route to inferring intent from
-- `announcement_required`, which is why the code guarded against a missing
-- value by resolving toward NOT recording rather than toward recording.

ALTER TABLE comms.calls
  DROP COLUMN IF EXISTS record_requested;
