import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ChannelId } from '@taskflow/contracts';
import { chatSocket } from './app-session.js';
import type { ChatBroadcastMessage } from './chat-socket.js';
import {
  CHANNELS_QUERY_KEY,
  messagesQueryKey,
  pinsQueryKey,
  reactionsQueryKey,
  TYPING_TIMEOUT_MS,
} from './chat.js';

/**
 * Mounted from `channel/[channelId].tsx` while a channel is open — the
 * mobile counterpart of `apps/web/src/features/chat/use-channel-room.ts`,
 * joining the `/chat` namespace's room over `chat-socket.ts`'s singleton
 * `chatSocket` (`app-session.ts`) rather than an injected one, matching how
 * that screen already imports `apiClient` directly from the same module.
 *
 * ## Why every broadcast invalidates rather than patches
 *
 * Same reasoning as web's own header: `message.sent`/`message.edited` carry
 * only an excerpt, never the full TipTap body or an `authorId`, so patching
 * with what the payload has would render a message with no author line —
 * worse than the one extra round trip an invalidate costs.
 *
 * ## What this closes that the screen did not have before
 *
 * Until now `channel/[channelId].tsx` only refetched on a LOCAL mutation's
 * own `onSuccess` — nothing here joined a room, so a message someone else
 * sent, an edit, a reaction, a pin, or a membership change never appeared
 * without a manual pull-to-refresh. Joining the room this hook adds live
 * updates for all of that as a direct consequence of the connection typing
 * indicators need anyway (typing is itself only delivered to sockets that
 * hold the room's join) — not a separate feature bolted on.
 */
export function useChatRoom(
  orgId: string | null,
  channelId: ChannelId,
  viewerId: string | null,
): { readonly typingUserIds: readonly string[] } {
  const queryClient = useQueryClient();
  const [typingUserIds, setTypingUserIds] = useState<readonly string[]>([]);

  useEffect(() => {
    // The effect re-runs on every channel switch (dependency below), and a
    // stale typing list from the PREVIOUS channel must not survive into the
    // new one for even one frame.
    setTypingUserIds([]);

    if (orgId === null) return undefined;

    void chatSocket.joinChannelRoom(orgId, channelId);

    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const offTyping = chatSocket.onTyping((message) => {
      if (message.channelId !== channelId || message.userId === viewerId) return;

      const existing = timers.get(message.userId);
      if (existing !== undefined) clearTimeout(existing);

      if (!message.typing) {
        timers.delete(message.userId);
        setTypingUserIds((current) => current.filter((userId) => userId !== message.userId));
        return;
      }

      setTypingUserIds((current) =>
        current.includes(message.userId) ? current : [...current, message.userId],
      );
      timers.set(
        message.userId,
        setTimeout(() => {
          timers.delete(message.userId);
          setTypingUserIds((current) => current.filter((userId) => userId !== message.userId));
        }, TYPING_TIMEOUT_MS),
      );
    });

    const offBroadcast = chatSocket.onBroadcast((message) => {
      if (message.channelId !== channelId) return;
      applyBroadcast(message, queryClient, channelId);
    });

    const offClosed = chatSocket.onChannelClosed((message) => {
      if (message.channelId !== channelId) return;
      // Access to this channel just ended (removed, or the channel
      // archived) — same terminal handling as web's own `channel:closed`:
      // nothing live to rejoin, so refetch what a hard refresh would show.
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
    });

    const offReconnect = chatSocket.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
    });

    return () => {
      offTyping();
      offBroadcast();
      offClosed();
      offReconnect();
      for (const timer of timers.values()) clearTimeout(timer);
      chatSocket.leaveChannelRoom(channelId);
    };
    // `queryClient` is stable for the app's lifetime and deliberately not
    // listed — `apps/mobile`'s ESLint config carries no `react-hooks/
    // exhaustive-deps` rule to satisfy in the first place (unlike apps/web).
  }, [orgId, channelId, viewerId]);

  return { typingUserIds };
}

function applyBroadcast(
  message: ChatBroadcastMessage,
  queryClient: QueryClient,
  channelId: ChannelId,
): void {
  switch (message.name) {
    case 'message.sent':
      void queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
      // The bare prefix, not `unreadCountsQueryKey(someArray)` — same
      // reasoning as the screen's own `markRead` handler: a shorter key
      // invalidates every longer one TanStack Query has cached under it.
      void queryClient.invalidateQueries({ queryKey: ['chat.channels.unreadCounts'] });
      return;

    case 'message.edited':
    case 'message.deleted':
    case 'message.unfurled':
    case 'message.attachments_changed':
      void queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
      return;

    case 'channel.member_added':
    case 'channel.member_removed':
    case 'channel.updated':
    case 'channel.archived':
      void queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
      return;

    case 'message.reaction_added':
    case 'message.reaction_removed':
      void queryClient.invalidateQueries({ queryKey: reactionsQueryKey(channelId) });
      return;

    case 'message.pinned':
    case 'message.unpinned':
      void queryClient.invalidateQueries({ queryKey: pinsQueryKey(channelId) });
      return;

    default:
      return;
  }
}
