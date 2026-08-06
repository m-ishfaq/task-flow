import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { AttachmentId, ChannelId, MessageId, UserId } from '@taskflow/contracts';
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
export type PinnedMessageSummary = Wire<
  Awaited<ReturnType<typeof api.chat.messages.allPins.query>>
>[number];
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

/** Every pin the caller can see, across every channel — the sidebar panel. */
export function allPinsQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.allPins(orgId),
    queryFn: async () => wire(await api.chat.messages.allPins.query()),
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
    queryFn: async () => wire(await api.chat.channels.unreadCounts.query({ channelIds })),
    enabled: channelIds.length > 0,
    refetchInterval: 15_000,
  });
}

/**
 * The read cursor as it was when this channel was opened — where the "new
 * messages" divider goes.
 *
 * ## Why this is a separate query and not a read of `unreadCountsQuery`
 *
 * The panel marks the channel read on every message that arrives while it is
 * open, and `markRead` invalidates `keys.unreadCounts`. A divider computed from
 * that query would therefore chase itself: it would appear for one render and
 * vanish, and while someone was reading it would walk down the list as each new
 * message advanced the cursor past it.
 *
 * So this asks the same endpoint under a key OUTSIDE the `unreadCounts` prefix,
 * which `invalidateUnreadCounts` cannot match, with `staleTime: Infinity` so it
 * fetches once and never again. The freeze is a property of the cache rather
 * than of a ref mutated during render or a `setState` in an effect — both of
 * which the React Compiler rejects, and rightly: a value that depends on how
 * many times a render was attempted is not a value.
 *
 * The panel is keyed by channel, so "once" means once per conversation opened.
 */
export function entryCursorQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: [...keys.channel(orgId, channelId), 'entry-cursor'] as const,
    queryFn: async () => {
      const rows = wire(await api.chat.channels.unreadCounts.query({ channelIds: [channelId] }));
      return rows[0]?.lastReadMessageId ?? null;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
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

/**
 * Rename a channel or change its topic. `channel:manage`.
 *
 * A full replace of both fields, and unlike `cards.update` that is safe here:
 * the details panel holds the whole channel, so there is no field the editor
 * cannot see. The trap `useUpdateCard` exists to prevent — a summary-shaped
 * write erasing something nobody had loaded — has no analogue.
 *
 * `type` is deliberately absent. Flipping a channel public→private has to evict
 * every non-member's open socket and private→public exposes history written
 * under an expectation of privacy; both are real decisions, and neither is a
 * field on an edit form. The service refuses it too.
 */
export function updateChannel(input: { channelId: ChannelId; name: string; topic: string | null }) {
  return api.chat.channels.update.mutate(input);
}

/** Archive or restore. `channel:manage`, so a DM refuses through `can()`. */
export function archiveChannel(input: { channelId: ChannelId; restored: boolean }) {
  return api.chat.channels.archive.mutate(input);
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

export function toggleReaction(input: {
  channelId: ChannelId;
  messageId: MessageId;
  emoji: string;
}) {
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

/**
 * One channel's own row — its name, topic and member list.
 *
 * Separate from `invalidateChannels` because they answer different questions:
 * the list is the sidebar, this is the details panel. Adding someone to a
 * channel changes both (the roster here, the "joined" flag there), so a
 * membership change calls both rather than this one standing in for the pair.
 */
export function invalidateChannel(client: QueryClient, orgId: string, channelId: string): void {
  void client.invalidateQueries({ queryKey: keys.channel(orgId, channelId) });
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

export function invalidateAllPins(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: keys.allPins(orgId) });
}

export function invalidateChannelGuests(
  client: QueryClient,
  orgId: string,
  channelId: string,
): void {
  void client.invalidateQueries({ queryKey: keys.channelGuests(orgId, channelId) });
}

export function invalidateUnreadCounts(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: keys.unreadCounts(orgId) });
}

/* -------------------------------------------------------------------------- *
 * Wave 3 — attachments and link previews
 * -------------------------------------------------------------------------- */

export type MessageAttachment = Wire<
  Awaited<ReturnType<typeof api.chat.attachments.list.query>>
>[number];
export type MessagePreview = Wire<Awaited<ReturnType<typeof api.chat.unfurls.list.query>>>[number];

/**
 * Attachments for the page of messages currently rendered.
 *
 * Bounded by `messageIds` the same way reactions are: files on messages that
 * have scrolled out of the loaded page are not fetched. Disabled when the page
 * is empty so a channel with no messages does not round-trip for nothing.
 */
export function messageAttachmentsQuery(
  orgId: string,
  channelId: ChannelId,
  messageIds: readonly string[],
) {
  return queryOptions({
    queryKey: [...keys.messages(orgId, channelId), 'attachments', messageIds] as const,
    queryFn: async () =>
      wire(
        await api.chat.attachments.list.query({
          channelId,
          messageIds,
        }),
      ),
    enabled: messageIds.length > 0,
  });
}

export function messagePreviewsQuery(
  orgId: string,
  channelId: ChannelId,
  messageIds: readonly string[],
) {
  return queryOptions({
    queryKey: [...keys.messages(orgId, channelId), 'unfurls', messageIds] as const,
    queryFn: async () =>
      wire(
        await api.chat.unfurls.list.query({
          channelId,
          messageIds,
        }),
      ),
    enabled: messageIds.length > 0,
  });
}

/**
 * The three-step upload: presign, PUT to storage, confirm.
 *
 * Identical in shape to Work's `attachment-section.tsx`, and identical for a
 * reason — it is the same pipeline pointed at a channel (§3.10). Two properties
 * are worth not losing while reading it:
 *
 *   * The PUT does not go through our API. It is a signed URL to object storage,
 *     and `presigned.headers` are sent VERBATIM because they are the headers
 *     named in the signature. Altering or omitting one makes storage reject the
 *     upload, which is the control working.
 *   * A file is not uploaded until `confirm` says so. The PUT only means bytes
 *     reached storage; the verdict comes from reading them back, checking the
 *     magic bytes, and scanning them.
 */
export async function uploadMessageFile(
  messageId: MessageId,
  file: File,
  onProgress?: (stage: string) => void,
): Promise<{ status: 'clean' | 'infected' | 'rejected'; reason?: string }> {
  onProgress?.('Requesting an upload URL…');
  const presigned = await api.chat.attachments.presign.mutate({
    messageId,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  });

  onProgress?.('Uploading…');
  const response = await fetch(presigned.url, {
    method: 'PUT',
    headers: presigned.headers,
    body: file,
  });

  if (!response.ok) {
    throw new Error(
      `Storage refused the upload (${String(response.status)}). The file may not match the type or size that was signed.`,
    );
  }

  onProgress?.('Scanning…');
  return api.chat.attachments.confirm.mutate({ attachmentId: presigned.attachmentId });
}

/**
 * A short-lived download URL, minted after a fresh authorization check.
 *
 * Navigated to rather than fetched: the URL is single-use and short-lived, and
 * `Content-Disposition` carries the real filename — set by the server from the
 * database, because the storage key is server-generated and contains nothing a
 * client chose.
 */
export function downloadMessageFile(attachmentId: AttachmentId) {
  return api.chat.attachments.download.mutate({ attachmentId });
}

export function deleteMessageFile(attachmentId: AttachmentId) {
  return api.chat.attachments.delete.mutate({ attachmentId });
}

/* -------------------------------------------------------------------------- *
 * Wave 4 — retention, legal hold, guests, export
 * -------------------------------------------------------------------------- */

export function setRetention(input: { channelId: ChannelId; retentionDays: number | null }) {
  return api.chat.compliance.setRetention.mutate(input);
}

export function holdChannel(input: { channelId: ChannelId; held: boolean }) {
  return api.chat.compliance.holdChannel.mutate(input);
}

export function holdMessage(input: { messageId: MessageId; held: boolean }) {
  return api.chat.compliance.holdMessage.mutate(input);
}

export type ChannelGuestRow = Wire<
  Awaited<ReturnType<typeof api.chat.compliance.listGuests.query>>
>[number];

export function guestsQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: keys.channelGuests(orgId, channelId),
    queryFn: async () => wire(await api.chat.compliance.listGuests.query({ channelId })),
  });
}

export function setGuestAccess(input: {
  channelId: ChannelId;
  userId: UserId;
  granted: boolean;
  expiresAt: string | null;
}) {
  return api.chat.compliance.setGuest.mutate(input);
}

export function exportChannel(input: { channelId: ChannelId; includeDeleted: boolean }) {
  return api.chat.compliance.export.mutate(input);
}

/* -------------------------------------------------------------------------- *
 * Saved messages and notifications
 * -------------------------------------------------------------------------- */

export type SavedMessage = Wire<Awaited<ReturnType<typeof api.chat.saved.list.query>>>[number];
export type ChatNotification = Wire<
  Awaited<ReturnType<typeof api.chat.notifications.listMine.query>>
>[number];

export function savedQuery(orgId: string) {
  return queryOptions({
    queryKey: ['org', orgId, 'chat', 'saved'] as const,
    queryFn: async () => wire(await api.chat.saved.list.query()),
  });
}

export function saveMessage(messageId: MessageId) {
  return api.chat.saved.save.mutate({ messageId });
}

export function unsaveMessage(messageId: MessageId) {
  return api.chat.saved.unsave.mutate({ messageId });
}

/**
 * The notification list, and the badge count as its own query.
 *
 * Two queries rather than deriving the count from the list: the badge renders
 * on every page load and the list only when the bell is opened, so counting a
 * page of fifty would read every excerpt in order to throw them away.
 *
 * Polled, for the same reason unread counts are: a notification arrives from a
 * channel this tab has not joined, so there is no live signal to ride on.
 */
export function notificationsQuery(orgId: string) {
  return queryOptions({
    queryKey: ['org', orgId, 'chat', 'notifications'] as const,
    queryFn: async () => wire(await api.chat.notifications.listMine.query()),
    /* Without this, the badge above ticks up every 20s while the panel behind
       it — mounted once in the shell and never unmounted — kept showing
       whatever it fetched on first load until a window refocus happened to
       trigger a refetch. Matches the count query's interval so the two never
       visibly disagree. */
    refetchInterval: 20_000,
  });
}

export function notificationCountQuery(orgId: string) {
  return queryOptions({
    queryKey: ['org', orgId, 'chat', 'notifications', 'count'] as const,
    queryFn: () => api.chat.notifications.unreadCount.query(),
    refetchInterval: 20_000,
  });
}

export function markNotificationsRead() {
  return api.chat.notifications.markAllRead.mutate();
}

/** Marks the ONE notification just opened, without touching the rest of the bell. */
export function markNotificationRead(notificationId: string) {
  return api.chat.notifications.markRead.mutate({ notificationId });
}

export function invalidateSaved(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: ['org', orgId, 'chat', 'saved'] });
}

export function invalidateNotifications(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: ['org', orgId, 'chat', 'notifications'] });
}
