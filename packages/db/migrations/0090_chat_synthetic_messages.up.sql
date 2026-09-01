-- Synthetic carriers are auto-created placeholder messages that an upload
-- attaches to. When the upload fails they are deleted, and unlike an
-- intentional user deletion they should NOT appear to ANY participant —
-- not as a tombstone, not on re-load. The flag lets messages.list exclude
-- them from the result set once deleted_at is set.
ALTER TABLE chat.messages
  ADD COLUMN is_synthetic boolean NOT NULL DEFAULT false;
