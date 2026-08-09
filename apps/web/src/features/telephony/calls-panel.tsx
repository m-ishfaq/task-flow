import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { useToast } from '../../lib/toast-context.js';
import { useStepUp } from '../auth/use-step-up.js';
import { Button, Empty, Field, Input, Section, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { callRecordingsQuery, callsQuery, invalidateAfterSpend, phoneNumbersQuery } from './api.js';

/**
 * Click-to-call and the call log (ai/phase-7-voice.md §3.5, §3.10, Wave 2).
 *
 * `record` is unchecked by default in the form, matching `router.ts`'s own
 * default and the reasoning stated there: recording by default with an
 * opt-out means forgetting a checkbox is an unlawfully recorded call.
 */

function statusLabel(status: string): string {
  switch (status) {
    case 'in_progress':
      return 'In progress';
    case 'no_answer':
      return 'No answer';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

export function CallsPanel({ orgId }: { readonly orgId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const numbers = useQuery(phoneNumbersQuery(orgId));
  const calls = useQuery(callsQuery(orgId));

  const [to, setTo] = useState('');
  const [fromPhoneNumberId, setFromPhoneNumberId] = useState('');
  const [record, setRecord] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const place = useMutation({
    mutationFn: () =>
      api.telephony.calls.place.mutate({
        to: to.trim(),
        fromPhoneNumberId,
        record,
      }),
    onSuccess: async (result) => {
      setTo('');
      if (result.announcementRequired) {
        toast.show('Call placed', {
          description: 'A recording announcement will play before it starts.',
        });
      }
      await invalidateAfterSpend(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('The call was not placed', error);
    },
  });

  const activeNumber =
    fromPhoneNumberId !== '' ? fromPhoneNumberId : (numbers.data?.[0]?.phoneNumberId ?? '');

  return (
    <div className="space-y-6">
      <Section title="Place a call">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            place.mutate();
          }}
        >
          <Field label="To" htmlFor="call-to" hint="E.164, e.g. +14155550100">
            <Input
              id="call-to"
              value={to}
              className="w-44"
              placeholder="+14155550100"
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          </Field>

          <Field label="From" htmlFor="call-from">
            <select
              id="call-from"
              value={activeNumber}
              onChange={(event) => {
                setFromPhoneNumberId(event.target.value);
              }}
              className="h-9 rounded border border-line bg-surface-sunken px-2 text-sm text-ink"
            >
              {(numbers.data ?? []).map((number) => (
                <option key={number.phoneNumberId} value={number.phoneNumberId}>
                  {String(number.e164)}
                </option>
              ))}
            </select>
          </Field>

          <label className="flex h-9 items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={record}
              onChange={(event) => {
                setRecord(event.target.checked);
              }}
            />
            Record
          </label>

          <Button
            type="submit"
            disabled={place.isPending || activeNumber === '' || to.trim() === ''}
          >
            Call
          </Button>
        </form>
        {numbers.data?.length === 0 && (
          <p className="mt-2 text-xs text-ink-muted">
            Buy a number on the Numbers tab before placing a call.
          </p>
        )}
        {place.isError && <ErrorText error={place.error} />}
      </Section>

      <Section title="Call log" count={calls.data?.length}>
        {calls.isPending ? (
          <SkeletonRows rows={3} />
        ) : calls.isError ? (
          <ErrorView error={calls.error} title="Could not load the call log" />
        ) : calls.data.length === 0 ? (
          <Empty title="No calls yet" />
        ) : (
          <ul className="space-y-1">
            {calls.data.map((call) => (
              <li key={call.callId} className="rounded border border-line">
                <button
                  type="button"
                  onClick={() => {
                    setExpanded((current) => (current === call.callId ? null : call.callId));
                  }}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                >
                  <span className="text-xs text-ink">{String(call.counterparty)}</span>
                  <span className="text-[11px] text-ink-faint">
                    {call.direction} · {statusLabel(call.status)}
                    {call.durationSeconds !== null && ` · ${String(call.durationSeconds)}s`}
                  </span>
                  {call.recorded && (
                    <span className="ml-auto text-[11px] text-ink-faint">Recorded</span>
                  )}
                </button>
                {expanded === call.callId && call.recorded && (
                  <div className="border-t border-line px-2 py-1.5">
                    <CallRecordings orgId={orgId} callId={call.callId} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
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
          <li key={recording.recordingId} className="flex items-center gap-2">
            <span className="text-[11px] text-ink-muted">
              {recording.status}
              {recording.durationSeconds !== null && ` · ${String(recording.durationSeconds)}s`}
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
          </li>
        ))}
      </ul>
      {download.isError && <ErrorText error={download.error} />}
      {dialog}
    </>
  );
}
