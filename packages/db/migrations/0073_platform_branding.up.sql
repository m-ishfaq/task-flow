-- 0073 — platform-wide branding (the console's fourth global singleton,
-- after platform.operator_chain_head).
--
-- One row for the whole deployment: product name, an uploaded logo/favicon
-- (storage keys, not bytes — the actual PNGs live in the same S3/MinIO
-- bucket every attachment does, verified through the same
-- apps/api/src/attachments/verify.ts pipeline), and a palette id naming one
-- of a small, pre-audited set of accent-color triples defined in
-- application code (apps/web/src/styles.css's --color-accent /
-- --color-accent-hover / --color-accent-ink are independently hand-tuned
-- OKLCH values with specific contrast ratios, not a formula — so an
-- operator picks a palette BY NAME, never a raw hex, and there is nothing
-- here for a bad color choice to break).
--
-- `updated_by` is nullable, unlike flag_overrides' `set_by` — this row must
-- exist from the moment the migration runs (every reader, including the
-- public unauthenticated route, expects exactly one row, never zero), and
-- there is no user yet to reference on a fresh database. It stays NULL
-- until the first real `branding.set` call fills it in.
--
-- No RLS: global by design, exactly like platform.flag_overrides' migration
-- comment says of itself.
CREATE TABLE platform.branding (
  id            boolean     PRIMARY KEY DEFAULT true CHECK (id),
  product_name  text        NOT NULL DEFAULT 'TaskFlow',
  logo_key      text,
  favicon_key   text,
  palette_id    text        NOT NULL DEFAULT 'default',
  updated_by    uuid        REFERENCES identity.users (id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform.branding (id) VALUES (true);

-- taskflow_app: the read side. The public `branding.public` route runs on
-- this role (it has no operator context to reach withPlatformAdminScope
-- with, and must work with no session at all), and so does every other
-- consumer that only ever reads branding (mail, PDF export).
GRANT SELECT ON platform.branding TO taskflow_app;

-- taskflow_platform_admin: the write side. UPDATE only, never INSERT or
-- DELETE — the singleton row is seeded once, above, and is never recreated
-- or removed; `branding.set` always UPDATEs the one row that already
-- exists.
GRANT SELECT, UPDATE ON platform.branding TO taskflow_platform_admin;
