import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { ChannelId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { wire, type Wire } from '@taskflow/client';

/**
 * Query definitions for in-app voice (ai/phase-13-webrtc.md).
 *
 * ## `iceServers` is deliberately NOT here
 *
 * It is a mutation, not a query, and §3.4 is why: each call spends the org's
 * daily relay allowance. A `queryOptions` for it would be cached, refetched on
 * window focus, and retried on failure — three separate ways to spend budget
 * that nobody asked to spend. `use-call.ts` calls it once per call, explicitly.
 */

/** Keys are `['org', orgId, 'rtc', ...]` — the shape every other feature uses. */
export const rtcKeys = {
  incoming: (orgId: string) => ['org', orgId, 'rtc', 'incoming'] as const,
  active: (orgId: string, channelId: string) => ['org', orgId, 'rtc', 'active', channelId] as const,
  recording: (orgId: string, sessionId: string) =>
    ['org', orgId, 'rtc', 'recording', sessionId] as const,
  history: (orgId: string, channelId: string) =>
    ['org', orgId, 'rtc', 'history', channelId] as const,
  recordings: (orgId: string, channelId: string) =>
    ['org', orgId, 'rtc', 'recordings', channelId] as const,
  /* NOT under `['org', orgId, ...]`. A ringtone is global per user — the
     `selfRoute` shape — so keying it by org would refetch it on every org
     switch and, worse, would leave a stale copy per org in the cache. */
  prefs: () => ['self', 'rtc', 'prefs'] as const,
};

/**
 * Calls ringing this person right now.
 *
 * Polled rather than pushed in Wave 1. A `rtc_session.started` broadcast would
 * be lower-latency, and it needs a per-user room the event catalog does not map
 * yet — `event-rooms.ts` refuses at BOOT to map an event it has no rule for, so
 * adding one is a deliberate change rather than something this file can assume.
 * Six seconds is the difference between "the phone rang" and "the phone rang a
 * moment later", which is the right thing to trade for not inventing a room.
 */
export type IncomingCall = Wire<Awaited<ReturnType<typeof api.rtc.incoming.query>>>[number];

export function incomingCallsQuery(orgId: string) {
  return queryOptions({
    queryKey: rtcKeys.incoming(orgId),
    queryFn: async () => wire(await api.rtc.incoming.query({})),
    /* The CORRECTNESS floor, not the delivery mechanism — Phase 4's own
       NOTIFY/poll relationship. `onIncomingCall` makes the common case
       instant; this is what bounds a missed socket message to six seconds of
       latency rather than to a call that never rang. */
    refetchInterval: 6_000,
    /* A ringing call is worthless three seconds late, so this refetches on
       focus too — returning to a tab is exactly when someone wants to know. */
    refetchOnWindowFocus: true,
  });
}

/** The live call in a conversation, or null. Feeds the chat header's button. */
export function activeCallQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: rtcKeys.active(orgId, channelId),
    queryFn: () => api.rtc.active.query({ channelId }),
    refetchInterval: 6_000,
  });
}

/**
 * After anything that changes a call's state.
 *
 * Both keys, always. A call that starts changes what the conversation's header
 * shows AND what is ringing for everyone else in it, and the two are invalidated
 * together so a caller cannot refresh one and forget the other.
 */
export async function invalidateCalls(
  queryClient: QueryClient,
  orgId: string,
  channelId?: string,
  sessionId?: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: rtcKeys.incoming(orgId) });
  if (channelId !== undefined) {
    await queryClient.invalidateQueries({ queryKey: rtcKeys.active(orgId, channelId) });
    /* A call ending or a recording landing both change what the Calls tab and
       the message timeline's call cards show — refreshed alongside the live
       state rather than left to a manual reopen of the panel. */
    await queryClient.invalidateQueries({ queryKey: rtcKeys.history(orgId, channelId) });
    await queryClient.invalidateQueries({ queryKey: rtcKeys.recordings(orgId, channelId) });
  }
  if (sessionId !== undefined) {
    await queryClient.invalidateQueries({ queryKey: rtcKeys.recording(orgId, sessionId) });
  }
}

/**
 * Every call this conversation has had, newest first — the Calls tab in the
 * details panel and the call cards in the message timeline (§6's own "no
 * listing UI" gap, closed).
 */
export type CallHistoryEntry = Wire<Awaited<ReturnType<typeof api.rtc.history.list.query>>>[number];

export function callHistoryQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: rtcKeys.history(orgId, channelId),
    queryFn: async () => wire(await api.rtc.history.list.query({ channelId })),
  });
}

/** Every recording this conversation has, for the Calls tab. */
export type CallRecordingSummary = Wire<
  Awaited<ReturnType<typeof api.rtc.recording.list.query>>
>[number];

export function channelRecordingsQuery(orgId: string, channelId: ChannelId) {
  return queryOptions({
    queryKey: rtcKeys.recordings(orgId, channelId),
    queryFn: async () => wire(await api.rtc.recording.list.query({ channelId })),
  });
}

/**
 * A short-lived listen/download URL for a stored recording — how an
 * attendee actually gets it (§3.9). A mutation, not a query, for the same
 * reason `downloadMessageFile` is: it mints a capability and writes an audit
 * event, so caching or retrying it on focus would mint more than the person
 * asked for.
 */
export function downloadRecording(recordingId: string) {
  return api.rtc.recording.presignDownload.mutate({ recordingId });
}

/**
 * The recording state and consent checklist for a live call (§3.9).
 *
 * Polled at two seconds, faster than anything else here, and the reason is the
 * consent flow: while a request is open, every participant is looking at a
 * "waiting for N people" line that has to move as answers arrive. Once nobody
 * is waiting the value stops changing and the poll costs one cheap indexed read
 * per call — a socket event per consent answer would be lower traffic and would
 * need a room this event catalog does not map (`event-rooms.ts` refuses at BOOT
 * to route an event it has no rule for, which is the property worth keeping).
 */
export function recordingQuery(orgId: string, sessionId: string) {
  return queryOptions({
    queryKey: rtcKeys.recording(orgId, sessionId),
    queryFn: () => api.rtc.recording.status.query({ sessionId }),
    refetchInterval: 2_000,
  });
}

/**
 * This person's ringtone (§7).
 *
 * `staleTime: Infinity` — it changes only when they change it, and the settings
 * page invalidates on save. Refetching a preference on an interval would be a
 * request per minute per tab for a value that is almost always the same.
 */
export function callPrefsQuery() {
  return queryOptions({
    queryKey: rtcKeys.prefs(),
    queryFn: () => api.rtc.prefs.get.query({}),
    staleTime: Infinity,
  });
}

export async function invalidateCallPrefs(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: rtcKeys.prefs() });
}
