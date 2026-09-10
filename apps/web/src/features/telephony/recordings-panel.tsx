import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CardId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import { Button, Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { formatRelative } from '../../lib/format.js';
import { CardQuickView } from '../work/card-quick-view.js';
import { orgRecordingsPage, type OrgRecording } from './api.js';

/**
 * Every stored recording, org-wide (`recording:read` — Admin-and-Owner).
 *
 * The gap this closes: `CallsPanel`'s own recordings list needs a `callId`
 * in hand, and a card's own Recordings section needs a `cardId` — neither
 * lets an admin reviewing compliance simply browse what the org has
 * recorded. This is the third list over the same table, org-wide instead
 * of scoped to either parent — see `recording.service.ts`'s
 * `listOrgRecordings` for why the counterparty is decrypted here exactly as
 * the call log does it.
 *
 * Cursor-paginated on `createdAt`, the same `useInfiniteQuery` shape
 * `people-page.tsx` already established for a cursor list — pages
 * accumulate in the cache, "Load more" appends without re-fetching what is
 * already shown.
 */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: 'Pending',
  scanning: 'Processing',
  stored: 'Stored',
  infected: 'Infected',
  rejected: 'Rejected',
};

function StatusPill({ status }: { readonly status: string }) {
  const tone =
    status === 'stored'
      ? 'bg-success/15 text-success'
      : status === 'infected' || status === 'rejected'
        ? 'bg-danger/15 text-danger'
        : 'bg-surface-hover text-ink-muted';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone,
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(rest).padStart(2, '0')}s` : `${String(rest)}s`;
}

export function RecordingsPanel({ orgId }: { readonly orgId: string }) {
  const toast = useToast();
  const { guard, dialog } = useStepUp();
  const queryClient = useQueryClient();
  const [openCardId, setOpenCardId] = useState<CardId | null>(null);

  const recordings = useInfiniteQuery({
    queryKey: keys.orgRecordings(orgId),
    queryFn: ({ pageParam }) => orgRecordingsPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextBefore,
    enabled: orgId !== '',
  });

  const download = useMutation({
    mutationFn: (recordingId: string) => api.telephony.recordings.download.mutate({ recordingId }),
    onSuccess: (result) => {
      /* Single-use, short-lived, and never fetched from here — the same
         navigate-away pattern `CallRecordings` and `attachment-section.tsx`
         both already use for a presigned URL. */
      window.location.assign(result.url);
    },
    onError: (error, recordingId) => {
      if (
        guard(error, () => {
          download.mutate(recordingId);
        })
      ) {
        return;
      }
      toast.failure('The recording could not be opened', error);
    },
  });

  if (recordings.isPending) return <SkeletonRows rows={6} />;
  if (recordings.isError) {
    return <ErrorView error={recordings.error} title="Could not load recordings" />;
  }

  const rows = recordings.data.pages.flatMap((page) => page.recordings);

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <Empty
          title="No recordings yet"
          description="Recorded calls will appear here once stored."
        />
      ) : (
        <ul className="divide-y divide-line/40 overflow-hidden rounded-xl border border-line/50 bg-surface-raised/50">
          {rows.map((recording) => (
            <RecordingRow
              key={recording.recordingId}
              recording={recording}
              downloading={download.isPending}
              onDownload={() => {
                download.mutate(recording.recordingId);
              }}
              onOpenCard={(cardId) => {
                setOpenCardId(cardId);
              }}
            />
          ))}
        </ul>
      )}

      {download.isError && <ErrorText error={download.error} />}

      {recordings.hasNextPage && (
        <div className="flex justify-center">
          <Button
            size="sm"
            disabled={recordings.isFetchingNextPage}
            onClick={() => {
              void recordings.fetchNextPage();
            }}
          >
            {recordings.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      {dialog}

      {openCardId !== null && (
        <CardQuickView
          orgId={orgId}
          cardId={openCardId}
          onClose={() => {
            setOpenCardId(null);
            /* The card panel can attach/detach this very recording (Work's
               own Recordings section) — refetching is what would show a
               changed attachment on this list without a reload. */
            void queryClient.invalidateQueries({ queryKey: keys.orgRecordings(orgId) });
          }}
        />
      )}
    </div>
  );
}

function RecordingRow({
  recording,
  downloading,
  onDownload,
  onOpenCard,
}: {
  readonly recording: OrgRecording;
  readonly downloading: boolean;
  readonly onDownload: () => void;
  readonly onOpenCard: (cardId: CardId) => void;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-ink">{String(recording.counterparty)}</span>
          <span className="text-xs text-ink-muted">
            {recording.direction === 'inbound' ? 'Inbound' : 'Outbound'}
          </span>
          <StatusPill status={recording.status} />
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-faint">
          <span>{formatRelative(recording.createdAt)}</span>
          {recording.durationSeconds !== null && (
            <span>· {durationLabel(recording.durationSeconds)}</span>
          )}
          {recording.attachedCardIds.length > 0 && (
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => {
                const first = recording.attachedCardIds[0];
                if (first !== undefined) onOpenCard(first as CardId);
              }}
            >
              {recording.attachedCardIds.length === 1
                ? 'Attached to a card'
                : `Attached to ${String(recording.attachedCardIds.length)} cards`}
            </button>
          )}
        </div>
      </div>

      {recording.status === 'stored' && (
        <Button size="sm" variant="ghost" disabled={downloading} onClick={onDownload}>
          Download
        </Button>
      )}
    </li>
  );
}
