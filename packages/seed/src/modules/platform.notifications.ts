import { defineSeedModule } from '../registry.js';
import { daysAfter } from '../support.js';
import { channelsModule, type SeededChannel } from './chat.channels.js';
import { messagesModule } from './chat.messages.js';
import type { SeededMembership } from './tenancy.orgs.js';

/**
 * The bell/inbox (Phase 9, ai/phase-9-notifications.md).
 *
 * ## Two kinds, not the seven the schema accepts
 *
 * `apps/api/src/platform/notification.projection.ts` derives seven kinds from
 * outbox events, and four of them (`card.assigned`, `card.comment_mention`,
 * `card.due_soon`, `page.comment_mention`) need a real card title, card
 * number, or page title to write an honest `title`/`excerpt` SNAPSHOT — the
 * whole point of those two columns being stored rather than joined live. The
 * refs `work.cards` and `docs.spaces` currently export
 * (`SeededCardRef`/`SeededPage`) carry ids and parent ids, not titles, so
 * inventing one here would be exactly the "a lie that looks like data" this
 * package's other modules refuse to do for storage and telephony. Left for a
 * follow-up that extends those refs; not silently skipped, named here.
 *
 * `chat.direct` and `chat.mention` need only what `chat.messages` already
 * exports (`SeededMessageRef`) plus the roster `chat.channels` already
 * carries, so those two are real. The title strings below are copied
 * verbatim from the projection's own `add()` calls — a seeded notification
 * that reads differently from a real one is a fixture bug, not a smaller
 * version of the feature.
 *
 * ## Sampled, like card and message events
 *
 * The real projection notifies on every DM message and every mention — 1:1
 * with `chat.messages`' own volume would make the inbox a duplicate of the
 * message log. Sampled here for the same reason `Profile.messageEventSampleRate`
 * samples chat's own outbox writes: this module is choosing which of the
 * messages that already exist got read as "important enough to notify",
 * not inventing traffic that never happened.
 */

const NOTIFICATION_SAMPLE_RATE = 0.15;
const READ_SHARE = 0.5;

function isDirect(type: SeededChannel['type']): boolean {
  return type === 'dm' || type === 'group_dm';
}

interface PlannedNotification {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly kind: 'chat.direct' | 'chat.mention';
  readonly subjectId: string;
  readonly channelId: string;
  readonly title: string;
  readonly actorId: string;
  readonly createdAt: Date;
}

export const notificationsModule = defineSeedModule({
  name: 'platform.notifications',
  requires: [channelsModule, messagesModule],
  tables: ['platform.notifications', 'platform.notification_deliveries'],

  async seed(ctx) {
    const rng = ctx.rng.fork('platform.notifications');
    const { channels } = ctx.use(channelsModule);
    const { messageRefs } = ctx.use(messagesModule);

    const channelById = new Map(channels.map((channel) => [channel.id, channel]));
    const membersByChannel = new Map<string, readonly SeededMembership[]>(
      channels.map((channel) => [channel.id, channel.members]),
    );

    let notificationCount = 0;
    let deliveryCount = 0;

    const byOrg = new Map<string, PlannedNotification[]>();

    for (const ref of messageRefs) {
      if (!rng.chance(NOTIFICATION_SAMPLE_RATE)) continue;

      const channel = channelById.get(ref.channelId);
      if (channel === undefined) continue;

      const roster = membersByChannel.get(ref.channelId) ?? [];
      const others = roster.filter((member) => member.user.id !== ref.authorId);
      if (others.length === 0) continue;

      const createdAt = ref.createdAt;
      const list = byOrg.get(ref.orgId) ?? [];

      if (isDirect(channel.type)) {
        /* Every OTHER participant, matching the real projection's
           `directRecipientIds` loop — a DM notifies its whole roster, mention
           or not. */
        for (const member of others) {
          list.push({
            id: rng.uuid(createdAt),
            orgId: ref.orgId,
            userId: member.user.id,
            kind: 'chat.direct',
            subjectId: ref.id,
            channelId: ref.channelId,
            title: 'New direct message',
            actorId: ref.authorId,
            createdAt,
          });
        }
      } else if (channel.name !== null) {
        /* One simulated mention per sampled message, not every member — a
           public channel's whole roster is not @mentioned by one message. */
        const mentioned = rng.pick(others);
        list.push({
          id: rng.uuid(createdAt),
          orgId: ref.orgId,
          userId: mentioned.user.id,
          kind: 'chat.mention',
          subjectId: ref.id,
          channelId: ref.channelId,
          title: `Mentioned in #${channel.name}`,
          actorId: ref.authorId,
          createdAt,
        });
      }

      byOrg.set(ref.orgId, list);
    }

    for (const [orgId, planned] of byOrg) {
      if (planned.length === 0) continue;

      const notificationRows: unknown[][] = [];
      const deliveryRows: unknown[][] = [];

      for (const notification of planned) {
        const read = rng.chance(READ_SHARE);
        const readAt = read ? daysAfter(notification.createdAt, rng.int(0, 3)) : null;

        notificationRows.push([
          notification.id,
          notification.orgId,
          notification.userId,
          notification.kind,
          'message',
          notification.subjectId,
          notification.channelId,
          null, // board_id — chat kinds never navigate to a board
          notification.title,
          null, // excerpt — chat.messages does not export body text to snapshot
          notification.actorId,
          readAt,
          notification.createdAt,
        ]);
        notificationCount += 1;

        /* An email delivery for most notifications, mostly sent — mirrors
           `notification-mail.ts`'s own dispatch outcome distribution enough
           to give the delivery-status column something other than a single
           repeated value. In-app delivery IS the notifications row itself
           (platform.ts's own header), so no row is written for that channel. */
        if (rng.chance(0.6)) {
          const status = rng.weighted([
            ['sent', 8],
            ['failed', 1],
            ['suppressed', 1],
          ] as const);
          /* `reason` is a CLOSED set — 0027's
             `notification_deliveries_reason_valid` CHECK accepts only these
             four codes, and prose here is refused by the database rather than
             stored as a nicer-looking string. The three below are the ones a
             chat email can actually be suppressed by; `no_provider` belongs to
             the SMS channel (notification.projection.ts, due-reminders.ts) and
             would be a lie on an email row. */
          const reason = rng.weighted([
            ['pref_disabled', 5],
            ['quiet_hours', 3],
            ['digest_pending', 2],
          ] as const);
          deliveryRows.push([
            rng.uuid(notification.createdAt),
            notification.orgId,
            notification.userId,
            notification.id,
            'email',
            status,
            status === 'suppressed' ? reason : null,
            notification.createdAt,
            notification.createdAt,
          ]);
          deliveryCount += 1;
        }
      }

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'platform.notifications',
          [
            'id',
            'org_id',
            'user_id',
            'kind',
            'subject_type',
            'subject_id',
            'channel_id',
            'board_id',
            'title',
            'excerpt',
            'actor_id',
            'read_at',
            'created_at',
          ],
          notificationRows,
        );
        await ctx.db.insert(
          'platform.notification_deliveries',
          [
            'id',
            'org_id',
            'user_id',
            'notification_id',
            'channel',
            'status',
            'reason',
            'created_at',
            'updated_at',
          ],
          deliveryRows,
        );
      });
    }

    ctx.log(
      `platform.notifications: ${String(notificationCount)} notifications ` +
        `(${String(deliveryCount)} with an email delivery row)`,
    );

    return { notificationCount, deliveryCount };
  },
});
