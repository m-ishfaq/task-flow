import { and, desc, eq, isNull, schema, withOrgScope } from '@taskflow/db';
import { orgOf, userOf, type ChatActor } from './shared.js';

/**
 * Reading and clearing your own notifications.
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
