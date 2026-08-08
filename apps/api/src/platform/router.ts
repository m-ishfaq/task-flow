import { z } from 'zod';
import { memberRoute, router, selfRoute } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { ChatActor } from '../chat/shared.js';
import * as notifications from './notifications.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from './notification-prefs.js';

/**
 * Notifications — reading your own, and your own delivery preferences
 * (Phase 9, ai/phase-9-notifications.md).
 *
 * ## Two different "yours alone" routes, on purpose
 *
 * `listMine`/`unreadCount`/`markRead`/`markAllRead` read `platform.notifications`,
 * which IS per-org (a card's assignment or a page's comment happens inside an
 * org). They use `memberRoute` — authenticated, org resolved, but no specific
 * permission — because no single `Permission` describes "read a notification
 * that could have come from any of three products' catalogs"
 * (`channel:read`/`card:read`/`page:read`), and picking one would refuse a
 * member who only participates in the other two. See `memberRoute`'s own doc
 * comment in `trpc/builder.ts` for the full argument; this is the route that
 * needed it built.
 *
 * `prefs.list`/`prefs.set` read `identity.notification_prefs`, which is
 * GLOBAL per user, not per org (`packages/db/src/schema/identity.ts`'s own
 * comment on that table explains why an org-keyed version did not survive
 * contact with the router). They use `selfRoute` — no org resolved at all —
 * for the identical reason `auth.me` and `auth.updateProfile` do.
 *
 * Both used to be `chat.notifications.*`, gated behind `channel:read` — which
 * was correct while chat was the only producer of a notification, and became
 * a real bug the moment Work and Docs became producers too (migration 0027):
 * a Work-only guest, holding no chat permission at all, still gets a
 * `card.assigned` notification and still needs to be able to read it.
 */
export function createPlatformRouter() {
  const actorOf = (ctx: {
    principal: Parameters<typeof subjectOf>[0];
    requestId: ChatActor['requestId'];
  }): ChatActor => ({ subject: subjectOf(ctx.principal), requestId: ctx.requestId });

  return router({
    listMine: memberRoute({ memberReason: 'Reading your own notifications, from any product.' })
      .output(
        z
          .array(
            z.object({
              notificationId: z.string(),
              kind: z.string(),
              subjectType: z.string(),
              subjectId: z.string(),
              channelId: z.string().nullable(),
              boardId: z.string().nullable(),
              title: z.string(),
              excerpt: z.string().nullable(),
              actorId: z.string().nullable(),
              readAt: z.date().nullable(),
              createdAt: z.date(),
            }),
          )
          .readonly(),
      )
      .query(({ ctx }) => notifications.listMine(actorOf(ctx))),

    unreadCount: memberRoute({ memberReason: 'Reading your own unread count.' })
      .output(z.object({ unread: z.number().int().nonnegative() }))
      .query(({ ctx }) => notifications.unreadCount(actorOf(ctx))),

    /* Marks the ONE notification the caller opened, not everything —
       `markAllRead` stays for the bulk "clear the bell" action. */
    markRead: memberRoute({ memberReason: 'Marking your own notification read.' })
      .input(z.object({ notificationId: z.string() }).strict())
      .output(z.object({ marked: z.number().int().nonnegative() }))
      .mutation(({ input, ctx }) => notifications.markRead(actorOf(ctx), input)),

    markAllRead: memberRoute({ memberReason: 'Marking your own notifications read.' })
      .output(z.object({ marked: z.number().int().nonnegative() }))
      .mutation(({ ctx }) => notifications.markAllRead(actorOf(ctx))),

    /**
     * Delivery preferences — the category x channel matrix (§3.3). `selfRoute`,
     * not `memberRoute`: these read `identity.notification_prefs`, which has
     * no `org_id` at all — see the file header.
     */
    prefs: router({
      list: selfRoute({ selfReason: 'Reading your own notification preferences.' })
        .output(
          z
            .array(
              z.object({
                category: z.enum(NOTIFICATION_CATEGORIES as [string, ...string[]]),
                channel: z.enum(NOTIFICATION_CHANNELS as [string, ...string[]]),
                enabled: z.boolean(),
              }),
            )
            .readonly(),
        )
        // ctx.principal.userId directly, not actorOf(ctx) — `selfRoute`
        // resolves no org (see the file header), and `identity.notification_prefs`
        // needs none. Matches `auth.me`'s own precedent
        // (`identity/router.ts`).
        .query(({ ctx }) => notifications.resolvedPrefs(ctx.principal.userId)),

      set: selfRoute({ selfReason: 'Setting your own notification preferences.' })
        .input(
          z
            .object({
              category: z.enum(NOTIFICATION_CATEGORIES as [string, ...string[]]),
              channel: z.enum(NOTIFICATION_CHANNELS as [string, ...string[]]),
              enabled: z.boolean(),
            })
            .strict(),
        )
        .output(z.object({ updated: z.literal(true) }))
        .mutation(({ input, ctx }) =>
          notifications.setPref(ctx.principal.userId, {
            category: input.category as notifications.NotificationPrefEntry['category'],
            channel: input.channel as notifications.NotificationPrefEntry['channel'],
            enabled: input.enabled,
          }),
        ),
    }),
  });
}
