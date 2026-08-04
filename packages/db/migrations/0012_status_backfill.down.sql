-- Revert 0012 — status backfill.
--
-- Undoes exactly what 0012's up migration did: clears the mapping this
-- migration wrote, then removes the statuses it seeded. Cards go back to
-- having no status, exactly as they were immediately after 0011.

UPDATE work.cards SET status_id = NULL WHERE status_id IS NOT NULL;

DELETE FROM work.statuses;
