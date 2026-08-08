import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';

/**
 * Notification preferences (Phase 9, ai/phase-9-notifications.md §3.3).
 *
 * Global per user, not per org — `api.notifications.prefs.*` is `selfRoute`
 * server-side (`apps/api/src/platform/router.ts`), the same reason
 * `auth.me`/`auth.updateProfile` are. No `orgId` anywhere in this file,
 * deliberately: there is none to scope by.
 *
 * No `wire()` here. `NotificationPrefEntry`'s three fields are two string
 * enums and a boolean — nothing this output carries is a `Date` that
 * `lib/wire.ts` would need to restate.
 */

export type NotificationCategory = 'direct' | 'activity';
export type NotificationChannel = 'email' | 'push' | 'sms';

export type NotificationPrefEntry = Awaited<
  ReturnType<typeof api.notifications.prefs.list.query>
>[number];

export function notificationPrefsQuery() {
  return queryOptions({
    queryKey: ['notifications', 'prefs'] as const,
    queryFn: () => api.notifications.prefs.list.query(),
  });
}

export function setNotificationPref(input: {
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}) {
  return api.notifications.prefs.set.mutate(input);
}
