import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Chat (Wave 3, `ai/phase-14-mobile.md` roadmap row: "Chat + push — channels,
 * DMs, threads, mentions; FCM/APNs..."). This slice is READ + SEND only —
 * no reactions, no thread replies UI, no mentions autocomplete, no push —
 * the same "smallest useful cut" call `work.ts`'s own Wave 2 sections made,
 * applied to a second domain now that the pattern (derive types off the
 * live client, share a `RichTextView`/`plainParagraph` composer with Work's
 * own comments) already exists to reuse rather than reinvent.
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

export const CHANNELS_QUERY_KEY = ['chat.channels.list'] as const;

export function messagesQueryKey(channelId: string): readonly ['chat.messages.list', string] {
  return ['chat.messages.list', channelId];
}

/**
 * A channel's display name — `apps/web`'s DM display resolves the OTHER
 * participant's name via a member-profile lookup this slice does not build
 * (real, separate work: a name-resolution join no other native screen
 * needs yet). A DM/group DM shows a plain, honest placeholder instead of a
 * wrong or missing name.
 */
export function channelDisplayName(channel: Channel): string {
  if (channel.name !== null) return channel.name;
  return channel.type === 'group_dm'
    ? `Direct message (${String(channel.participantIds.length)} people)`
    : 'Direct message';
}
