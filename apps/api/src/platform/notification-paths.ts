/**
 * Where clicking (or pushing) a notification navigates (Phase 9,
 * ai/phase-9-notifications.md §3.4, §3.7).
 *
 * One shared table for the three consumers that build a link from a
 * `platform.notifications` row — the projection (email), the digest sweep,
 * and the push relay. `apps/web/src/router.tsx` is the routing authority;
 * this is its server-side shadow, kept in one place so three code paths
 * cannot drift. The bell component restates the same mapping client-side for
 * its own navigation (see `notification-bell.tsx`); a change to the router
 * must touch both.
 *
 * Returns `null` for a shape this build cannot link (never happens for a
 * kind the projection itself produces, but the return type keeps callers
 * honest about the case).
 */

export function notificationPath(input: {
  readonly subjectType: string;
  readonly subjectId: string;
  readonly channelId: string | null;
  readonly boardId: string | null;
}): string | null {
  switch (input.subjectType) {
    case 'message':
      return input.channelId === null ? null : `/chat?channel=${input.channelId}`;
    case 'card':
      return input.boardId === null ? null : `/boards/${input.boardId}?card=${input.subjectId}`;
    case 'page':
      return `/docs?page=${input.subjectId}`;
    /* A missed call links to the CONVERSATION, not to the call (Phase 13).
       The call is over — there is nothing to open — and what somebody actually
       wants after seeing "you missed a call" is the place to call back from. */
    case 'call':
      return input.channelId === null ? null : `/chat?channel=${input.channelId}`;
    /* A membership event (added, role changed) links to Settings — there is
       no per-event page, and Settings' member list is where the fact it
       describes is actually visible (migration 0071). */
    case 'membership':
      return '/settings';
    /* An operator broadcast has no per-notification page — there is nothing
       to open beyond "the app". `/home` is the closest existing equivalent
       to `membership`'s `/settings` fallback: a real, always-reachable
       route rather than a null that would silently refuse both push and
       email (see notification-push.ts's `row.path === null` check, and
       notification.projection.ts's own `path !== null` gate before an
       email delivery row is even written). Migration 0083's own header. */
    case 'operator_broadcast':
      return '/home';
    default:
      return null;
  }
}
