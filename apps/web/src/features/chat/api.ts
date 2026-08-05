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
}

export type ChannelSummary = Wire<Outputs['channels']>[number];
export type ChannelDetail = Wire<Outputs['channel']>;
export type Message = Wire<Outputs['messages']>[number];

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

/* -------------------------------------------------------------------------- *
 * Cache edits — invalidate rather than patch (see `use-channel-room.ts`)
 * -------------------------------------------------------------------------- */

export function invalidateChannels(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: keys.channels(orgId) });
}

export function invalidateMessages(client: QueryClient, orgId: string, channelId: string): void {
  void client.invalidateQueries({ queryKey: keys.messages(orgId, channelId) });
}
