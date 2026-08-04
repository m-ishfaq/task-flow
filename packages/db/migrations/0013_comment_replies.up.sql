-- 0013 — comment replies (one level of nesting)
--
-- `parent_comment_id` is nullable: null means a top-level comment, a real id
-- means a reply to one. The composite FK targets (org_id, card_id, id) rather
-- than a bare id reference — the same "composite FK across the container
-- boundary" pattern as `cards_status_fk` in 0011 — so a reply can never be
-- planted under a comment from a different CARD even if both ids are known.
-- RLS already stops it crossing a tenant; this is the layer under that.
--
-- Nesting beyond one level (a reply to a reply) is a SERVICE rule, not a
-- database one. A CHECK constraint cannot express "my parent's parent must be
-- null" without a trigger, and a trigger for one product rule that only the
-- UI enforces today is more machinery than the invariant is worth —
-- comment.service.ts's createComment refuses a parent that itself has a
-- parent, and that is where this decision is expected to live if it ever
-- needs to change.
--
-- `ON DELETE CASCADE`, matching `card_comments_card_fk` below it: nothing in
-- this codebase ever issues a real DELETE against card_comments (deletion is
-- always the `deleted_at` tombstone), so this is a defensive default rather
-- than a path anything currently exercises.

ALTER TABLE work.card_comments ADD COLUMN parent_comment_id uuid;

-- Required by the composite FK: Postgres needs a unique index on exactly the
-- columns a composite FK references, same as `statuses_org_project_id_key`.
CREATE UNIQUE INDEX card_comments_org_card_id_key
  ON work.card_comments (org_id, card_id, id);

ALTER TABLE work.card_comments ADD CONSTRAINT card_comments_parent_fk
  FOREIGN KEY (org_id, card_id, parent_comment_id)
    REFERENCES work.card_comments (org_id, card_id, id) ON DELETE CASCADE;

-- The reply thread render: every reply to one parent, oldest first — the
-- same shape as `card_comments_card_idx` one level down.
CREATE INDEX card_comments_parent_idx
  ON work.card_comments (org_id, parent_comment_id, id)
  WHERE parent_comment_id IS NOT NULL;
