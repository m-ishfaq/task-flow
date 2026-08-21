-- 0082 (down) — see the .up.sql header for context.

DROP POLICY IF EXISTS expo_push_tokens_audit_send ON platform.expo_push_tokens;
REVOKE SELECT, UPDATE, DELETE ON platform.expo_push_tokens FROM taskflow_audit;

DROP POLICY IF EXISTS expo_push_tokens_self_delete ON platform.expo_push_tokens;
DROP POLICY IF EXISTS expo_push_tokens_self_update ON platform.expo_push_tokens;
DROP POLICY IF EXISTS expo_push_tokens_self_insert ON platform.expo_push_tokens;
DROP POLICY IF EXISTS expo_push_tokens_self_read ON platform.expo_push_tokens;

DROP TABLE IF EXISTS platform.expo_push_tokens;
