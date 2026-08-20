-- Reverses 0080. Dropping the channel column removes the native-vs-browser
-- refresh binding: every surviving session becomes exchangeable on either
-- route again. The separate response schemas (SessionResponse vs
-- NativeSessionResponse) still stand, so the browser body still never carries a
-- refresh token — only the cross-channel defence-in-depth is undone.
ALTER TABLE identity.sessions
  DROP CONSTRAINT IF EXISTS sessions_channel_valid;

ALTER TABLE identity.sessions
  DROP COLUMN IF EXISTS channel;
