import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Voice & Messaging (Phase 7) — the mobile counterpart of
 * `apps/web/src/features/telephony/api.ts`. Types and query keys only, the
 * same split `work.ts`/`billing.ts`/`sprints.ts` already establish on this
 * app: pure and Vitest-safe (no `react-native` import anywhere in this
 * file), so the formatters below get real tests, and every screen inlines
 * its own `useQuery({ queryKey, queryFn })` against these keys rather than
 * this file centralizing `queryOptions` the way web's does — mobile has no
 * prefetch call site to share them with.
 *
 * No `orgId` in any query key, matching `MY_TASKS_QUERY_KEY`/
 * `PROJECTS_QUERY_KEY`'s own convention: switching orgs on this app routes
 * through `OrgGate` and remounts the screen tree, so these keys never need
 * to disambiguate between two orgs' data coexisting in the same cache the
 * way a persistent single-page web app's might.
 */

export type PhoneNumberRecord = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['numbers']['list']['query']>>
>[number];
export type AvailableNumber = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['numbers']['search']['query']>>
>[number];
export type CallRecord = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['calls']['list']['query']>>
>[number];
export type CallRecording = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['recordings']['list']['query']>>
>[number];
export type MessageThread = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['messages']['threads']['query']>>
>[number];
export type ThreadMessage = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['messages']['list']['query']>>
>[number];
export type SpendCurrent = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['spend']['current']['query']>>
>;
export type SpendReportRow = Wire<
  Awaited<ReturnType<MobileTRPCClient['telephony']['spend']['report']['query']>>
>[number];

export const PHONE_NUMBERS_QUERY_KEY = ['telephony.numbers.list'] as const;
export const CALLS_QUERY_KEY = ['telephony.calls.list'] as const;

export function callRecordingsQueryKey(
  callId: string,
): readonly ['telephony.recordings.list', string] {
  return ['telephony.recordings.list', callId];
}

export function callTranscriptQueryKey(
  recordingId: string,
): readonly ['telephony.recordings.transcript', string] {
  return ['telephony.recordings.transcript', recordingId];
}

export const MESSAGE_THREADS_QUERY_KEY = ['telephony.messages.threads'] as const;

export function threadMessagesQueryKey(
  threadId: string,
): readonly ['telephony.messages.list', string] {
  return ['telephony.messages.list', threadId];
}

export const SPEND_CURRENT_QUERY_KEY = ['telephony.spend.current'] as const;

export function spendReportQueryKey(
  sinceDays: number,
): readonly ['telephony.spend.report', number] {
  return ['telephony.spend.report', sinceDays];
}

/**
 * One dialable person — a member with a work phone on their membership
 * profile (`people.membership_profiles.work_phone`). Not a server route;
 * `telephony-contact-picker.tsx` builds this by walking `people.directory
 * .list`'s pages itself, the same client-side derivation web's own
 * `phoneContactsQuery` makes and for the identical reason: there is no
 * "directory of people with phones" route, only a directory.
 */
export interface PhoneContact {
  readonly userId: string;
  readonly label: string;
  readonly email: string;
  /** E.164, non-null by construction — a member with no work phone is never in this list. */
  readonly phone: string;
}

export const PHONE_CONTACTS_QUERY_KEY = ['telephony.phoneContacts'] as const;

/** A coloured pill's label for a carrier call status — ported verbatim from `calls-panel.tsx`'s own `STATUS_LABELS`. */
export const CALL_STATUS_LABEL: Readonly<Record<string, string>> = {
  queued: 'Queued',
  ringing: 'Ringing',
  in_progress: 'In progress',
  completed: 'Completed',
  busy: 'Busy',
  no_answer: 'No answer',
  failed: 'Failed',
  canceled: 'Canceled',
};

/** A status this table has no label for — Title Cased rather than left raw, matching `calls-panel.tsx`'s own fallback. */
export function callStatusLabel(status: string): string {
  return CALL_STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

/** The spend report's per-kind row label — ported verbatim from `spend-panel.tsx`'s own `KIND_LABELS`. */
export const SPEND_KIND_LABEL: Readonly<Record<string, string>> = {
  call: 'Calls',
  sms: 'SMS',
  number_purchase: 'Number purchases',
  verification: 'Verification',
  automation_call: 'Automation calls',
  automation_sms: 'Automation SMS',
};

/**
 * A call/recording duration, "1m 04s" or "45s" — total, not a nullable
 * `number | null -> string | null` the way a naive port might read: every
 * call site already guards on a null duration before calling this (a call
 * still ringing, a recording still processing), so this only ever has to
 * express a REAL duration.
 */
export function durationLabel(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return minutes > 0 ? `${String(minutes)}m ${String(rest).padStart(2, '0')}s` : `${String(rest)}s`;
}
