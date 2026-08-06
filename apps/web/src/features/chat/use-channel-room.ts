import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChannelId } from '@taskflow/contracts';
import {
  joinChannelRoom,
  leaveChannelRoom,
  onChannelClosed,
  onChatBroadcast,
  onChatReconnect,
  type ChatBroadcastMessage,
} from '../../lib/chat-socket.js';
import {
  invalidateChannels,
  invalidateMessages,
  invalidatePins,
  invalidateReactions,
  invalidateUnreadCounts,
} from './api.js';

/**
 * Mounted from `chat-page.tsx` while a channel is open (ai/phase-5-chat.md
 * §3.1, §3.4, §5 Wave 1).
 *
 * ## Why every broadcast invalidates rather than patches
 *
 * `use-board-room.ts` patches `card.moved` and similar events in place because
 * `CardSummary` already carries the field the payload changed. Chat's own
 * events (`events.ts`) deliberately do NOT carry enough to patch with:
 * `message.sent`/`message.edited` carry an `excerpt`, not the full TipTap body,
 * and neither carries `authorId` at all — both because a notification
 * consumer needs a flattened string, never the document, and the outbox row a
 * broadcast is built from is not the place to duplicate what `messages.list`
 * already returns in full. Patching with what the payload has would render a
 * message with no author line, which is worse than the one extra round trip an
 * invalidate costs.
 *
 * `message.deleted`/`channel.member_added`/`channel.member_removed` follow the
 * same reasoning as Work's structural events (`list.created` etc.): low
 * enough frequency, per channel, that a refetch is the whole cost.
 */
export function useChannelRoom(orgId: string, channelId: ChannelId): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (orgId === '') return undefined;

    void joinChannelRoom(orgId, channelId);

    const offBroadcast = onChatBroadcast((message) => {
      if (message.channelId !== channelId) return;
      applyBroadcast(message, {
        invalidateThisChannel: () => {
          invalidateMessages(queryClient, orgId, channelId);
        },
        invalidateChannelList: () => {
          invalidateChannels(queryClient, orgId);
        },
        invalidateReactions: () => {
          invalidateReactions(queryClient, orgId, channelId);
        },
        invalidatePins: () => {
          invalidatePins(queryClient, orgId, channelId);
        },
        invalidateUnread: () => {
          invalidateUnreadCounts(queryClient, orgId);
        },
      });
    });

    const offClosed = onChannelClosed((message) => {
      if (message.channelId !== channelId) return;
      // Access to this channel just ended (removed, or the channel archived) —
      // same terminal handling as `use-board-room.ts`'s `room:closed`: nothing
      // live to rejoin, so refetch what a hard refresh would have shown.
      invalidateChannels(queryClient, orgId);
      invalidateMessages(queryClient, orgId, channelId);
    });

    const offReconnect = onChatReconnect(() => {
      invalidateMessages(queryClient, orgId, channelId);
      invalidateChannels(queryClient, orgId);
    });

    return () => {
      offBroadcast();
      offClosed();
      offReconnect();
      leaveChannelRoom(channelId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryClient is stable for the app's lifetime
  }, [orgId, channelId]);
}

function applyBroadcast(
  message: ChatBroadcastMessage,
  actions: {
    readonly invalidateThisChannel: () => void;
    readonly invalidateChannelList: () => void;
    readonly invalidateReactions: () => void;
    readonly invalidatePins: () => void;
    readonly invalidateUnread: () => void;
  },
): void {
  switch (message.name) {
    case 'message.sent':
      actions.invalidateThisChannel();
      actions.invalidateUnread();
      return;

    case 'message.edited':
    case 'message.deleted':
      actions.invalidateThisChannel();
      return;

    /* Link previews and files both arrive AFTER the message they belong to,
       and both were silently dropped here before: they fell through to
       `default` and nothing refetched. The preview sat in the database and the
       file was visible only to whoever uploaded it, whose own client had
       invalidated locally — so a file shared into a channel was invisible to
       the channel until somebody reloaded.

       `invalidateThisChannel` covers both: the attachment and unfurl queries
       are keyed as extensions of `keys.messages`, so react-query's prefix match
       already reaches them without a second invalidation call. */
    case 'message.unfurled':
    case 'message.attachments_changed':
      actions.invalidateThisChannel();
      return;

    case 'channel.member_added':
    case 'channel.member_removed':
    case 'channel.updated':
    case 'channel.archived':
      // Membership and metadata changes affect the channel LIST (a rename, an
      // archive, someone else joining) as well as this channel's own detail —
      // both are cheap, infrequent reads.
      actions.invalidateChannelList();
      actions.invalidateThisChannel();
      return;

    case 'message.reaction_added':
    case 'message.reaction_removed':
      actions.invalidateReactions();
      return;

    case 'message.pinned':
    case 'message.unpinned':
      actions.invalidatePins();
      return;

    default:
      return;
  }
}

export type { ChatBroadcastMessage };
