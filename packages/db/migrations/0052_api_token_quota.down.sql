-- 0052 down — drop the per-token quota table. The row dies with its token
-- anyway (ON DELETE CASCADE), so dropping the table only discards live
-- counters, which reset on the next consume.
DROP TABLE platform.api_token_quota;
