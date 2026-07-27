-- TaskFlow — required extensions (PLAN.md §7)
-- Runs once, on first initialization of an empty data volume.

-- Fuzzy text matching for the free-tier SearchProvider (§5).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- digest() / gen_random_bytes() — used by the audit hash chain (§8.6).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Lets GIN indexes cover scalar columns alongside trigram/array columns, which
-- matters for the common "org_id + text search" composite.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- NOTE on UUIDv7 (§7.1): PostgreSQL 17 has no native uuidv7(). IDs are generated
-- application-side in @taskflow/security so the same implementation is used by the
-- API, workers, and tests. Revisit when the deployment target reaches PostgreSQL 18,
-- which ships uuidv7() natively.
