import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '../../lib/trpc.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import { Button, Empty, Field, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { cn } from '../../lib/cn.js';
import { formatRelative } from '../../lib/format.js';
import {
  callRecordingsQuery,
  callTranscriptQuery,
  callsQuery,
  invalidateAfterSpend,
  phoneNumbersQuery,
} from './api.js';
import { CallButton } from './call-button.js';
import { ContactPicker } from './contact-picker.js';

/**
 * Click-to-call and the call log (ai/phase-7-voice.md §3.5, §3.10, Wave 2).
 *
 * `record` is unchecked by default in the form, matching `router.ts`'s own
 * default and the reasoning stated there: recording by default with an
 * opt-out means forgetting a checkbox is an unlawfully recorded call.
 */

const STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: 'Queued',
  ringing: 'Ringing',
  in_progress: 'In progress',
  completed: 'Completed',
  busy: 'Busy',
  no_answer: 'No answer',
  failed: 'Failed',
  canceled: 'Canceled',
};

/** A coloured pill per carrier status — colour drives recognition, never meaning. */
function StatusPill({ status }: { readonly status: string }) {
  const tone =
    status === 'in_progress'
      ? 'bg-accent/15 text-accent'
      : status === 'completed'
        ? 'bg-success/15 text-success'
        : status === 'failed' || status === 'canceled'
          ? 'bg-danger/15 text-danger'
          : status === 'busy' || status === 'no_answer'
            ? 'bg-warning/15 text-warning'
            : 'bg-surface-hover text-ink-muted';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
        tone,
      )}
    >
      {STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

/* Total, not `number | null -> string | null`. Both call sites already guard on
   a null duration to decide whether to render the element at all, and a
   nullable return made the second one interpolate `null` into a template
   literal — the label read " · null" for a recording still being processed. */
function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(rest).padStart(2, '0')}s` : `${String(rest)}s`;
}

export function CallsPanel({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const numbers = useQuery(phoneNumbersQuery(orgId));
  const calls = useQuery(callsQuery(orgId));

  const [to, setTo] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const [record, setRecord] = useState(false);
  /* `?call=` opens one row expanded — how a transcript search hit lands here
     (Phase 8 Wave 3). Seeded into state rather than read directly on every
     render, because the row must stay collapsible afterward: deriving
     `expanded` from the URL would make the collapse chevron do nothing while
     the param is still in the address bar. The effect re-applies it when the
     param CHANGES, which is the navigate-onto-an-already-mounted-page case. */
  const linkedCallId = useSearch({ from: '/calls', select: (value) => value.call });
  const [expanded, setExpanded] = useState<string | null>(linkedCallId ?? null);

  /* Adjusted DURING RENDER, not in an effect — React's own documented pattern
     for "a piece of state derives from a prop but stays independently
     editable", and the one the repo's lint enforces (setState inside an effect
     body triggers a cascading render). React re-runs this component
     immediately with the new state and renders nothing in between. */
  const [seenLink, setSeenLink] = useState(linkedCallId);
  if (linkedCallId !== seenLink) {
    setSeenLink(linkedCallId);
    if (linkedCallId !== undefined) setExpanded(linkedCallId);
  }

  const place = useMutation({
    mutationFn: () =>
      api.telephony.calls.place.mutate({
        to: to.trim(),
        /* `activeNumber`, NOT the raw `fromPhoneNumberId` state.

           The state starts '' and only becomes a real id when the user CHANGES
           the dropdown. `activeNumber` is what the select renders and what the
           submit button's enabled check consults — so a caller who accepts the
           default sees a number selected, sees an enabled button, and submits
           an empty string, which the route refuses as `Invalid uuid`. The
           displayed value and the submitted value have to be the same value. */
        fromPhoneNumberId: activeNumber,
        record,
      }),
    onSuccess: async (result) => {
      setTo('');
      if (result.announcementRequired) {
        toast.show('Call placed', {
          description: 'A recording announcement will play before it starts.',
        });
      } else {
        toast.show('Call placed');
      }
      await invalidateAfterSpend(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('The call was not placed', error);
    },
  });

  const owned = numbers.data ?? [];
  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (owned[0]?.phoneNumberId ?? '');

  const goBuyNumber = () => {
    void navigate({ to: '/calls', search: { tab: 'numbers', thread: undefined } });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">
            Place a call
          </h2>
        </div>
        <form
          className="rounded-lg border border-line bg-surface-raised p-3"
          onSubmit={(event) => {
            event.preventDefault();
            place.mutate();
          }}
        >
          {/* `items-start`, not `items-end` — "To" has a hint and "From" does
              not, so bottom-aligning would sit the From select, the Record
              checkbox and the Call button a line below the To input. See
              `Field`'s own note. */}
          <div className="flex flex-wrap items-start gap-2">
            {/* A person OR a raw number — see `contact-picker.tsx` on why the
                free-text field stays primary rather than becoming the fallback
                behind a select. */}
            <Field label="To" htmlFor="call-to" hint="Pick a person, or type E.164">
              <ContactPicker id="call-to" orgId={orgId} value={to} onChange={setTo} />
            </Field>

            <Field label="From" htmlFor="call-from">
              <select
                id="call-from"
                value={activeNumber}
                disabled={owned.length === 0}
                onChange={(event) => {
                  setFromPhoneNumberId(event.target.value);
                }}
                className="h-9 min-w-36 rounded border border-line bg-surface-sunken px-2 text-sm text-ink focus:border-accent focus:outline-none disabled:opacity-50"
              >
                {owned.length === 0 && <option value="">No numbers yet</option>}
                {owned.map((number) => (
                  <option key={number.phoneNumberId} value={number.phoneNumberId}>
                    {String(number.e164)}
                  </option>
                ))}
              </select>
            </Field>

            <label className="mt-5 flex h-9 cursor-pointer items-center gap-1.5 text-xs text-ink-muted select-none">
              <input
                type="checkbox"
                checked={record}
                onChange={(event) => {
                  setRecord(event.target.checked);
                }}
                className="size-3.5 accent-accent"
              />
              Record
            </label>

            <Button
              type="submit"
              variant="primary"
              className="mt-5"
              disabled={place.isPending || activeNumber === '' || to.trim() === ''}
            >
              {place.isPending ? 'Calling…' : 'Call'}
            </Button>
          </div>

          {/* Gated on `!numbers.isPending` so the initial load doesn't flash a
              false "no numbers" warning at a caller who does own one. */}
          {!numbers.isPending && owned.length === 0 && (
            <div className="mt-3 flex items-center justify-between gap-2 rounded border border-warning/40 bg-warning/5 px-2.5 py-1.5">
              <p className="text-xs text-warning">
                No numbers yet — buy one before you can place a call.
              </p>
              <button
                type="button"
                onClick={goBuyNumber}
                className="shrink-0 text-xs font-medium text-accent hover:underline"
              >
                Buy a number
              </button>
            </div>
          )}
          {place.isError && <ErrorText error={place.error} />}
        </form>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">Call log</h2>
          {calls.data !== undefined && (
            <span className="rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
              {calls.data.length}
            </span>
          )}
        </div>

        {calls.isPending ? (
          <SkeletonRows rows={3} />
        ) : calls.isError ? (
          <ErrorView error={calls.error} title="Could not load the call log" />
        ) : calls.data.length === 0 ? (
          <Empty
            title="No calls yet"
            description="Calls you place appear here with their status, duration, and any recording."
          />
        ) : (
          <ul className="space-y-1.5">
            {calls.data.map((call) => (
              <li
                key={call.callId}
                className={cn(
                  'overflow-hidden rounded-lg border transition-colors',
                  expanded === call.callId ? 'border-accent/40' : 'border-line',
                )}
              >
                <button
                  type="button"
                  onClick={() => {
                    setExpanded((current) => (current === call.callId ? null : call.callId));
                  }}
                  className="flex w-full items-center gap-2.5 bg-surface-raised px-3 py-2 text-left hover:bg-surface-hover"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'text-sm leading-none',
                      call.direction === 'outbound' ? 'text-accent' : 'text-ink-faint',
                    )}
                  >
                    {call.direction === 'outbound' ? '→' : '←'}
                  </span>
                  <span className="sr-only">
                    {call.direction === 'outbound' ? 'Outbound' : 'Inbound'}
                  </span>
                  <span className="font-mono text-xs text-ink">{String(call.counterparty)}</span>
                  {call.durationSeconds !== null && (
                    <span className="text-[11px] text-ink-faint">
                      {durationLabel(call.durationSeconds)}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-2">
                    {call.recorded && (
                      <span className="text-[10px] font-medium text-ink-muted">● recorded</span>
                    )}
                    <StatusPill status={call.status} />
                    <span
                      aria-hidden="true"
                      className={cn(
                        'text-[10px] text-ink-faint transition-transform',
                        expanded === call.callId && 'rotate-90',
                      )}
                    >
                      ›
                    </span>
                  </span>
                </button>
                {expanded === call.callId && (
                  <div className="border-t border-line bg-surface px-3 py-2">
                    {call.startedAt !== null && (
                      <p className="mb-1.5 text-[11px] text-ink-faint">
                        {call.direction === 'outbound' ? 'Placed' : 'Received'}{' '}
                        {formatRelative(call.startedAt)}
                      </p>
                    )}
                    {call.recorded ? (
                      <CallRecordings orgId={orgId} callId={call.callId} />
                    ) : (
                      <p className="text-[11px] text-ink-faint">This call was not recorded.</p>
                    )}
                    {/* Redial lives in the expanded body, not on the row: the
                        row IS a button, and nesting one inside it is invalid
                        HTML that browsers resolve by dropping the inner
                        control's activation — the click would toggle the row
                        instead of dialling. */}
                    <div className="mt-2 border-t border-line pt-2">
                      <CallButton
                        orgId={orgId}
                        to={String(call.counterparty)}
                        label={`Call ${String(call.counterparty)} back`}
                      />
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CallRecordings({ orgId, callId }: { readonly orgId: string; readonly callId: string }) {
  const toast = useToast();
  const { guard, dialog } = useStepUp();
  const recordings = useQuery(callRecordingsQuery(orgId, callId));

  const download = useMutation({
    mutationFn: (recordingId: string) => api.telephony.recordings.download.mutate({ recordingId }),
    onSuccess: (result) => {
      /* Single-use, short-lived, and never fetched from here — navigating is
         what `attachment-section.tsx` does for the identical reason. */
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

  if (recordings.isPending) return <SkeletonRows rows={1} />;
  if (recordings.isError) return <ErrorText error={recordings.error} />;
  if (recordings.data.length === 0) {
    return <p className="text-[11px] text-ink-faint">No recording stored yet.</p>;
  }

  return (
    <>
      <ul className="space-y-1">
        {recordings.data.map((recording) => (
          <li key={recording.recordingId} className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-ink-muted">
                {recording.status}
                {recording.durationSeconds !== null &&
                  ` · ${durationLabel(recording.durationSeconds)}`}
              </span>
              {recording.status === 'stored' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1.5 text-[11px]"
                  disabled={download.isPending}
                  onClick={() => {
                    download.mutate(recording.recordingId);
                  }}
                >
                  Download
                </Button>
              )}
            </div>
            <Transcript orgId={orgId} recordingId={recording.recordingId} />
          </li>
        ))}
      </ul>
      {download.isError && <ErrorText error={download.error} />}
      {dialog}
    </>
  );
}

/**
 * A recording's transcript, which Phase 8 Wave 3 made searchable and which
 * until now had no surface at all — `telephony.recordings.transcript` shipped
 * in Phase 7 Wave 2 with no caller, so a transcript search hit would have
 * navigated to a call that showed nothing.
 *
 * Renders NOTHING on error rather than an error box. The overwhelmingly common
 * failure is NOT_FOUND — most calls are never transcribed — and a red panel on
 * every un-transcribed recording would train people to ignore the one that
 * matters. A caller lacking `recording:read` lands in the same branch, which is
 * the honest outcome: the server decided, and the UI does not re-derive it or
 * explain what it is not being shown (§8.7).
 *
 * The text is already redacted at rest (`comms.transcripts` has no unredacted
 * column), so nothing here has to redact anything — the display is plain text
 * for the same reason the search snippet is.
 */
function Transcript({
  orgId,
  recordingId,
}: {
  readonly orgId: string;
  readonly recordingId: string;
}) {
  const transcript = useQuery(callTranscriptQuery(orgId, recordingId));

  if (transcript.isPending || transcript.isError) return null;

  return (
    <details className="rounded border border-line bg-surface-sunken px-2 py-1">
      <summary className="cursor-pointer text-[11px] text-ink-muted">Transcript</summary>
      <p className="mt-1 text-xs whitespace-pre-wrap text-ink-muted">{transcript.data.text}</p>
    </details>
  );
}
