ALTER TABLE platform.push_subscriptions
  DROP COLUMN consecutive_failures;

ALTER TABLE platform.expo_push_tokens
  DROP COLUMN consecutive_failures;
