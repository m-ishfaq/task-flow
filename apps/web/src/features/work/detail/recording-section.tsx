import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CardId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { useToast } from '../../../lib/toast-context.js';
import { Button, Empty, Section, SkeletonRows } from '../../../components/primitives.js';
import { ErrorText, ErrorView } from '../../../components/error-view.js';
import {
  callRecordingsQuery,
  callsQuery,
  cardRecordingsQuery,
  invalidateCardRecordings,
} from '../../telephony/api.js';

/**
 * Recordings attached to this card (ai/phase-7-voice.md §3.9, Wave 3).
 *
 * A plain FK, not a second upload pipeline — the recording already exists
 * (`comms.recordings`, ingested from a call), this just points a card at
 * one. `recording-card.service.ts` checks `recording:read` AND `card:read`/
 * `card:update` separately.
 *
 * `card-detail-panel.tsx` only mounts this component when
 * `capabilities.readRecordings` is true (Phase 15 §1's sweep) — `recording:
 * read` is Admin-and-Owner only by role, with no tuple and no member grant
 * that could turn it on for anyone else, and this section used to render
 * on every card regardless, landing a Member on a real FORBIDDEN the
 * moment they touched it. This component itself still does no
 * re-checking — it trusts the mount decision, and the route-level
 * `recording:read` gate still enforces the real permission regardless of
 * what the client decided.
 *
 * The picker is two steps — pick a recorded CALL, then pick its RECORDING —
 * because there is no "browse every recording org-wide" endpoint (only
 * per-call and per-card lists exist today, `router.ts`'s `recordings.list`
 * and `cards.recordings`), and building one is out of scope for wiring up
 * the UI this phase was otherwise missing entirely.
 */

export function RecordingSection({
  orgId,
  cardId,
}: {
  readonly orgId: string;
  readonly cardId: CardId;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const attached = useQuery(cardRecordingsQuery(orgId, cardId));
  const [picking, setPicking] = useState(false);

  const refresh = () => invalidateCardRecordings(queryClient, orgId, cardId);

  const detach = useMutation({
    mutationFn: (recordingId: string) => api.telephony.cards.detach.mutate({ recordingId, cardId }),
    onSuccess: refresh,
    onError: (error) => {
      toast.failure('The recording was not detached', error);
    },
  });

  const attach = useMutation({
    mutationFn: (recordingId: string) => api.telephony.cards.attach.mutate({ recordingId, cardId }),
    onSuccess: async () => {
      setPicking(false);
      await refresh();
    },
    onError: (error) => {
      toast.failure('The recording was not attached', error);
    },
  });

  return (
    <Section title="Recordings" count={attached.data?.length}>
      {attached.isPending ? (
        <SkeletonRows rows={1} />
      ) : attached.isError ? (
        <ErrorView error={attached.error} title="Could not load recordings" />
      ) : (
        <ul className="space-y-1">
          {attached.data.map((recording) => (
            <li
              key={recording.recordingId}
              className="flex items-center gap-2 rounded border border-line px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs text-ink">
                  {recording.status}
                  {recording.durationSeconds !== null && ` · ${String(recording.durationSeconds)}s`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                disabled={detach.isPending}
                onClick={() => {
                  detach.mutate(recording.recordingId);
                }}
              >
                Detach
              </Button>
            </li>
          ))}
        </ul>
      )}
      {detach.isError && <ErrorText error={detach.error} />}

      {picking ? (
        <RecordingPicker
          orgId={orgId}
          onAttach={(recordingId) => {
            attach.mutate(recordingId);
          }}
          onCancel={() => {
            setPicking(false);
          }}
          pending={attach.isPending}
        />
      ) : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPicking(true);
          }}
        >
          Attach a recording
        </Button>
      )}
      {attach.isError && <ErrorText error={attach.error} />}
    </Section>
  );
}

function RecordingPicker({
  orgId,
  onAttach,
  onCancel,
  pending,
}: {
  readonly orgId: string;
  readonly onAttach: (recordingId: string) => void;
  readonly onCancel: () => void;
  readonly pending: boolean;
}) {
  const calls = useQuery(callsQuery(orgId));
  const [callId, setCallId] = useState<string | null>(null);

  const recorded = (calls.data ?? []).filter((call) => call.recorded);

  return (
    <div className="mt-2 rounded border border-dashed border-line bg-surface-sunken/60 p-2">
      {calls.isPending ? (
        <SkeletonRows rows={2} />
      ) : recorded.length === 0 ? (
        <Empty title="No recorded calls" description="Record a call, then attach it here." />
      ) : callId === null ? (
        <ul className="space-y-1">
          {recorded.map((call) => (
            <li key={call.callId}>
              <button
                type="button"
                onClick={() => {
                  setCallId(call.callId);
                }}
                className="w-full rounded px-1.5 py-1 text-left text-xs text-ink hover:bg-surface-hover"
              >
                {String(call.counterparty)} · {call.direction}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <RecordingsOfCall
          orgId={orgId}
          callId={callId}
          onAttach={onAttach}
          onBack={() => {
            setCallId(null);
          }}
          pending={pending}
        />
      )}
      <Button size="sm" variant="ghost" className="mt-1" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function RecordingsOfCall({
  orgId,
  callId,
  onAttach,
  onBack,
  pending,
}: {
  readonly orgId: string;
  readonly callId: string;
  readonly onAttach: (recordingId: string) => void;
  readonly onBack: () => void;
  readonly pending: boolean;
}) {
  const recordings = useQuery(callRecordingsQuery(orgId, callId));

  if (recordings.isPending) return <SkeletonRows rows={1} />;
  if (recordings.isError) return <ErrorText error={recordings.error} />;

  const stored = recordings.data.filter((recording) => recording.status === 'stored');

  return (
    <div className="space-y-1">
      {stored.length === 0 ? (
        <p className="empty-fade text-xs text-ink-faint">Not stored yet — try again shortly.</p>
      ) : (
        stored.map((recording) => (
          <div key={recording.recordingId} className="flex items-center gap-2">
            <span className="text-xs text-ink-muted">
              {recording.durationSeconds !== null ? `${String(recording.durationSeconds)}s` : '—'}
            </span>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                onAttach(recording.recordingId);
              }}
            >
              Attach
            </Button>
          </div>
        ))
      )}
      <Button size="sm" variant="ghost" onClick={onBack}>
        Back
      </Button>
    </div>
  );
}
