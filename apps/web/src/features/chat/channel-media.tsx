import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChannelId, MessageId } from '@taskflow/contracts';
import { cn } from '../../lib/cn.js';
import { formatCallDuration, formatRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import { Button, Empty, Skeleton } from '../../components/primitives.js';
import { useMembers, type Person } from '../org/use-members.js';
import { MessageAttachments } from './message-extras.js';
import {
  channelFilesQuery,
  invalidateAllPins,
  invalidatePins,
  invalidateSaved,
  pinsQuery,
  savedQuery,
  unpinMessage,
  unsaveMessage,
  type PinnedMessageRow,
  type SavedMessage,
} from './api.js';
import {
  callHistoryQuery,
  channelRecordingsQuery,
  downloadRecording,
  type CallHistoryEntry,
  type CallRecordingSummary,
} from '../rtc/api.js';

/**
 * The "just like WhatsApp" group-info surfaces: what has been called, what has
 * been pinned, what THIS person has starred, and what has been shared —
 * everything the details panel did not carry through Wave 4.
 *
 * Split out of `channel-details.tsx` because that file is already the
 * roster/settings/compliance surface; a fourth read-only concern belongs in
 * its own module rather than growing the one file further.
 */

/* -------------------------------------------------------------------------- *
 * Calls — history, per-call roster, and the recording listen/download link
 * -------------------------------------------------------------------------- */

/** What a call kind and an end reason turn into, from the SESSION's own point
    of view — the same line for everyone looking at the panel, not per-viewer
    the way the message timeline's "missed" wording is (that one differs by
    who is reading it; this list is a record, not a notification). */
export function callStatusLabel(entry: CallHistoryEntry): string {
  if (entry.status === 'ringing') return 'Ringing…';
  if (entry.status === 'active') return 'In progress';

  switch (entry.endReason) {
    case 'declined':
      return 'Declined';
    case 'no_answer':
      return 'No answer';
    case 'org_suspended':
      return 'Ended — organization suspended';
    case 'hung_up':
    case 'empty':
    case null:
    default:
      if (entry.startedAt !== null && entry.endedAt !== null) {
        const seconds =
          (new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000;
        return formatCallDuration(seconds);
      }
      return 'No answer';
  }
}

/**
 * The same fact as `callStatusLabel`, restated PER VIEWER — the message
 * timeline's call card, WhatsApp-style. "Missed" is not a property of the
 * call, it is a property of who is reading about it: the person who placed
 * it sees "No answer", the person it rang for and who never picked up sees
 * "Missed call", and someone who joined a group call late sees neither.
 */
export function callTimelineLabel(
  entry: CallHistoryEntry,
  viewerId: string | null,
): { readonly text: string; readonly missed: boolean } {
  if (entry.status === 'ringing') return { text: 'Ringing…', missed: false };
  if (entry.status === 'active') return { text: 'In progress', missed: false };

  const own = entry.participants.find((participant) => participant.userId === viewerId);

  if (own?.state === 'missed') {
    return { text: `Missed ${entry.kind === 'video' ? 'video' : 'voice'} call`, missed: true };
  }
  if (own?.state === 'declined') {
    return { text: 'You declined this call', missed: false };
  }

  return { text: callStatusLabel(entry), missed: false };
}

/**
 * "Voice call · 3m 12s" / "Missed voice call" — a call event inline in the
 * message timeline, the same place WhatsApp puts one and for the same
 * reason: it happened at a point in the conversation, between two messages,
 * not off to the side in a details panel only.
 *
 * A parallel resource merged into the render by timestamp, never a
 * `chat.messages` row — the same shape Phase 7's SMS/WhatsApp threads take
 * relative to `chat.channels` (ai/phase-7-voice.md §3.8): a system-authored
 * chat message would need a schema change (a `kind` column, read-cursor and
 * unread-count implications for a row nobody actually sent) for a fact this
 * file already has a place to read from.
 */
export function CallTimelineCard({
  entry,
  viewerId,
  personOf,
}: {
  readonly entry: CallHistoryEntry;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => Person;
}) {
  const { text, missed } = callTimelineLabel(entry, viewerId);
  const initiator = personOf(entry.initiatedBy);
  const byViewer = entry.initiatedBy === viewerId;

  return (
    <div className="flex justify-center py-0.5">
      <div
        className={cn(
          'flex items-center gap-1.5 rounded-full px-3 py-1 text-xs',
          missed ? 'bg-danger/10 text-danger' : 'bg-surface-sunken text-ink-muted',
        )}
      >
        <span aria-hidden="true">{entry.kind === 'video' ? '🎥' : '📞'}</span>
        <span>
          {byViewer ? 'You called' : `${initiator.label} called`} · {text}
        </span>
      </div>
    </div>
  );
}

function CallRow({
  entry,
  recordings,
  personOf,
}: {
  readonly entry: CallHistoryEntry;
  readonly recordings: readonly CallRecordingSummary[];
  readonly personOf: (userId: string) => Person;
}) {
  const [expanded, setExpanded] = useState(false);
  const initiator = personOf(entry.initiatedBy);
  const recording = recordings.find(
    (row) => row.sessionId === entry.sessionId && row.status === 'stored',
  );

  return (
    <li className="rounded border border-line px-2 py-1.5">
      <button
        type="button"
        onClick={() => {
          setExpanded((current) => !current);
        }}
        className="flex w-full items-center gap-2 text-left"
      >
        <span aria-hidden="true">{entry.kind === 'video' ? '🎥' : '📞'}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-ink">{initiator.label}</p>
          <p className="text-[11px] text-ink-faint">
            {formatRelative(entry.createdAt)} · {callStatusLabel(entry)}
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-ink-faint" aria-hidden="true">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="mt-1.5 flex flex-col gap-1.5 border-t border-line pt-1.5">
          <ul className="flex flex-col gap-0.5">
            {entry.participants.map((participant) => (
              <li
                key={participant.userId}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="truncate text-ink-muted">
                  {personOf(participant.userId).label}
                </span>
                <span className="shrink-0 text-ink-faint">
                  {participant.state === 'joined' && participant.joinedAt !== null
                    ? `Joined ${formatRelative(participant.joinedAt)}`
                    : participant.state === 'left' &&
                        participant.joinedAt !== null &&
                        participant.leftAt !== null
                      ? formatCallDuration(
                          (new Date(participant.leftAt).getTime() -
                            new Date(participant.joinedAt).getTime()) /
                            1000,
                        )
                      : participant.state === 'declined'
                        ? 'Declined'
                        : participant.state === 'missed'
                          ? 'Missed'
                          : 'Invited'}
                </span>
              </li>
            ))}
          </ul>

          {recording !== undefined && <RecordingRow recording={recording} />}
        </div>
      )}
    </li>
  );
}

/** Listen and download for one stored recording (§3.9's own deferred
    question, closed here: how an attendee actually gets the file). */
function RecordingRow({ recording }: { readonly recording: CallRecordingSummary }) {
  const toast = useToast();
  const [playUrl, setPlayUrl] = useState<string | null>(null);

  const play = useMutation({
    mutationFn: () => downloadRecording(recording.recordingId),
    onSuccess: (result) => {
      setPlayUrl(result.url);
    },
    onError: (error) => {
      toast.failure('The recording could not be opened', error);
    },
  });

  const download = useMutation({
    mutationFn: () => downloadRecording(recording.recordingId),
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
    onError: (error) => {
      toast.failure('The recording could not be downloaded', error);
    },
  });

  return (
    <div className="flex flex-col gap-1 rounded bg-surface-raised px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span aria-hidden="true">⏺</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
          Recording
          {recording.durationSeconds !== null &&
            ` · ${formatCallDuration(recording.durationSeconds)}`}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 shrink-0 px-1 text-[11px]"
          disabled={play.isPending}
          onClick={() => {
            play.mutate();
          }}
        >
          ▶ Listen
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 shrink-0 px-1 text-[11px]"
          disabled={download.isPending}
          onClick={() => {
            download.mutate();
          }}
        >
          ⬇
        </Button>
      </div>
      {/* Fetched on demand rather than eagerly for every stored recording in
          the panel — a presigned URL mints a capability and is audited
          (§4's `rtc_recording.downloaded`), so this only happens when
          somebody actually asks to hear it. */}
      {playUrl !== null && <audio controls src={playUrl} className="h-8 w-full" />}
    </div>
  );
}

export function CallsSection({
  orgId,
  channelId,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
}) {
  const { personOf } = useMembers();
  const history = useQuery(callHistoryQuery(orgId, channelId));
  const recordings = useQuery(channelRecordingsQuery(orgId, channelId));

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-xs font-semibold text-ink-muted">Calls</h3>

      {history.isLoading ? (
        <Skeleton className="h-8 w-full" />
      ) : (history.data ?? []).length === 0 ? (
        <p className="text-xs text-ink-faint">No calls in this conversation yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {(history.data ?? []).map((entry) => (
            <CallRow
              key={entry.sessionId}
              entry={entry}
              recordings={recordings.data ?? []}
              personOf={personOf}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Pinned — everyone's pins, in this one channel
 * -------------------------------------------------------------------------- */

function ExcerptRow({
  excerpt,
  meta,
  action,
}: {
  readonly excerpt: string | null;
  readonly meta: string;
  readonly action: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 rounded border border-line px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-xs text-ink">
          {excerpt ?? <span className="italic text-ink-faint">Message deleted</span>}
        </p>
        <p className="text-[11px] text-ink-faint">{meta}</p>
      </div>
      {action}
    </li>
  );
}

export function PinnedSection({
  orgId,
  channelId,
  personOf,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly personOf: (userId: string) => Person;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const pins = useQuery(pinsQuery(orgId, channelId));

  const unpin = useMutation({
    mutationFn: (messageId: MessageId) => unpinMessage({ channelId, messageId }),
    onSuccess: () => {
      invalidatePins(queryClient, orgId, channelId);
      invalidateAllPins(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('That could not be unpinned', error);
    },
  });

  const rows: readonly PinnedMessageRow[] = pins.data ?? [];

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-xs font-semibold text-ink-muted">Pinned · {rows.length}</h3>

      {rows.length === 0 ? (
        <p className="text-xs text-ink-faint">Nothing pinned in this conversation.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <ExcerptRow
              key={row.messageId}
              excerpt={row.excerpt}
              meta={`Pinned by ${row.pinnedBy === null ? 'someone who has left' : personOf(row.pinnedBy).label} · ${formatRelative(row.pinnedAt)}`}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 shrink-0 px-1 text-[11px]"
                  disabled={unpin.isPending}
                  onClick={() => {
                    unpin.mutate(row.messageId as MessageId);
                  }}
                >
                  Unpin
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Saved (starred) — THIS person's own bookmarks, filtered to this channel
 * -------------------------------------------------------------------------- */

export function SavedSection({
  orgId,
  channelId,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  /* `chat.saved.list` is org-wide (§: a save is personal, and the sidebar's
     own "Saved" surface already reads it unfiltered) — filtered here to this
     one conversation rather than adding a second, channel-scoped route for a
     query that is already cheap and already cached. */
  const saved = useQuery({ ...savedQuery(orgId), enabled: orgId !== '' });
  const inThisChannel: readonly SavedMessage[] = (saved.data ?? []).filter(
    (row) => row.channelId === channelId,
  );

  const unsave = useMutation({
    mutationFn: (messageId: MessageId) => unsaveMessage(messageId),
    onSuccess: () => {
      invalidateSaved(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('That could not be unstarred', error);
    },
  });

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-xs font-semibold text-ink-muted">
        Starred by you · {inThisChannel.length}
      </h3>

      {inThisChannel.length === 0 ? (
        <p className="text-xs text-ink-faint">
          Star a message in this conversation to keep it for later.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {inThisChannel.map((row) => (
            <ExcerptRow
              key={row.messageId}
              excerpt={row.excerpt}
              meta={`Starred ${formatRelative(row.savedAt)}`}
              action={
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 shrink-0 px-1 text-[11px]"
                  disabled={unsave.isPending}
                  onClick={() => {
                    unsave.mutate(row.messageId as MessageId);
                  }}
                >
                  ★
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Files — every live attachment this conversation has ever held
 * -------------------------------------------------------------------------- */

export function FilesSection({
  orgId,
  channelId,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
}) {
  const files = useQuery(channelFilesQuery(orgId, channelId));

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="text-xs font-semibold text-ink-muted">Files · {(files.data ?? []).length}</h3>

      {files.isLoading ? (
        <Skeleton className="h-8 w-full" />
      ) : (files.data ?? []).length === 0 ? (
        <Empty title="No files yet" description="Files shared in this conversation appear here." />
      ) : (
        <MessageAttachments attachments={files.data ?? []} />
      )}
    </section>
  );
}
