-- 0082 — native mobile push (Phase 14 §9, ai/phase-14-mobile.md), the
-- `ExpoPushProvider` row `push-provider.ts`'s own header named in advance:
-- "the day a mobile app exists, FcmPushProvider/ApnsPushProvider implement
-- the same shape and nothing at the call site changes." Expo's push service
-- is that implementation, chosen because it is the ONE relay that already
-- sits in front of both FCM and APNs for an Expo-built app — this table
-- never needs to know which OS a token belongs to.
--
-- platform.expo_push_tokens is a SEPARATE table from platform.
-- push_subscriptions (0029) rather than a widened version of it, because the
-- two are shaped for different protocols: a web-push subscription is
-- (endpoint, p256dh, auth) plus RFC 8291 encryption; an Expo push token is
-- one opaque string the SERVER holds no key material for at all — Expo's own
-- relay does the encryption to the device on our behalf. Making
-- push_subscriptions polymorphic (nullable VAPID columns OR a nullable
-- token, arbitrated by a CHECK) would touch a table `notification-push.ts`
-- already depends on for a genuinely different shape, for no benefit over a
-- second table with its own identical RLS pattern.
--
-- Every structural choice mirrors 0029's push_subscriptions exactly, for the
-- same reasons that migration gives: self-scoped RLS keyed on app.user_id
-- (a person registering their OWN device is not a privilege escalation, so
-- the write side gets a real WITH CHECK); taskflow_audit gets SELECT/UPDATE/
-- DELETE and no INSERT (registration is always the person's own act through
-- the application role, which already holds default privileges on `platform`
-- tables per 0001); user_id/created_at/last_seen_at land in the identical
-- shape Phase 12's device/session inventory already reads off
-- push_subscriptions, so a native device row slots into that same screen
-- without a second device concept.
CREATE TABLE platform.expo_push_tokens (
  id               uuid        PRIMARY KEY,
  user_id          uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,

  -- Expo's own opaque token format, e.g. "ExponentPushToken[xxxxxxxxxxxx]".
  -- Not a secret in the VAPID-key sense: it identifies a device to Expo's
  -- relay, and by itself grants no one anything without also holding a
  -- session that can address this API — see 0029's identical note on why
  -- envelope-encrypting the equivalent VAPID columns was declined.
  expo_push_token  text        NOT NULL,

  -- Parsed at registration into something a person recognizes, matching
  -- push_subscriptions.user_agent_label's own role for Phase 12's device
  -- list — "iPhone 15" / "Pixel 8", not a raw Expo device id.
  device_label     text,

  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Touched on every successful push, and at registration. Phase 12's
  -- "is this device alive?" question, answered for free by the relay that
  -- is already sending.
  last_seen_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT expo_push_tokens_user_token_key UNIQUE (user_id, expo_push_token)
);

ALTER TABLE platform.expo_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.expo_push_tokens FORCE  ROW LEVEL SECURITY;

CREATE POLICY expo_push_tokens_self_read ON platform.expo_push_tokens
  FOR SELECT
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY expo_push_tokens_self_insert ON platform.expo_push_tokens
  FOR INSERT
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY expo_push_tokens_self_update ON platform.expo_push_tokens
  FOR UPDATE
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY expo_push_tokens_self_delete ON platform.expo_push_tokens
  FOR DELETE
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- The push relay. SELECT to read tokens, UPDATE for last_seen_at, DELETE for
-- a token Expo reports "DeviceNotRegistered" for (the app was uninstalled,
-- or the token rotated) — the identical shape push_subscriptions_audit_send
-- grants for web push. Deliberately no INSERT: registration is a person's
-- own act, through the application role, which already has default
-- privileges on `platform` tables (0001).
GRANT SELECT, UPDATE, DELETE ON platform.expo_push_tokens TO taskflow_audit;

CREATE POLICY expo_push_tokens_audit_send ON platform.expo_push_tokens
  FOR ALL TO taskflow_audit
  USING (true)
  WITH CHECK (true);
