import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { useSession } from '../../lib/session.js';
import { useToast } from '../../lib/toast-context.js';
import { Button } from '../../components/primitives.js';
import { activeCallQuery, invalidateCalls } from './api.js';
import { joinCall, useCallStore } from './use-call.js';

/**
 * "Call" / "Join call", in a conversation's header.
 *
 * ## It re-derives no authorization
 *
 * The button renders for everyone and the server answers — §8.2, and the same
 * argument `telephony/call-button.tsx` makes. A `viewer` who cannot start a call
 * gets an honest refusal in a toast rather than a control that silently is not
 * there, and the two permissions involved (§3.8: `message:create` to start,
 * `channel:read` to join) are not reimplemented here in any form.
 *
 * ## Why one button and two verbs
 *
 * A live call in this conversation makes the action JOIN, not START — and the
 * server would refuse a second one anyway (`sessions_one_live_per_channel`). The
 * caption follows the server's own answer rather than a local guess, so the two
 * cannot disagree about whether a call is happening.
 */
export function CallButton({
  orgId,
  channelId,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const selfId = useSession((state) => state.userId);
  const active = useQuery({ ...activeCallQuery(orgId, channelId), enabled: orgId !== '' });
  const currentSessionId = useCallStore((state) => state.sessionId);

  const live = active.data;
  const alreadyIn = live?.sessionId === currentSessionId && currentSessionId !== null;

  const start = useMutation({
    mutationFn: async () => {
      if (selfId === null) throw new Error('Not signed in.');

      /* Start OR join, decided by what the server last said is live. A race
         with somebody else pressing call at the same instant lands on
         `sessions_one_live_per_channel`, which answers CONFLICT — reported in
         the toast below rather than papered over, because the right recovery
         is to press the button again and join theirs. */
      const sessionId =
        live?.sessionId ??
        (await api.rtc.start.mutate({ channelId, kind: 'audio' })).sessionId;

      await joinCall({ orgId, sessionId, channelId, selfId });
    },
    onSuccess: async () => {
      await invalidateCalls(queryClient, orgId, channelId);
    },
    onError: (error) => {
      toast.failure('The call could not be started', error);
    },
  });

  if (alreadyIn) {
    /* Nothing to press. The in-call bar in the app shell is where hanging up
       lives, so a second control here would be a second way to end a call that
       has to be kept in sync with it. */
    return <span className="shrink-0 text-xs text-ink-faint">In call</span>;
  }

  return (
    <Button
      size="sm"
      variant={live == null ? 'ghost' : 'primary'}
      disabled={start.isPending || selfId === null}
      title={live == null ? 'Start a voice call' : 'Join the call in progress'}
      onClick={() => {
        start.mutate();
      }}
    >
      {start.isPending ? 'Connecting…' : live == null ? '📞 Call' : '📞 Join call'}
    </Button>
  );
}
