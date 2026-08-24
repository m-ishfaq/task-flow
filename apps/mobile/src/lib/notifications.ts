import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * The bell — mentions, direct messages, thread replies, card assignments,
 * and missed calls, ORG-WIDE and across every product surface, not just
 * Chat. Ported from `apps/web/src/features/chat/notification-bell.tsx`, a
 * gap the 2026-08-22 chat-parity audit found and named but did not close
 * in that same pass (see `apps/mobile/README.md`'s "Chat, a real audit..."
 * section) — closed here, as its own increment.
 *
 * A separate file from `chat.ts`, deliberately: the router this reads is
 * `notifications`, mounted at the ROOT (`apps/api/src/router.ts`), not
 * under `chat` — `platform/notifications.ts`'s own header is explicit that
 * it moved out of `chat/` in Phase 9 for exactly this reason ("nothing
 * here was ever chat-specific... gating these reads behind a chat
 * permission would refuse a member their own card-assignment notification
 * for holding no chat permission at all"). `chat.ts`'s own header draws
 * the identical "different domain, different router, different file" line
 * against `work.ts`; this is the same call for a third domain.
 *
 * **This claim used to say the bell was reached from the Chat tab only —
 * corrected in place, per this repo's own habit, rather than silently
 * rewritten.** True when written: this app's tab bar is `headerShown:
 * false` with each screen drawing its own header, and there was no single
 * shared chrome to mount an equivalent in without touching all four tab
 * screens, so it was placed on Chat's own header instead. A real device
 * report ("notification is on chat layout, can't get to it") found that
 * gap directly. `apps/mobile/src/lib/notification-bell.tsx` is the fix —
 * mounted once in `(app)/_layout.tsx`, the same absolutely-positioned
 * overlay pattern `call-surface.tsx` already established for the identical
 * reason (a ringing call, like a notification, is not one tab's concern).
 */
export type NotificationSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['notifications']['listMine']['query']>>
>[number];

export const NOTIFICATIONS_QUERY_KEY = ['notifications.listMine'] as const;
export const NOTIFICATION_COUNT_QUERY_KEY = ['notifications.unreadCount'] as const;

/**
 * The category × channel preference matrix — `notifications.prefs.*`, the
 * same `selfRoute` (no org: `identity.notification_prefs` is global per
 * user, the same "yours alone, the same wherever you sign in" shape
 * `notification-prefs-section.tsx`'s own header gives it on web) ported
 * here rather than added to `push-notifications.ts`, because that file is
 * scoped to the device-REGISTRATION ceremony (getting an Expo push token
 * onto this device in the first place) — a different, unrelated concern
 * from "which categories should reach me on which channel", the gap that
 * file's own header named and left open until now.
 */
export type NotificationPrefEntry = Wire<
  Awaited<ReturnType<MobileTRPCClient['notifications']['prefs']['list']['query']>>
>[number];

export const NOTIFICATION_PREFS_QUERY_KEY = ['notifications.prefs.list'] as const;

/** A glyph per kind — ported verbatim from `notification-bell.tsx`'s own `iconFor`. */
export function notificationIcon(kind: string): string {
  if (
    kind === 'chat.mention' ||
    kind === 'card.comment_mention' ||
    kind === 'page.comment_mention'
  ) {
    return '@';
  }
  if (kind === 'chat.direct') return '✉️';
  if (kind === 'chat.thread_reply') return '↩️';
  if (kind === 'card.assigned') return '📌';
  if (kind === 'call.missed') return '📞';
  return '🔔';
}

/**
 * Where tapping a notification navigates — mobile's own routing table,
 * mirroring `notification-bell.tsx`'s `openNotification` switch exactly
 * (same field, same precedence), NOT `notification-path.ts`'s
 * `mobilePathFor`: that function parses the WEB-shaped path STRING a push
 * payload's `data.path` carries (`/chat?channel=X`), which this row never
 * has — `notifications.listMine` returns the raw fields the bell is built
 * from, the same source `notification-paths.ts` computes that string
 * FROM server-side. Two different inputs, so two different functions,
 * rather than serializing a row into a fake web path just to reuse the
 * other one's parser.
 *
 * Returns `null` for the same two web shapes this app has no screen for —
 * `page` (no Docs feature on native) and `membership` (a settings link
 * with no mobile equivalent) — the same "no honest way to guess, so
 * don't" call `notification-path.ts`'s own header already makes.
 */
export function mobileRouteFor(
  notification: Pick<NotificationSummary, 'subjectType' | 'subjectId' | 'boardId' | 'channelId'>,
): string | null {
  if (notification.subjectType === 'card' && notification.boardId !== null) {
    return `/card/${notification.subjectId}`;
  }
  if (notification.subjectType === 'page') return null;
  if (notification.subjectType === 'membership') return null;
  if (notification.channelId !== null) return `/channel/${notification.channelId}`;
  return null;
}
