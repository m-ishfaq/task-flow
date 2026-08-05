import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ChannelId, MessageId, UserId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '../../lib/wire.js';
import type { DocumentNode } from '../work/detail/rich-text.js';

/**
 * Every Chat read and write, in one place (ai/phase-5-chat.md §5 Wave 1).
 *
 * Same shape as `work/api.ts`: `queryOptions` rather than hooks so a component
 * and a prefetch share one definition, and `wire()` on every result because
 * `channels.list`/`messages.list` both return `Date` fields the wire actually
 * carries as strings (`lib/wire.ts`).
 */

interface Outputs {
  channels: Awaited<ReturnType<typeof api.chat.channels.list.query>>;
  channel: Awaited<ReturnType<typeof api.chat.channels.get.query>>;
  messages: Awaited<ReturnType<typeof api.chat.messages.list.query>>;
  reactions: Awaited<ReturnType<typeof api.chat.messages.reactions.query>>;
  pins: Awaited<ReturnType<typeof api.chat.messages.pins.query>>;
  unreadCounts: Awaited<ReturnType<typeof api.chat.channels.unreadCounts.query>>;
}

export type ChannelSummary = Wire<Outputs['channels']>[number];
export type ChannelDetail = Wire<Outputs['channel']>;
export type Message = Wire<Outputs['messages']>[number];
export type ReactionRow = Wire<Outputs['reactions']>[number];
export type PinnedMessageRow = Wire<Outputs['pins']>[number];
export type UnreadCount = Wire<Outputs['unreadCounts']>[number];

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

export function channelsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.channels(orgId),
    queryFn: async () => wire(await api.chat.channels.list.query()),
  });
}

export function channelQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: keys.channel(orgId, channelId),
    queryFn: async () => wire(await api.chat.channels.get.query({ channelId })),
  });
}

/**
 * The most recent messages in a channel.
 *
 * No `before` cursor yet — Wave 1 shows the latest 100 and relies on the
 * socket for anything after that, matching the phase's own scope (§2, §5):
 * "load older history" is a real feature with a real cursor contract
 * (`messages.list`'s `before` already supports it) but is not this wave's job
 * to wire a UI for.
 */
export function messagesQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: keys.messages(orgId, channelId),
    queryFn: async () => wire(await api.chat.messages.list.query({ channelId, limit: 100 })),
  });
}

/**
 * One thread's replies, oldest first — the panel opened from a "N replies"
 * indicator. Keyed as an EXTENSION of `keys.messages`, not a sibling key, so
 * `invalidateMessages`'s default prefix match (react-query invalidates every
 * key starting with the one given) already covers an open thread when a
 * reply arrives — no second invalidation call needed at the broadcast site.
 */
export function threadQuery(orgId: string, channelId: ChannelId, messageId: MessageId) {
  return queryOptions({
    queryKey: [...keys.messages(orgId, channelId), 'thread', messageId] as const,
    queryFn: async () => wire(await api.chat.messages.thread.query({ messageId })),
  });
}

/**
 * Reactions for the messages currently rendered.
 *
 * `messageIds` bounds the query the same reasoning `reaction.service.ts`
 * bounds the read: reactions on messages that have scrolled out of the
 * loaded page are not fetched. Disabled when there is nothing loaded yet —
 * the empty-array case `listReactions` refuses would otherwise round-trip
 * for nothing on every channel open.
 */
export function reactionsQuery(orgId: string, channelId: ChannelId, messageIds: readonly string[]) {
  return queryOptions({
    queryKey: [...keys.reactions(orgId, channelId), messageIds] as const,
    queryFn: async () =>
      wire(
        await api.chat.messages.reactions.query({
          channelId,
          messageIds,
        }),
      ),
    enabled: messageIds.length > 0,
  });
}

export function pinsQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: keys.pins(orgId, channelId),
    queryFn: async () => wire(await api.chat.messages.pins.query({ channelId })),
  });
}

/**
 * Unread counts for the sidebar badge.
 *
 * Polled rather than pushed: the sidebar only holds the room for whichever
 * channel is currently open (`use-channel-room.ts`), so a message arriving in
 * a channel that is not open has no live signal to ride on. The same
 * half-a-minute-at-most tradeoff `use-channel-room.ts`'s header documents for
 * project-scoped events applies here — a badge running a few seconds behind
 * is not a silently broken feature.
 */
export function unreadCountsQuery(orgId: string, channelIds: readonly string[]) {
  return queryOptions({
    queryKey: [...keys.unreadCounts(orgId), channelIds] as const,
    queryFn: async () =>
      wire(await api.chat.channels.unreadCounts.query({ channelIds })),
    enabled: channelIds.length > 0,
    refetchInterval: 15_000,
  });
}

/* -------------------------------------------------------------------------- *
 * Mutations
 * -------------------------------------------------------------------------- */

export function createChannel(input: { type: 'public' | 'private'; name: string }) {
  return api.chat.channels.create.mutate(input);
}

export function openDirectMessage(userIds: readonly UserId[]) {
  return api.chat.channels.openDirect.mutate({ userIds });
}

export function addChannelMember(channelId: ChannelId, userId: UserId) {
  return api.chat.channels.addMember.mutate({ channelId, userId });
}

export function removeChannelMember(channelId: ChannelId, userId: UserId) {
  return api.chat.channels.removeMember.mutate({ channelId, userId });
}

export function sendMessage(input: {
  channelId: ChannelId;
  body: DocumentNode;
  parentMessageId?: MessageId | null;
}) {
  return api.chat.messages.send.mutate(input);
}

export function editMessage(messageId: MessageId, body: DocumentNode) {
  return api.chat.messages.edit.mutate({ messageId, body });
}

export function deleteMessage(messageId: MessageId) {
  return api.chat.messages.delete.mutate({ messageId });
}

export function toggleReaction(input: { channelId: ChannelId; messageId: MessageId; emoji: string }) {
  return api.chat.messages.react.mutate(input);
}

export function pinMessage(input: { channelId: ChannelId; messageId: MessageId }) {
  return api.chat.messages.pin.mutate(input);
}

export function unpinMessage(input: { channelId: ChannelId; messageId: MessageId }) {
  return api.chat.messages.unpin.mutate(input);
}

export function markChannelRead(input: { channelId: ChannelId; messageId: MessageId }) {
  return api.chat.channels.markRead.mutate(input);
}

/* -------------------------------------------------------------------------- *
 * Cache edits — invalidate rather than patch (see `use-channel-room.ts`)
 * -------------------------------------------------------------------------- */

export function invalidateChannels(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: keys.channels(orgId) });
}

export function invalidateMessages(client: QueryClient, orgId: string, channelId: string): void {
  void client.invalidateQueries({ queryKey: keys.messages(orgId, channelId) });
}

export function invalidateReactions(client: QueryClient, orgId: string, channelId: string): void {
  void client.invalidateQueries({ queryKey: keys.reactions(orgId, channelId) });
}

export function invalidatePins(client: QueryClient, orgId: string, channelId: string): void {
  void client.invalidateQueries({ queryKey: keys.pins(orgId, channelId) });
}

export function invalidateUnreadCounts(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: keys.unreadCounts(orgId) });
}
