import type { QueryClient } from '@tanstack/react-query';
import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Query key builders and wire types for in-app voice (ai/phase-13-webrtc.md),
 * mirroring `apps/web/src/features/rtc/api.ts` — same keys (`['org', orgId,
 * 'rtc', ...]`, `['self', 'rtc', 'prefs']`), same reasoning for each. This
 * file only builds keys and types; the actual `useQuery`/`useMutation` calls
 * live in the screens, matching how `chat.ts` and `work.ts` are used
 * elsewhere in this app (no shared `queryOptions()` factory on native).
 *
 * `iceServers` is deliberately NOT keyed here — it is a MUTATION
 * (`apiClient.rtc.iceServers.mutate`), never a query, for the identical
 * reason web's own header gives: each call spends the org's daily relay
 * allowance, and a cached/refetched/retried query would spend it in ways
 * nobody asked for. `use-call.ts` calls it once per call, explicitly.
 */

export type IncomingCall = Wire<
  Awaited<ReturnType<MobileTRPCClient['rtc']['incoming']['query']>>
>[number];

export type ActiveCall = Wire<Awaited<ReturnType<MobileTRPCClient['rtc']['active']['query']>>>;

export type CallHistoryEntry = Wire<
  Awaited<ReturnType<MobileTRPCClient['rtc']['history']['list']['query']>>
>[number];

export type CallPrefs = Wire<Awaited<ReturnType<MobileTRPCClient['rtc']['prefs']['get']['query']>>>;

export type RecordingStatus = Wire<
  Awaited<ReturnType<MobileTRPCClient['rtc']['recording']['status']['query']>>
>;

export function incomingCallsQueryKey(orgId: string): readonly [string, string, string, string] {
  return ['org', orgId, 'rtc', 'incoming'];
}

export function activeCallQueryKey(
  orgId: string,
  channelId: string,
): readonly [string, string, string, string, string] {
  return ['org', orgId, 'rtc', 'active', channelId];
}

export function callHistoryQueryKey(
  orgId: string,
  channelId: string,
): readonly [string, string, string, string, string] {
  return ['org', orgId, 'rtc', 'history', channelId];
}

export function recordingQueryKey(
  orgId: string,
  sessionId: string,
): readonly [string, string, string, string, string] {
  return ['org', orgId, 'rtc', 'recording', sessionId];
}

/* NOT under `['org', orgId, ...]` — a ringtone is global per user, the same
   `selfRoute` shape `notification_prefs` already has, so keying it by org
   would refetch it on every org switch and leave a stale copy per org in
   the cache. */
export const CALL_PREFS_QUERY_KEY = ['self', 'rtc', 'prefs'] as const;

/**
 * After anything that changes a call's state. Both the incoming list and
 * the conversation's own active/history keys, always — a call that starts
 * changes what a channel's header shows AND what is ringing for everyone
 * else in it, and the two are invalidated together so a caller cannot
 * refresh one and forget the other. Mirrors web's identical function.
 */
export async function invalidateCalls(
  queryClient: QueryClient,
  orgId: string,
  channelId?: string,
  sessionId?: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: incomingCallsQueryKey(orgId) });
  if (channelId !== undefined) {
    await queryClient.invalidateQueries({ queryKey: activeCallQueryKey(orgId, channelId) });
    await queryClient.invalidateQueries({ queryKey: callHistoryQueryKey(orgId, channelId) });
  }
  if (sessionId !== undefined) {
    await queryClient.invalidateQueries({ queryKey: recordingQueryKey(orgId, sessionId) });
  }
}

/** Seconds since a captured instant, floored at zero. */
export function elapsedSeconds(sinceMs: number): number {
  return Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
}

/** `mm:ss` (or `h:mm:ss` past an hour) — mirrors web's `formatCallDuration`. */
export function formatCallDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${String(minutes)}:${pad(seconds)}`;
}
