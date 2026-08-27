-- 0086 — a circuit breaker for push subscriptions/tokens that never resolve.
--
-- A THROWN (transient) send error never removes the subscription that
-- caused it — only an explicit dead-endpoint response ('gone') does that.
-- If the underlying cause is actually permanent (an unreachable push
-- service, a malformed endpoint), the same subscription is retried on
-- EVERY relay tick, forever: one wasted network call and one
-- platform.operational_events row every five seconds, indefinitely, for
-- every currently-pending delivery to that person. Worse,
-- notification-push.ts's batch read has no stronger ordering guarantee
-- than "the same up-to-100 rows tend to come back" — enough immortal
-- pending rows can starve every OTHER pending delivery for that user out
-- of ever being attempted at all.
--
-- Not hypothetical: a dead web-push subscription's retry storm was caught
-- silently starving a LATER push that should have reached a real device —
-- the subscription kept failing every tick, the pending backlog it left
-- behind never shrank, and a newer delivery for the same recipient never
-- got a turn in the batch.
--
-- consecutive_failures counts transient failures since the last success,
-- reset to 0 whenever ANY of that user's devices on that channel succeeds —
-- the same "every device of a user who got one message on that channel is
-- alive" reasoning notification-push.ts's own last_seen_at update already
-- uses, applied to this column too rather than inventing a second,
-- per-device precision model just for it. Once it crosses the threshold
-- (notification-push.ts's MAX_CONSECUTIVE_TRANSIENT_FAILURES), the
-- subscription is retired exactly like a 'gone' response — deleted, not
-- merely ignored.

ALTER TABLE platform.push_subscriptions
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;

ALTER TABLE platform.expo_push_tokens
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0;
