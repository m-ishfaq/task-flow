-- Revert 0023 — docs: spaces and pages.
--
-- Dropped children-first. The composite foreign keys make the order
-- mandatory rather than tidy: pages depend on spaces (and on themselves, via
-- parent_page_id).
--
-- Nothing here is a compliance-sensitive loss the way 0021's retention data
-- was — Wave 1 shipped no page BODY content at all (see 0023.up's note 3), so
-- reverting this migration loses tree structure and titles only, never
-- document text.

DROP TABLE IF EXISTS docs.pages;
DROP TABLE IF EXISTS docs.spaces;
