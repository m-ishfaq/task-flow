-- Revert 0013 — comment replies.

DROP INDEX IF EXISTS work.card_comments_parent_idx;
ALTER TABLE work.card_comments DROP CONSTRAINT IF EXISTS card_comments_parent_fk;
DROP INDEX IF EXISTS work.card_comments_org_card_id_key;
ALTER TABLE work.card_comments DROP COLUMN IF EXISTS parent_comment_id;
