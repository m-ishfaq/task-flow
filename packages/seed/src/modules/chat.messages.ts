import { createEvent } from '@taskflow/events';
import {
  channelReadAdvanced,
  messageDeleted,
  messageEdited,
  messagePinned,
  messageReactionAdded,
  messageSent,
  messageUnfurled,
} from '@taskflow/api/events/chat';
import { roleGrants } from '@taskflow/policy';
import type { RichTextNode } from '@taskflow/api/richtext';
import {
  EMOJI_PALETTE,
  UNFURL_FIXTURES,
  flatten,
  messageDocument,
  type Mentionable,
  type UnfurlFixture,
} from '../corpus.js';
import type { Rng } from '../rng.js';
import type { MessageMix } from '../profiles.js';
import type { SeedContext } from '../context.js';
import { defineSeedModule } from '../registry.js';
import { envelopeFor, minutesAfter } from '../support.js';
import { channelsModule, type SeededChannel } from './chat.channels.js';
import type { SeededMembership } from './tenancy.orgs.js';

/**
 * Messages and everything that hangs off one — threads, reactions, pins, read
 * cursors and link previews.
 *
 * `work.cards` is the module this mirrors: one container's children are built in
 * a single pass so counters and cross-references come out of the arrays already
 * in memory rather than from a second read.
 *
 * ## The id IS the sort order, so it is minted from the message's own timestamp
 *
 * `listMessages` pages on `id < cursor` because ids are UUIDv7 — creation-ordered
 * AND unique, which a timestamp is not (two messages can share a millisecond,
 * and the one that loses the tie is skipped forever). That property only holds
 * if the id's embedded timestamp agrees with `created_at`, so every id here is
 * `rng.uuid(sentAt)` and never `rng.uuid(ctx.now)`. Seeding them from the run's
 * clock would produce a channel whose messages page in generation order while
 * displaying in conversation order — a discrepancy that looks like a paging bug
 * in the client and is not one.
 *
 * ## Authors come from the roster, never from the org
 *
 * A message whose author is not a member of its channel is a row the product
 * could not have produced: `sendMessage` enforces `message:create` on the
 * channel, which for anything closed means holding the membership tuple. Drawing
 * authors from `channel.members` is what keeps a private channel's history
 * consistent with its access.
 *
 * ## Deletion is a tombstone with two consistent columns
 *
 * `deleted_at` and `deleted_by_author` are set together or not at all —
 * `messages_deletion_consistent` refuses anything else, which is what lets the
 * message list branch on `deleted_at` alone and trust the other column. A
 * moderator removal is attributed to somebody who actually holds
 * `message:delete`; `member` does not (see `packages/policy/src/roles.ts`, where
 * its removal is documented rather than silently dropped), so the moderator is
 * asked for by capability and the deletion falls back to the author when the
 * channel holds nobody who could have moderated it.
 */

/** A live message an attachment could hang off — `SeededCardRef`'s counterpart. */
export interface SeededMessageRef {
  readonly id: string;
  readonly orgId: string;
  readonly channelId: string;
  readonly createdAt: Date;
  readonly authorId: string;
}

export interface MessagesOutput {
  readonly messageCount: number;
  readonly messageRefs: readonly SeededMessageRef[];
}

interface DraftMessage {
  readonly id: string;
  readonly parentId: string | null;
  readonly author: SeededMembership;
  readonly body: RichTextNode;
  readonly bodyText: string;
  readonly mentionedUserIds: readonly string[];
  readonly unfurls: readonly UnfurlFixture[];
  readonly createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedByAuthor: boolean | null;
}

/** A member left this far behind in the busiest channel, so an unread badge has
 * to render three digits rather than a comfortable single one. */
const DEEP_UNREAD_CHANNEL_SIZE = 200;

export const messagesModule = defineSeedModule({
  name: 'chat.messages',
  requires: [channelsModule],
  tables: [
    'chat.messages',
    'chat.message_reactions',
    'chat.pinned_messages',
    'chat.read_cursors',
    'chat.message_unfurls',
  ],

  async seed(ctx): Promise<MessagesOutput> {
    const rng = ctx.rng.fork('chat.messages');
    const mix = ctx.profile.message;
    const { channels } = ctx.use(channelsModule);

    const byOrg = new Map<string, SeededChannel[]>();
    for (const channel of channels) {
      const list = byOrg.get(channel.orgId) ?? [];
      list.push(channel);
      byOrg.set(channel.orgId, list);
    }

    /* Placed at most once per run: a moderator tombstone that is the PARENT of a
       live thread. The migration argues that a message is a tombstone rather
       than a row removal precisely because "a thread that loses its middle
       becomes incoherent" — and that claim is only demonstrated by a database
       that actually contains one. */
    let tombstoneParentPlaced = false;

    let messageCount = 0;
    const messageRefs: SeededMessageRef[] = [];

    for (const [orgId, orgChannels] of byOrg) {
      const messageRows: unknown[][] = [];
      const reactionRows: unknown[][] = [];
      const pinRows: unknown[][] = [];
      const cursorRows: unknown[][] = [];
      const unfurlRows: unknown[][] = [];

      for (const channel of orgChannels) {
        if (channel.plan.messages === 0 || channel.members.length === 0) continue;

        const drafts = buildConversation(ctx, rng, channel, mix, () => {
          if (tombstoneParentPlaced) return false;
          tombstoneParentPlaced = true;
          return true;
        });

        for (const draft of drafts) {
          messageRows.push([
            draft.id,
            orgId,
            channel.id,
            draft.parentId,
            draft.author.user.id,
            draft.body,
            draft.bodyText,
            draft.editedAt,
            draft.deletedAt,
            draft.deletedByAuthor,
            draft.createdAt,
          ]);

          if (draft.deletedAt === null) {
            messageRefs.push({
              id: draft.id,
              orgId,
              channelId: channel.id,
              createdAt: draft.createdAt,
              authorId: draft.author.user.id,
            });
          }
        }

        messageCount += drafts.length;

        const live = drafts.filter((draft) => draft.deletedAt === null);

        /* ------------------------------------------------------------------ *
         * Reactions
         * ------------------------------------------------------------------ */
        for (const draft of live) {
          if (!rng.chance(mix.reactedRate)) continue;

          const emojiCount = Math.min(
            rng.int(mix.reactions[0], mix.reactions[1]),
            EMOJI_PALETTE.length,
          );
          /* Distinct emoji, and distinct reactors within each — the primary key
             is (message_id, user_id, emoji), so independent draws would
             eventually collide and fail the whole insert rather than one row. */
          for (const emoji of rng.sample(EMOJI_PALETTE, emojiCount)) {
            const reactors = rng.sample(
              channel.members,
              rng.int(1, Math.min(4, channel.members.length)),
            );
            for (const reactor of reactors) {
              const reactedAt = minutesAfter(draft.createdAt, rng.int(1, 240));
              reactionRows.push([
                orgId,
                channel.id,
                draft.id,
                reactor.user.id,
                emoji,
                clampToNow(reactedAt, ctx.now),
              ]);

              if (rng.chance(ctx.profile.messageEventSampleRate)) {
                ctx.emit(
                  createEvent(
                    messageReactionAdded,
                    {
                      messageId: draft.id,
                      channelId: channel.id,
                      userId: reactor.user.id,
                      emoji,
                    },
                    envelopeFor(orgId, reactor.user.id, clampToNow(reactedAt, ctx.now)),
                  ),
                );
              }
            }
          }
        }

        /* ------------------------------------------------------------------ *
         * Pins — `message:create`, which every member of the channel holds
         * (pin.service.ts), so the pinner is any member rather than a manager.
         * ------------------------------------------------------------------ */
        const pinCount = Math.min(
          rng.int(mix.pinnedPerChannel[0], mix.pinnedPerChannel[1]),
          live.length,
        );
        for (const draft of rng.sample(live, pinCount)) {
          const pinner = rng.pick(channel.members);
          const pinnedAt = clampToNow(minutesAfter(draft.createdAt, rng.int(5, 2_880)), ctx.now);
          pinRows.push([orgId, channel.id, draft.id, pinner.user.id, pinnedAt]);

          if (rng.chance(ctx.profile.messageEventSampleRate)) {
            ctx.emit(
              createEvent(
                messagePinned,
                { messageId: draft.id, channelId: channel.id, pinnedBy: pinner.user.id },
                envelopeFor(orgId, pinner.user.id, pinnedAt),
              ),
            );
          }
        }

        /* ------------------------------------------------------------------ *
         * Read cursors
         *
         * Emitted UNSAMPLED, unlike everything else here. `channel.read_advanced`
         * is the one event deliberately excluded from the audit projection
         * (`NEVER_AUDITED`), so it costs an outbox row and a claim-and-skip and
         * never touches the per-org chain-head lock — and nothing else in the
         * database exercises that path.
         * ------------------------------------------------------------------ */
        if (live.length > 0) {
          const deepUnread = channel.plan.messages >= DEEP_UNREAD_CHANNEL_SIZE;

          for (const [index, membership] of channel.members.entries()) {
            if (!rng.chance(mix.readCursorRate)) continue;

            /* The first member of a big channel is left near the start on
               purpose. Everyone else lands somewhere in the last third, which is
               what an ordinary unread count looks like. */
            const target =
              deepUnread && index === 0
                ? live[Math.floor(live.length * 0.08)]
                : live[rng.int(Math.floor(live.length * 0.66), live.length - 1)];
            if (!target) continue;

            const cursor = ctx.chaos ? chaosCursor(drafts, target) : target;
            const readAt = clampToNow(minutesAfter(cursor.createdAt, rng.int(1, 600)), ctx.now);

            cursorRows.push([orgId, channel.id, membership.user.id, cursor.id, readAt]);

            ctx.emit(
              createEvent(
                channelReadAdvanced,
                {
                  channelId: channel.id,
                  userId: membership.user.id,
                  lastReadMessageId: cursor.id,
                },
                envelopeFor(orgId, membership.user.id, readAt),
              ),
            );
          }
        }

        /* ------------------------------------------------------------------ *
         * Link previews
         * ------------------------------------------------------------------ */
        for (const draft of drafts) {
          if (draft.unfurls.length === 0) continue;
          if (!rng.chance(mix.unfurlRate)) continue;

          const fetchedAt = clampToNow(minutesAfter(draft.createdAt, rng.int(1, 5)), ctx.now);
          let resolved = 0;

          for (const fixture of draft.unfurls) {
            unfurlRows.push([
              orgId,
              channel.id,
              draft.id,
              fixture.url,
              fixture.status,
              fixture.title,
              fixture.description,
              fixture.imageUrl,
              fixture.siteName,
              fetchedAt,
            ]);
            if (fixture.status === 'ok') resolved += 1;
          }

          if (rng.chance(ctx.profile.messageEventSampleRate)) {
            ctx.emit(
              createEvent(
                messageUnfurled,
                {
                  messageId: draft.id,
                  channelId: channel.id,
                  /* How many RESOLVED, not how many were attempted. Zero is a
                     real outcome — a message whose only link was refused. */
                  previewCount: resolved,
                },
                envelopeFor(orgId, draft.author.user.id, fetchedAt),
              ),
            );
          }
        }

        /* ------------------------------------------------------------------ *
         * Message lifecycle events — sampled (`messageEventSampleRate`)
         * ------------------------------------------------------------------ */
        for (const draft of drafts) {
          if (!rng.chance(ctx.profile.messageEventSampleRate)) continue;

          ctx.emit(
            createEvent(
              messageSent,
              {
                messageId: draft.id,
                channelId: channel.id,
                parentMessageId: draft.parentId,
                // Words, not a document: a notification cannot render TipTap
                // JSON. Same slice the service takes.
                excerpt: draft.bodyText.slice(0, 280),
                mentionedUserIds: draft.mentionedUserIds,
              },
              envelopeFor(orgId, draft.author.user.id, draft.createdAt),
            ),
          );

          if (draft.editedAt !== null) {
            ctx.emit(
              createEvent(
                messageEdited,
                {
                  messageId: draft.id,
                  channelId: channel.id,
                  excerpt: draft.bodyText.slice(0, 280),
                  mentionedUserIds: draft.mentionedUserIds,
                },
                envelopeFor(orgId, draft.author.user.id, draft.editedAt),
              ),
            );
          }

          if (draft.deletedAt !== null && draft.deletedByAuthor !== null) {
            const actorId = draft.deletedByAuthor
              ? draft.author.user.id
              : (moderatorFor(channel, draft.author)?.user.id ?? draft.author.user.id);

            ctx.emit(
              createEvent(
                messageDeleted,
                {
                  messageId: draft.id,
                  channelId: channel.id,
                  byAuthor: draft.deletedByAuthor,
                  /* Always 'user' here. Wave 4's retention sweep is what emits
                     'retention_policy', and nothing in this seeder is that
                     sweep. */
                  reason: 'user' as const,
                },
                envelopeFor(orgId, actorId, draft.deletedAt),
              ),
            );
          }
        }
      }

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'chat.messages',
          [
            'id',
            'org_id',
            'channel_id',
            'parent_message_id',
            'author_id',
            'body::jsonb',
            'body_text',
            'edited_at',
            'deleted_at',
            'deleted_by_author',
            'created_at',
          ],
          messageRows,
        );

        await ctx.db.insert(
          'chat.message_reactions',
          ['org_id', 'channel_id', 'message_id', 'user_id', 'emoji', 'created_at'],
          reactionRows,
        );

        await ctx.db.insert(
          'chat.pinned_messages',
          ['org_id', 'channel_id', 'message_id', 'pinned_by', 'pinned_at'],
          pinRows,
        );

        await ctx.db.insert(
          'chat.read_cursors',
          ['org_id', 'channel_id', 'user_id', 'last_read_message_id', 'last_read_at'],
          cursorRows,
        );

        await ctx.db.insert(
          'chat.message_unfurls',
          [
            'org_id',
            'channel_id',
            'message_id',
            'url',
            'status',
            'title',
            'description',
            'image_url',
            'site_name',
            'fetched_at',
          ],
          unfurlRows,
        );
      });

      ctx.log(
        `chat.messages: ${String(messageRows.length)} messages, ` +
          `${String(reactionRows.length)} reactions, ${String(pinRows.length)} pins, ` +
          `${String(cursorRows.length)} cursors, ${String(unfurlRows.length)} previews`,
      );
    }

    return { messageCount, messageRefs };
  },
});

/* -------------------------------------------------------------------------- *
 * Generation
 * -------------------------------------------------------------------------- */

/**
 * One channel's conversation, top-level messages and their replies interleaved.
 *
 * Timestamps are spread across the channel's whole life rather than stepped by a
 * fixed interval: a channel created eight months ago whose messages all land in
 * its first fortnight looks like an import, not a conversation, and every
 * "recent activity" affordance in the product reads from the tail.
 */
function buildConversation(
  ctx: SeedContext,
  rng: Rng,
  channel: SeededChannel,
  mix: MessageMix,
  claimTombstoneParent: () => boolean,
): DraftMessage[] {
  /* An archived channel accepts no new messages — `sendMessage` refuses one —
     so its history stops at the moment it was archived rather than running up
     to the seed run's clock. */
  const tip = channel.archivedAt ?? ctx.now;
  const span = Math.max(tip.getTime() - channel.createdAt.getTime(), 60_000);
  const averageStep = span / (channel.plan.messages + 1);

  const mentionables: Mentionable[] = channel.members.map((membership) => ({
    id: membership.user.id,
    name: membership.user.name.full,
  }));

  const drafts: DraftMessage[] = [];
  let elapsed = 0;

  for (let index = 0; index < channel.plan.messages; index += 1) {
    // Jittered around the average so the gaps vary; cumulative, so the sequence
    // still walks forward and the ids stay creation-ordered.
    elapsed += averageStep * (0.3 + rng.next() * 1.4);
    const sentAt = clampTo(new Date(channel.createdAt.getTime() + elapsed), tip);

    const author = rng.pick(channel.members);
    const parent = buildMessage(rng, channel, mix, mentionables, author, sentAt, null);

    const threaded = rng.chance(mix.threadedRate);
    const replies: DraftMessage[] = [];

    if (threaded) {
      const replyCount = rng.int(mix.replies[0], mix.replies[1]);
      let replyAt = sentAt;
      for (let r = 0; r < replyCount; r += 1) {
        replyAt = clampTo(minutesAfter(replyAt, rng.int(2, 400)), tip);
        replies.push(
          buildMessage(
            rng,
            channel,
            mix,
            mentionables,
            rng.pick(channel.members),
            replyAt,
            parent.id,
          ),
        );
      }
    }

    /* The forced case: a moderator tombstone whose thread is still live. Claimed
       before the ordinary deletion draw so it cannot be overwritten by one, and
       only when the channel actually holds somebody who could have moderated —
       a tombstone attributed to a member is a row no route could have written. */
    const moderator = moderatorFor(channel, author);
    if (replies.length > 0 && moderator && claimTombstoneParent()) {
      parent.deletedAt = clampTo(minutesAfter(sentAt, rng.int(30, 2_880)), tip);
      parent.deletedByAuthor = false;
    } else {
      applyLifecycle(rng, mix, parent, tip, moderator !== undefined);
    }

    for (const reply of replies) {
      applyLifecycle(rng, mix, reply, tip, moderatorFor(channel, reply.author) !== undefined);
    }

    drafts.push(parent, ...replies);
  }

  return drafts;
}

function buildMessage(
  rng: Rng,
  channel: SeededChannel,
  mix: MessageMix,
  mentionables: readonly Mentionable[],
  author: SeededMembership,
  sentAt: Date,
  parentId: string | null,
): DraftMessage {
  /* Mentions name someone else in the channel. A message that mentions its own
     author is legal and meaningless, and the notification consumer this payload
     feeds would have to special-case it. */
  const others = mentionables.filter((person) => person.id !== author.user.id);
  const mentions =
    rng.chance(mix.mentionRate) && others.length > 0 ? rng.sample(others, rng.int(1, 2)) : [];

  /* Fixtures are drawn distinct because the unfurl primary key is
     (org_id, message_id, url) — the same link twice in one message is one row,
     not two, and generating it as two would fail the insert. */
  const fixtures = rng.chance(mix.linkRate) ? rng.sample(UNFURL_FIXTURES, rng.int(1, 2)) : [];

  const content = messageDocument(rng, {
    mentions,
    links: fixtures.map((fixture) => fixture.url),
  });

  return {
    /* From the message's own instant, not the run's — see the module header.
       This is what makes `id` a usable paging cursor. */
    id: rng.uuid(sentAt),
    parentId,
    author,
    body: content.document,
    bodyText: flatten(content.document),
    mentionedUserIds: content.mentionedUserIds,
    unfurls: fixtures,
    createdAt: sentAt,
    editedAt: null,
    deletedAt: null,
    deletedByAuthor: null,
  };
}

/**
 * Edits and deletions.
 *
 * `deleted_at` and `deleted_by_author` move together — `messages_deletion_consistent`
 * refuses a row where only one is set, which is what lets the message list read
 * `deleted_at` alone and trust the rest.
 */
function applyLifecycle(
  rng: Rng,
  mix: MessageMix,
  draft: DraftMessage,
  tip: Date,
  hasModerator: boolean,
): void {
  if (rng.chance(mix.editedRate)) {
    draft.editedAt = clampTo(minutesAfter(draft.createdAt, rng.int(1, 180)), tip);
  }

  if (!rng.chance(mix.deletedRate)) return;

  draft.deletedAt = clampTo(
    minutesAfter(draft.editedAt ?? draft.createdAt, rng.int(5, 4_320)),
    tip,
  );
  /* Falls back to an author withdrawal when the channel holds nobody who could
     have moderated — a DM between two members has no moderator, and attributing
     a removal to one of them would be a permission nobody in that conversation
     holds. */
  draft.deletedByAuthor = hasModerator ? !rng.chance(mix.moderatorShare) : true;
}

/**
 * Someone in this channel who could have removed a message the given person wrote.
 *
 * `message:delete` is the moderation capability and comes from the ROLE alone —
 * the `member` relation a channel tuple grants covers read, download and
 * message create/update, not deletion. Asked through `roleGrants` because
 * guardrail 7 bans the inline comparison and because the answer belongs where
 * the policy matrix test can see it.
 */
function moderatorFor(
  channel: SeededChannel,
  author: SeededMembership,
): SeededMembership | undefined {
  return channel.members.find(
    (membership) =>
      membership.user.id !== author.user.id && roleGrants(membership.role, 'message:delete'),
  );
}

/**
 * `--chaos`: point a read cursor at a message that was subsequently deleted.
 *
 * Normal generation never does this — cursors land on live messages — so the
 * unread count never has to resolve a tombstone at its own boundary. The row is
 * legal (the foreign key names a message, and a deleted message is still a row),
 * which is exactly why it is worth being able to produce on demand rather than
 * waiting to meet it.
 */
function chaosCursor(drafts: readonly DraftMessage[], fallback: DraftMessage): DraftMessage {
  return drafts.find((draft) => draft.deletedAt !== null) ?? fallback;
}

/** Never past a channel's last possible moment — its archival, or the run's clock. */
function clampTo(candidate: Date, tip: Date): Date {
  return candidate.getTime() > tip.getTime() ? tip : candidate;
}

/** Never later than "now". A reaction cannot arrive after the seed run. */
function clampToNow(candidate: Date, now: Date): Date {
  return candidate.getTime() > now.getTime() ? now : candidate;
}
