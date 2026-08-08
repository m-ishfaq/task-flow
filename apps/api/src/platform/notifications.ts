import { and, desc, eq, isNull, schema, withOrgScope, withUserScope } from '@taskflow/db';
import type { UserId } from '@taskflow/contracts';
import { orgOf, userOf, type ChatActor } from '../chat/shared.js';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  resolvePref,
  type ExplicitPref,
  type NotificationCategory,
  type NotificationChannel,
} from './notification-prefs.js';

/**
 * Reading and clearing your own notifications.
 *
 * ## Moved out of `chat/`, Phase 9
 *
 * Nothing here was ever chat-specific — every query already scoped on
 * `userId`, not on anything about a channel. It lived in `chat/` because
 * chat was the only producer. Phase 9 adds Work and Docs as producers of the
 * same rows (`platform/notification.projection.ts`), so gating these reads
 * behind a chat permission (as `chat/router.ts` used to) would refuse a
 * member their OWN card-assignment notification for holding no chat
 * permission at all — this module and its router moved to `platform/` so
 * that mistake has nowhere to hide. `ChatActor` is still the parameter type,
 * reused from `chat/shared.js` rather than duplicated: it is exactly
 * "verified org + user", nothing chat-specific about the shape itself.
 *
 * ## Why this is a repository and not a service
 *
 * It was `notification.service.ts` briefly, and guardrail 11 refused it —
 * correctly. `markAllRead` mutates and emits no domain event, which is exactly
 * the shape that rule fires on.
 *
 * The missing event is not the fix. Guardrail 11 exists so that audit,
 * notifications, search and automation all learn about state changes — and this
 * IS the notification system. An event here would be a notification about
 * having read a notification, consumed by the thing that produced it.
 *
 * So the mutation lives in a repository module instead, beside `membership.ts`
 * and Work's `counters.ts`, which is what guardrail 11's scope means by
 * "repositories mutate by design". Same call §3.6 makes for read cursors, for
 * the same reason: a per-glance mutation whose audit entry would mean nothing
 * to whoever reads the compliance record.
 *
 * Renaming a file to dodge a lint rule is the bad version of this move, so the
 * test is whether the rule's REASON applies. Here it does not — there is no
 * consumer downstream that needs to be told, because this is the consumer.
 *
 * ## Every read is scoped to the caller, twice
 *
 * RLS scopes to the ORG. "Only mine" is the `userId` predicate below, and it is
 * not optional: `platform.notifications` holds every person's rows, so a query
 * that forgot it would hand one member the whole organization's mentions —
 * including from private channels and DMs they are not in. The excerpt stored
 * on the row is exactly the disclosure that would leak.
 */

export interface NotificationSummary {
  readonly notificationId: string;
  readonly kind: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly channelId: string | null;
  /** Set for `card.*` kinds — see `platform.notifications.boardId`'s own comment. */
  readonly boardId: string | null;
  readonly title: string;
  readonly excerpt: string | null;
  readonly actorId: string | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

/** How many notifications one page holds. The bell is not an archive. */
const PAGE_SIZE = 50;

export async function listMine(actor: ChatActor): Promise<readonly NotificationSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) =>
    tx
      .select({
        notificationId: schema.notifications.id,
        kind: schema.notifications.kind,
        subjectType: schema.notifications.subjectType,
        subjectId: schema.notifications.subjectId,
        channelId: schema.notifications.channelId,
        boardId: schema.notifications.boardId,
        title: schema.notifications.title,
        excerpt: schema.notifications.excerpt,
        actorId: schema.notifications.actorId,
        readAt: schema.notifications.readAt,
        createdAt: schema.notifications.createdAt,
      })
      .from(schema.notifications)
      /* The `userId` predicate is the "only mine" half — RLS gives the org and
         nothing finer. Dropping it hands one member every mention in the
         organization, excerpts included. */
      .where(eq(schema.notifications.userId, userOf(actor)))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(PAGE_SIZE),
  );
}

/**
 * The badge count.
 *
 * Its own query rather than `listMine().filter(...)`: the badge renders on
 * every page load and the list does not, and counting fifty rows to display a
 * number would read the excerpts to throw them away.
 */
export async function unreadCount(actor: ChatActor): Promise<{ readonly unread: number }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(eq(schema.notifications.userId, userOf(actor)), isNull(schema.notifications.readAt)),
      );

    return { unread: rows.length };
  });
}

/**
 * Marks one of the caller's own notifications read — the "open it" path, when
 * clicking a single row should not also silence every other unread one.
 *
 * `id = notificationId AND userId = caller` together, not id alone: RLS scopes
 * to the ORG, and `platform.notifications` holds every member's rows, so id
 * alone would let one person mark somebody ELSE's notification read by
 * guessing or reusing an id.
 */
export async function markRead(
  actor: ChatActor,
  input: { readonly notificationId: string },
): Promise<{ readonly marked: number }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const marked = await tx
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.id, input.notificationId),
          eq(schema.notifications.userId, userOf(actor)),
          isNull(schema.notifications.readAt),
        ),
      )
      .returning({ id: schema.notifications.id });

    return { marked: marked.length };
  });
}

/** Marks every unread notification of the caller's as read. */
export async function markAllRead(actor: ChatActor): Promise<{ readonly marked: number }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const marked = await tx
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(schema.notifications.userId, userOf(actor)),
          /* Only the unread ones. Without this, re-reading the bell rewrites
             `read_at` on rows that were already read, which loses "when did
             they first see this" — the one thing the column is for. */
          isNull(schema.notifications.readAt),
        ),
      )
      .returning({ id: schema.notifications.id });

    return { marked: marked.length };
  });
}

/**
 * Notification preferences (Phase 9, ai/phase-9-notifications.md §3.3).
 *
 * ## `withUserScope`, not `withOrgScope` — and a bare `userId`, not a `ChatActor`
 *
 * `identity.notification_prefs` is global per user, not per org — see the
 * table's own comment in `packages/db/src/schema/identity.ts` for why an
 * org-keyed version did not survive contact with the router. That means
 * these two functions are the odd ones out in this file twice over: every
 * other function here reads `platform.notifications` (genuinely per-org)
 * through `withOrgScope`, AND takes a `ChatActor` built from an org-resolved
 * principal. `selfRoute` (`prefs.list`/`prefs.set` in `platform/router.ts`)
 * resolves no org at all — the same reason `auth.me` reads
 * `ctx.principal.userId` directly rather than building a `Subject` — so
 * these two take a bare `UserId`, matching that precedent instead of forcing
 * an org-shaped actor where there is no org.
 *
 * ## No domain event on `setPref`, deliberately
 *
 * Same call this file already makes for `markRead`/`markAllRead`, and for
 * the identical reason: guardrail 11 exists so audit, notifications, search,
 * and automation learn about state changes that matter to something
 * downstream, and nothing downstream needs to be told a person turned their
 * own email notifications off. This is a personal setting a member manages
 * about their own account, closer in kind to a read cursor than to a saved
 * VIEW (`work/view.service.ts`) — a view is shared board configuration
 * teammates see and reasonably want an audit trail for; a notification
 * preference is invisible to everyone but its owner.
 */

export interface NotificationPrefEntry {
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
}

/**
 * The full category x channel matrix, resolved — every combination, with
 * `enabled` filled from an explicit row where one exists and from the coded
 * default otherwise. The UI renders this directly rather than reimplementing
 * `resolvePref` client-side, the same reasoning §8.2 gives for why the UI
 * never re-derives an authorization decision: one evaluator, one place it can
 * be wrong.
 */
export async function resolvedPrefs(userId: UserId): Promise<readonly NotificationPrefEntry[]> {
  return withUserScope(userId, async (tx) => {
    const rows = await tx
      .select({
        category: schema.notificationPrefs.category,
        channel: schema.notificationPrefs.channel,
        enabled: schema.notificationPrefs.enabled,
      })
      .from(schema.notificationPrefs)
      .where(eq(schema.notificationPrefs.userId, userId));

    const explicit: ExplicitPref[] = rows.map((row) => ({
      category: row.category as NotificationCategory,
      channel: row.channel as NotificationChannel,
      enabled: row.enabled,
    }));

    const resolved: NotificationPrefEntry[] = [];
    for (const category of NOTIFICATION_CATEGORIES) {
      for (const channel of NOTIFICATION_CHANNELS) {
        resolved.push({ category, channel, enabled: resolvePref(explicit, category, channel) });
      }
    }
    return resolved;
  });
}

/** Sets one (category, channel) cell explicitly — an upsert, keyed on the caller. */
export async function setPref(
  userId: UserId,
  input: {
    readonly category: NotificationCategory;
    readonly channel: NotificationChannel;
    readonly enabled: boolean;
  },
): Promise<{ readonly updated: true }> {
  return withUserScope(userId, async (tx) => {
    await tx
      .insert(schema.notificationPrefs)
      .values({
        userId,
        category: input.category,
        channel: input.channel,
        enabled: input.enabled,
      })
      .onConflictDoUpdate({
        target: [
          schema.notificationPrefs.userId,
          schema.notificationPrefs.category,
          schema.notificationPrefs.channel,
        ],
        set: { enabled: input.enabled, updatedAt: new Date() },
      });

    return { updated: true as const };
  });
}
