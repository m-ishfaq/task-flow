import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ChannelId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { Empty } from '../../components/primitives.js';
import { ChannelListPanel } from './chat-sidebar.js';
import { ChannelPanel } from './channel-panel.js';

export { firstUnreadAfter } from './chat-helpers.js';

/**
 * Channels and direct messages (ai/phase-5-chat.md §5 Wave 1).
 *
 * Two panels, neither of which re-derives authorization (CLAUDE.md, §8.2):
 * `channels.list` already omits everything the caller cannot open, so the list
 * on the left needs no visibility logic of its own, and every mutation here
 * — send, edit, delete, create — is offered to whoever can reach the button
 * and answered honestly by the server if they cannot.
 *
 * The selected channel lives in the URL (`?channel=`), the same reasoning
 * `board-page.tsx` gives for keeping `card` there: it is what makes a
 * conversation a shareable link and what survives a reload.
 */
export function ChatPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const search = useSearch({ from: '/chat', select: (value) => value.channel });

  const selectChannel = (channelId: ChannelId | undefined) => {
    void navigate({ to: '/chat', search: { channel: channelId } });
  };

  /* Below `md`, a list and its detail can't share a phone-width screen —
     this is the same list/detail split Mail apps use, driven entirely by
     `search.channel` (the URL) rather than a separate "which pane is active"
     piece of state, so there is only ever one source of truth for what's on
     screen. At `md` and above both panes are always visible side by side,
     unchanged from before this wave. */
  return (
    <div className="flex h-full min-h-0">
      <ChannelListPanel
        orgId={orgId}
        selected={search ?? null}
        onSelect={selectChannel}
        hideWhenChannelOpen={search !== undefined}
      />

      <div
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col md:flex',
          search === undefined ? 'hidden md:flex' : 'flex',
        )}
      >
        {search === undefined ? (
          <Empty
            title="No conversation open"
            description="Pick a channel or direct message on the left, or start a new one."
          />
        ) : (
          <ChannelPanel
            key={search}
            orgId={orgId}
            channelId={search}
            onBack={() => {
              selectChannel(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}
