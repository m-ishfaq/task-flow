-- Down for 0025 — docs: comments, suggestions, backlinks, taskflow_backlinks.

DROP POLICY IF EXISTS backlink_dispatch_backlinks_all ON docs.backlink_dispatch;
REVOKE SELECT, INSERT ON docs.backlink_dispatch FROM taskflow_backlinks;

DROP POLICY IF EXISTS page_versions_backlinks_claim ON docs.page_versions;
REVOKE SELECT (id, org_id, page_id, created_at) ON docs.page_versions FROM taskflow_backlinks;

REVOKE USAGE ON SCHEMA docs FROM taskflow_backlinks;

DROP TABLE IF EXISTS docs.backlink_dispatch;
DROP TABLE IF EXISTS docs.backlinks;
DROP TABLE IF EXISTS docs.suggestions;
DROP TABLE IF EXISTS docs.comments;
