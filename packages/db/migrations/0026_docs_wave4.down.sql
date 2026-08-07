-- Down for 0026 — docs: publish, PDF export, page templates.

DROP TABLE IF EXISTS docs.page_templates;

DROP INDEX IF EXISTS docs.pages_published_idx;
ALTER TABLE docs.pages DROP CONSTRAINT IF EXISTS pages_published_version_fk;
ALTER TABLE docs.pages DROP CONSTRAINT IF EXISTS pages_published_pair;
ALTER TABLE docs.pages DROP COLUMN IF EXISTS published_at;
ALTER TABLE docs.pages DROP COLUMN IF EXISTS published_version_id;

DROP INDEX IF EXISTS docs.page_versions_org_id_page_key;

ALTER TABLE docs.page_versions DROP CONSTRAINT page_versions_kind_valid;
ALTER TABLE docs.page_versions
  ADD CONSTRAINT page_versions_kind_valid CHECK (kind IN ('autosave', 'manual'));
