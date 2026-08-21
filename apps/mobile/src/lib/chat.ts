import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Chat (Wave 3, `ai/phase-14-mobile.md` roadmap row: "Chat + push — channels,
 * DMs, threads, mentions; FCM/APNs..."). Started as a READ + SEND only cut;
 * a real device video review found the result "very messy" and named
 * specific gaps against web — reactions, mentions, real names instead of
 * "You"/"Member", DM naming, and no way to create a channel or DM at all —
 * closed in the increment that added this file's `groupMessages`/
 * `directLabel`/`QUICK_REACTIONS`/reactions exports. A second review asked
 * for the channel details panel by name ("where to see... members... where
 * to add members") — closed by `channel-details/[channelId].tsx`, which is
 * why this file also carries `PinnedMessage`/`SavedMessage`/`ChannelFile`/
 * `ChannelGuest` now. Thread replies UI, edit/delete, typing indicators,
 * read receipts, link unfurls and in-app calling are still real, separate
 * work — `channel/[channelId].tsx`'s and `channel-details/[channelId].tsx`'s
 * own headers name what changed and what is still deferred.
 *
 * A separate file from `work.ts` rather than appended to it: Chat is a
 * different domain with its own router (`apps/api/src/chat/router.ts`), and
 * `work.ts`'s own header is explicitly about Work's wire shapes — mixing
 * the two would make either file's header describe less than it contains.
 *
 * Thread replies, edit/delete/"remove for me", and the shared
 * `message-composer.tsx` closed most of the remaining gap this header used
 * to name — `thread/[messageId].tsx`'s own header has the design. Read
 * receipts (unread badges + auto-mark-read) closed next — see
 * `unreadCountsQueryKey`'s own comment. Link unfurls closed after that —
 * see `unfurlsQueryKey`'s own comment. Typing indicators, file attaching
 * from the composer, and push are still real, separate work.
 */
export type ChannelList = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['channels']['list']['query']>>
>;
export type Channel = ChannelList['channels'][number];

/** One channel's full detail — `chat.channels.get`, the details screen's own read. */
export type ChannelDetail = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['channels']['get']['query']>>
>;

export type Message = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['messages']['list']['query']>>
>[number];

export type Reaction = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['messages']['reactions']['query']>>
>[number];

/** One row of `chat.channels.unreadCounts` — the channel list's badge count. */
export type UnreadCount = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['channels']['unreadCounts']['query']>>
>[number];

/**
 * One resolved link preview — `chat.unfurls.list`. The service already
 * excludes `pending`/`failed`/`refused` rows (`unfurl.service.ts`'s own
 * `previewsFor`: "not something to render, and sending it would tell every
 * reader which links the SSRF control blocked"), so every row this type
 * describes is ready to show, unconditionally — no `status` field to
 * branch on client-side.
 */
export type UnfurlPreview = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['unfurls']['list']['query']>>
>[number];

/** A pinned message row — `chat.messages.pins`. */
export type PinnedMessage = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['messages']['pins']['query']>>
>[number];

/** A saved (starred) message row — `chat.saved.list`, org-wide, filtered per-screen to one channel. */
export type SavedMessage = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['saved']['list']['query']>>
>[number];

/** A live attachment — `chat.attachments.listForChannel`, the details screen's Files section. */
export type ChannelFile = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['attachments']['listForChannel']['query']>>
>[number];

/** A guest grant on one private channel — `chat.compliance.listGuests`. */
export type ChannelGuest = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['compliance']['listGuests']['query']>>
>[number];

export const CHANNELS_QUERY_KEY = ['chat.channels.list'] as const;

export function channelQueryKey(channelId: string): readonly ['chat.channels.get', string] {
  return ['chat.channels.get', channelId];
}

export function messagesQueryKey(channelId: string): readonly ['chat.messages.list', string] {
  return ['chat.messages.list', channelId];
}

export function pinsQueryKey(channelId: string): readonly ['chat.messages.pins', string] {
  return ['chat.messages.pins', channelId];
}

/** A message's thread — `chat.messages.thread`, the replies only (not the root; see `thread/[messageId].tsx`'s own header). */
export function threadQueryKey(messageId: string): readonly ['chat.messages.thread', string] {
  return ['chat.messages.thread', messageId];
}

/**
 * The channel list's unread badges — `chat.channels.unreadCounts`, mirroring
 * `apps/web/src/features/chat/api.ts`'s own `unreadCountsQuery`: the channel
 * ids sit INSIDE the key (so each distinct roster gets its own cache entry,
 * the same reason `messageIds` is part of `reactionsQuery`'s call, not its
 * key), but `markRead`'s own `onSuccess` invalidates the bare
 * `['chat.channels.unreadCounts']` PREFIX rather than this exact key —
 * TanStack Query matches a shorter key against every longer one that starts
 * with it, so a caller does not need to know the live channel-id array to
 * invalidate every unread count that array produced.
 */
export function unreadCountsQueryKey(
  channelIds: readonly string[],
): readonly ['chat.channels.unreadCounts', readonly string[]] {
  return ['chat.channels.unreadCounts', channelIds];
}

/** Org-wide, same shape as `chat.saved.list`'s own scope — filtered client-side per channel, matching `apps/web`'s `SavedSection`. */
export const SAVED_QUERY_KEY = ['chat.saved.list'] as const;

export function filesQueryKey(
  channelId: string,
): readonly ['chat.attachments.listForChannel', string] {
  return ['chat.attachments.listForChannel', channelId];
}

export function guestsQueryKey(channelId: string): readonly ['chat.compliance.listGuests', string] {
  return ['chat.compliance.listGuests', channelId];
}

/**
 * Deliberately STABLE — no `messageIds` in the key, mirroring
 * `apps/web/src/features/chat/api.ts`'s `reactionsQuery` own fix for the
 * identical bug: a key carrying a fresh array reference on every render
 * restarts the query every render and the reactions bar never settles.
 * Invalidated on `react.mutate`'s `onSuccess` and whenever the message list
 * itself refetches.
 */
export function reactionsQueryKey(channelId: string): readonly ['chat.messages.reactions', string] {
  return ['chat.messages.reactions', channelId];
}

/** Deliberately STABLE, same reasoning as `reactionsQueryKey` above — link previews are fetched chunked over the loaded page's message ids, not keyed by them. */
export function unfurlsQueryKey(channelId: string): readonly ['chat.unfurls.list', string] {
  return ['chat.unfurls.list', channelId];
}

/**
 * The same six web offers (`chat-page.tsx`'s own `QUICK_REACTIONS`) — chat's
 * reaction picker is not a full emoji keyboard on EITHER platform, so this
 * is genuine parity, not a reduced mobile cut.
 */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;

/**
 * A channel's display name. A DM has no name — the database refuses one,
 * because a named DM would be listable — so it is titled by WHO is in it,
 * via the same `personOf` lookup every author line uses now
 * (`use-members.ts`). Ported from `apps/web/src/features/chat/chat-page.tsx`'s
 * own `directLabel`: two people get one name; three or more get "A, B and N
 * others" rather than a list that truncates mid-name.
 */
export function channelDisplayName(
  channel: Pick<Channel, 'name' | 'type' | 'participantIds'>,
  viewerId: string | null,
  personOf: (userId: string) => { readonly label: string },
): string {
  if (channel.name !== null) return channel.name;

  const others = channel.participantIds.filter((userId) => userId !== viewerId);
  if (others.length === 0) return 'Direct message';

  const labels = others.map((userId) => personOf(userId).label);
  const [first, second, ...rest] = labels;
  if (rest.length > 0) return `${first ?? ''}, ${second ?? ''} and ${String(rest.length)} others`;
  if (second !== undefined) return `${first ?? ''}, ${second}`;
  return first ?? 'Direct message';
}

/** Two messages fall in one group only if they are close enough that repeating the header would be noise. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface MessageGroup {
  readonly authorId: string | null;
  readonly messages: readonly Message[];
}

/**
 * Collapses consecutive same-author messages into one visual group —
 * ported verbatim (logic unchanged) from
 * `apps/web/src/features/chat/grouping.ts`, whose own header has the full
 * reasoning: grouped by author ID (never the resolved label, which two
 * different people can share via `personOf`'s raw-id fallback), and the
 * window resets from each message to the PREVIOUS one, not the group's
 * first message, so a burst five minutes apart end-to-end reads as one
 * continuous exchange rather than splitting at an arbitrary point.
 */
export function groupMessages(messages: readonly Message[]): readonly MessageGroup[] {
  const groups: MessageGroup[] = [];

  for (const message of messages) {
    const current = groups[groups.length - 1];
    const previous = current?.messages[current.messages.length - 1];

    const sameAuthor = current?.authorId === message.authorId;
    const withinWindow =
      previous !== undefined &&
      Math.abs(new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()) <
        GROUP_WINDOW_MS;

    if (current !== undefined && sameAuthor && withinWindow) {
      groups[groups.length - 1] = { ...current, messages: [...current.messages, message] };
    } else {
      groups.push({ authorId: message.authorId, messages: [message] });
    }
  }

  return groups;
}

/**
 * How many replies each top-level message has, keyed by the PARENT's id —
 * `chat-page.tsx`'s own inline computation, extracted here because it is
 * exactly the same "count/group by a key" shape `groupReactions` below
 * already is, and worth the same test coverage. Computed from the full
 * `messages.list` page (roots and replies together) rather than a separate
 * count query: a channel's loaded page already has every reply in it, so
 * "how many replies does this message have" is a filter over data already
 * in memory, the same call web's own header makes for the identical field.
 */
export function replyCountsOf(messages: readonly Message[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.parentMessageId === null) continue;
    counts.set(message.parentMessageId, (counts.get(message.parentMessageId) ?? 0) + 1);
  }
  return counts;
}

/** Every reaction row, grouped by message then emoji — ported from `chat-page.tsx`'s own `groupReactions`. */
export function groupReactions(rows: readonly Reaction[]): Map<string, Map<string, string[]>> {
  const byMessage = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const byEmoji = byMessage.get(row.messageId) ?? new Map<string, string[]>();
    byEmoji.set(row.emoji, [...(byEmoji.get(row.emoji) ?? []), row.userId]);
    byMessage.set(row.messageId, byEmoji);
  }
  return byMessage;
}

/** Every resolved link preview, grouped by the message it was found in — the same "group by a key" shape `groupReactions` above already is. */
export function groupPreviews(
  rows: readonly UnfurlPreview[],
): Map<string, readonly UnfurlPreview[]> {
  const byMessage = new Map<string, UnfurlPreview[]>();
  for (const row of rows) {
    const existing = byMessage.get(row.messageId);
    if (existing === undefined) byMessage.set(row.messageId, [row]);
    else existing.push(row);
  }
  return byMessage;
}
