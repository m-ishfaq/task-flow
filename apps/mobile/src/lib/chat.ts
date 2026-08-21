import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Chat (Wave 3, `ai/phase-14-mobile.md` roadmap row: "Chat + push — channels,
 * DMs, threads, mentions; FCM/APNs..."). Started as a READ + SEND only cut;
 * a real device video review found the result "very messy" and named
 * specific gaps against web — reactions, mentions, real names instead of
 * "You"/"Member", DM naming, and no way to create a channel or DM at all —
 * closed in the increment that added this file's `groupMessages`/
 * `directLabel`/`QUICK_REACTIONS`/reactions exports. Thread replies UI,
 * edit/delete, typing indicators, read receipts, link unfurls and
 * attachments are still real, separate work — `channel/[channelId].tsx`'s
 * own header names what changed and what is still deferred.
 *
 * A separate file from `work.ts` rather than appended to it: Chat is a
 * different domain with its own router (`apps/api/src/chat/router.ts`), and
 * `work.ts`'s own header is explicitly about Work's wire shapes — mixing
 * the two would make either file's header describe less than it contains.
 */
export type ChannelList = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['channels']['list']['query']>>
>;
export type Channel = ChannelList['channels'][number];

export type Message = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['messages']['list']['query']>>
>[number];

export type Reaction = Wire<
  Awaited<ReturnType<MobileTRPCClient['chat']['messages']['reactions']['query']>>
>[number];

export const CHANNELS_QUERY_KEY = ['chat.channels.list'] as const;

export function messagesQueryKey(channelId: string): readonly ['chat.messages.list', string] {
  return ['chat.messages.list', channelId];
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
