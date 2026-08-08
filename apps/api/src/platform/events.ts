import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Platform-level domain events — currently just the one (Phase 9,
 * ai/phase-9-notifications.md §3.5, §4).
 *
 * `notification.created` is a second-order event: it is emitted by
 * `platform/notification.projection.ts`, a CONSUMER of the outbox, about its
 * own write to `platform.notifications` — not by a user-facing service
 * method the way guardrail 11 usually expects. It exists so
 * `apps/realtime`'s existing outbox consumer can drive a personal
 * `user:{userId}` room the same way it already drives board and channel
 * rooms, without the gateway ever polling `platform.notifications` directly
 * or the projection knowing anything about Socket.io.
 *
 * The payload is deliberately minimal — `notificationId` only identifies the
 * row for a caller that wants more than the room needs; the room itself only
 * needs `userId`. `apps/web` reacts by invalidating its notification
 * queries (the INVALIDATE strategy ai/phase-4-realtime.md §5 already
 * establishes), not by rendering this payload directly.
 */
export const notificationCreated = defineEvent(
  'notification.created',
  z.object({ userId: z.string(), notificationId: z.string() }).strict(),
);
