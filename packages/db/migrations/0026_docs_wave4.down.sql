-- Down for 0026 — docs: publish-to-public, page templates.

DROP POLICY IF EXISTS page_versions_public_read ON docs.page_versions;
DROP POLICY IF EXISTS pages_public_read ON docs.pages;

DROP TABLE IF EXISTS docs.templates;

ALTER TABLE docs.pages DROP COLUMN IF EXISTS published_version_id;
ALTER TABLE docs.pages DROP COLUMN IF EXISTS published_at;

ALTER TABLE docs.page_versions DROP CONSTRAINT page_versions_kind_valid;
ALTER TABLE docs.page_versions
  ADD CONSTRAINT page_versions_kind_valid CHECK (kind IN ('autosave', 'manual'));
