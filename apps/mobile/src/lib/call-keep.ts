import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { wire } from '@taskflow/client';
import { apiClient } from './app-session.js';
import { useSession } from './use-session.js';
import { useMembers } from './use-members.js';
import { callStore, hangUp, joinCall, useCallStore } from './use-call.js';
import { incomingCallsQueryKey, invalidateCalls, type IncomingCall } from './rtc.js';

/**
 * Native CallKit (iOS) / ConnectionService (Android) integration — Tier 3's
 * first item off the mobile-vs-web audit, "the most consequential
 * *reliability* gap in the whole app" (a ringing call today only reaches
 * `call-surface.tsx`'s own in-app banner, never the lock screen or a
 * backgrounded/killed app). This file closes the part of that gap
 * achievable with the app process ALIVE — foreground or backgrounded with
 * the socket still connected. Waking a fully KILLED app is a genuinely
 * separate problem (VoIP push on iOS, a background wake mechanism on
 * Android) and is NOT this file's job — see the README's own section on
 * this pass for exactly what is and is not covered, and why.
 *
 * ## A real Android crash, found by an actual device build, and a real
 * patch — applied TWICE, because the library has the same bug twice
 *
 * `react-native-callkeep@4.3.16`'s Android native module exports pairs of
 * `@ReactMethod`-annotated Java methods sharing one name — first found in
 * `displayIncomingCall`, then, on the very next real device build after
 * that fix, the identical shape in `startCall` (the library's own upstream
 * bug, open and unfixed as of this dependency's version:
 * react-native-webrtc/react-native-callkeep issues #798, #857, #866). JS
 * has no method overloading, and this app's React Native version resolves
 * native modules through the New Architecture's TurboModule codegen, which
 * refuses to parse a module with two JS-exposed methods sharing one name —
 * `NativeModules.RNCallKeep` fails to initialize AT ALL, and every call
 * into it (`setup`, `addEventListener`, …) throws or hits `undefined`, no
 * matter which of the two duplicate pairs caused it. `patches/
 * react-native-callkeep@4.3.16.patch` (a real `pnpm patch`, wired through
 * `package.json`'s `pnpm.patchedDependencies` — this repo's existing
 * mechanism, already used for `html-entities`) removes the `@ReactMethod`
 * annotation from whichever overload `index.js`'s own Android branch never
 * calls (confirmed for each, by reading the library's actual JS bridge
 * source, not assumed — it always calls the 4-arg version of both). A full
 * scan of every remaining `@ReactMethod` in the file, run after the second
 * fix, found no third duplicate — but the first fix's own reactive,
 * one-method-at-a-time approach is exactly why that full scan was run
 * rather than trusted to have been unnecessary. Verified against a real
 * `expo prebuild`: Android's Gradle autolinking compiles straight from
 * `node_modules`, no copy step, so the patched source is what a real build
 * compiles. **Not yet confirmed CLEAN against a real device build** — the
 * first two "should be fixed now" beliefs were each disproven by the next
 * real build, which is why this stays unverified until a run actually gets
 * past it.
 *
 * ## `react-native-callkeep`, dynamically imported, matching this app's
 * own established rule
 *
 * `NativeModules.RNCallKeep` (the module's own `index.js`) does not throw
 * merely on import the way `react-native-webrtc`'s does — it degrades to
 * `undefined` and only throws when a METHOD is called on it. Importing it
 * statically would therefore not immediately crash a build that predates
 * this dependency, but calling `RNCallKeep.setup(...)` on one would, and
 * `use-call.ts`'s own header already documents this exact failure shape
 * five times over for this app's other native calling dependencies — the
 * same dynamic-import discipline is used here for consistency and because
 * `CallKeepBridge` is mounted globally, in `_layout.tsx`, alongside
 * `CallSurface`.
 *
 * ## iOS shows the real system call UI; Android does not, and that is
 * `react-native-callkeep`'s own documented behaviour, not a gap in this file
 *
 * CallKit (`displayIncomingCall` on iOS) draws Apple's own lock-screen/
 * full-screen incoming-call UI unconditionally — every VoIP app on iOS is
 * required to use it. Android's ConnectionService, in the SELF-MANAGED mode
 * this file uses (the only mode a non-carrier app can practically use — see
 * the library's own README on why), does the opposite: it hands audio
 * focus, Bluetooth routing, and Do-Not-Disturb awareness to the OS, but the
 * VISUAL incoming-call surface stays the app's own responsibility (the
 * library's README states this explicitly: "apps are able and required to
 * provide their own UI"). This app already has one —
 * `call-surface.tsx`'s `IncomingCallBanner`, reading the same
 * `incomingCallsQueryKey` this file subscribes to — so on Android,
 * `displayIncomingCall` is registering the call for correct SYSTEM
 * integration, not replacing the banner. A native, lock-screen-covering
 * Android surface (a full-screen high-priority notification) is real,
 * separate work, tied to the same background-wake problem VoIP push is.
 *
 * ## State-driven, not event-driven, for which direction reports which
 *
 * Two independent facts drive this bridge: `incoming` (who is ringing THIS
 * user, from `rtc.incoming`, the exact query `IncomingCallBanner` already
 * polls and shares the cache entry with — no second poll) and `callStore`
 * (is this device actually IN a call). A call display is issued the moment
 * a session enters `incoming` and reported ended the moment it leaves
 * without this device having joined it; `answerIncomingCall` is issued the
 * moment `callStore`'s session matches one this bridge is displaying,
 * whichever side caused it (the in-app banner's own Answer button, or
 * CallKit's own UI); `endCall` is issued the moment `callStore` returns to
 * idle for a session this bridge was tracking. This is simpler and more
 * robust than wiring a call site into every place `use-call.ts`/the banner
 * could end a call: state changing IS the fact, regardless of which button
 * caused it.
 *
 * ## The reverse direction — native Answer/Decline reaching this app's own logic
 *
 * `RNCallKeep`'s `answerCall`/`endCall` events fire when the SYSTEM UI
 * (iOS's lock screen, or whatever the app itself renders as its Android
 * incoming-call surface) reports a user action. `answerCall` calls the
 * exact same `joinCall` the in-app banner's own Answer button calls, using
 * call info this bridge cached at `displayIncomingCall` time (a plain
 * `callUUID -> IncomingCall` map, since the event payload carries only the
 * UUID). `endCall` either hangs up an ACTIVE call or declines a still-
 * ringing one, decided the same way the state-driven effects above decide
 * it — by asking `callStore`, not by trusting which native event fired.
 */

interface CallKeepModule {
  readonly setup: (options: unknown) => Promise<boolean>;
  readonly displayIncomingCall: (
    uuid: string,
    handle: string,
    localizedCallerName?: string,
    handleType?: 'generic' | 'number' | 'email',
    hasVideo?: boolean,
  ) => void;
  readonly answerIncomingCall: (uuid: string) => void;
  readonly reportEndCallWithUUID: (uuid: string, reason: number) => void;
  readonly endCall: (uuid: string) => void;
  readonly addEventListener: (
    type: 'answerCall' | 'endCall',
    handler: (args: { readonly callUUID: string }) => void,
  ) => { readonly remove: () => void };
}

let modulePromise: Promise<CallKeepModule | null> | undefined;

async function loadCallKeep(): Promise<CallKeepModule | null> {
  modulePromise ??= import('react-native-callkeep')
    .then((mod) => mod.default as CallKeepModule)
    .catch(() => null);
  return modulePromise;
}

/** iOS foreground-service-free; Android needs the strings its one-time "register a phone account" system dialog shows, and the channel its self-managed foreground service runs under. */
const SETUP_OPTIONS = {
  ios: {
    appName: 'TaskFlow',
    supportsVideo: true,
  },
  android: {
    alertTitle: 'Calls permission required',
    alertDescription: 'TaskFlow needs permission to manage calls for incoming voice calls.',
    cancelButton: 'Cancel',
    okButton: 'OK',
    selfManaged: true,
    foregroundService: {
      channelId: 'com.taskflow.app.calls',
      channelName: 'TaskFlow calls',
      notificationTitle: 'TaskFlow call in progress',
    },
  },
};

/* `END_CALL_REASONS.MISSED` is `6` on Android, `2` on iOS in the library's
   own `CONSTANTS` — restated as a literal rather than importing `CONSTANTS`
   (which would need the same dynamic load `loadCallKeep` already does, for
   one integer this file's own platform check can compute directly). */
const MISSED_REASON = Platform.OS === 'ios' ? 2 : 6;

let setupPromise: Promise<boolean> | null = null;

/** Runs `RNCallKeep.setup` at most once per process — lazily, on the first real call, never at app launch (matching `push-notifications.ts`'s own "no ceremony before the person has done anything" rule, and avoiding Android's one-time permission dialog popping up unprompted). */
async function ensureSetup(module: CallKeepModule): Promise<boolean> {
  setupPromise ??= module.setup(SETUP_OPTIONS).catch(() => false);
  return setupPromise;
}

/**
 * Mounted once, in `(app)/_layout.tsx` alongside `CallSurface` — see this
 * file's own header for the full design. Renders nothing; it only bridges
 * state to native calls and native events back to state.
 */
export function useCallKeepBridge(): void {
  const orgId = useSession((state) => state.orgId);
  const selfId = useSession((state) => state.userId);
  const queryClient = useQueryClient();
  const { personOf } = useMembers();

  const incoming = useQuery({
    queryKey: incomingCallsQueryKey(orgId ?? ''),
    queryFn: async () => wire(await apiClient.rtc.incoming.query({})),
    enabled: orgId !== null,
    refetchInterval: 6_000,
  });

  const callSessionId = useCallStore((state) => state.sessionId);
  const callStatus = useCallStore((state) => state.status);

  /* Every call currently reported to CallKeep, by its session id (used
     directly as the CallKit/ConnectionService UUID — server-generated via
     `newId<'RtcSessionId'>()`, a real UUID). Holds what `answerCall` needs
     to actually join, since the native event carries only the UUID. */
  const displayed = useRef(new Map<string, IncomingCall>());
  /* Sessions this device has told CallKeep it answered — so the "call
     ended" effect below calls `endCall` (an in-progress call this device
     is in) rather than `reportEndCallWithUUID` (a call it never joined). */
  const answered = useRef(new Set<string>());

  /* Incoming -> native display / end. */
  useEffect(() => {
    const rows = incoming.data ?? [];
    const liveIds = new Set(rows.map((row) => row.sessionId));

    for (const row of rows) {
      if (displayed.current.has(row.sessionId)) continue;
      displayed.current.set(row.sessionId, row);

      void (async () => {
        const module = await loadCallKeep();
        if (module === null) return;
        const ok = await ensureSetup(module);
        if (!ok) return;
        module.displayIncomingCall(
          row.sessionId,
          row.channelId,
          personOf(row.initiatedBy).label,
          'generic',
          row.kind === 'video',
        );
      })();
    }

    for (const [sessionId] of displayed.current) {
      if (liveIds.has(sessionId)) continue;
      /* Left the incoming list without this device joining it — declined
         (by this device or the last remaining invitee) or the whole call
         ended before anyone answered. `answered` tracks the one case that
         is NOT this: this device itself joined, handled by the
         `callStore`-driven effect below instead, which fires `endCall`
         rather than `reportEndCallWithUUID` for it. */
      if (!answered.current.has(sessionId)) {
        displayed.current.delete(sessionId);
        void (async () => {
          const module = await loadCallKeep();
          module?.reportEndCallWithUUID(sessionId, MISSED_REASON);
        })();
      }
    }
  }, [incoming.data, personOf]);

  /* callStore -> native answered / ended, and native events -> joinCall / decline. */
  useEffect(() => {
    if (callSessionId !== null && callStatus !== 'idle' && !answered.current.has(callSessionId)) {
      answered.current.add(callSessionId);
      if (displayed.current.has(callSessionId)) {
        void (async () => {
          const module = await loadCallKeep();
          module?.answerIncomingCall(callSessionId);
        })();
      }
    }

    /* A session this bridge marked answered that is no longer the active
       call: the call ended (either side), so tell CallKeep it is over and
       stop tracking it. */
    for (const sessionId of answered.current) {
      if (sessionId === callSessionId) continue;
      answered.current.delete(sessionId);
      displayed.current.delete(sessionId);
      void (async () => {
        const module = await loadCallKeep();
        module?.endCall(sessionId);
      })();
    }
  }, [callSessionId, callStatus]);

  useEffect(() => {
    let answerSubscription: { readonly remove: () => void } | null = null;
    let endSubscription: { readonly remove: () => void } | null = null;
    let cancelled = false as boolean;

    void (async () => {
      const module = await loadCallKeep();
      if (module === null || cancelled) return;

      answerSubscription = module.addEventListener('answerCall', ({ callUUID }) => {
        const call = displayed.current.get(callUUID);
        if (call === undefined || selfId === null || orgId === null) return;
        void joinCall({ orgId, sessionId: call.sessionId, channelId: call.channelId, selfId }).then(
          async () => {
            await invalidateCalls(queryClient, orgId, call.channelId);
          },
        );
      });

      endSubscription = module.addEventListener('endCall', ({ callUUID }) => {
        const state = callStore.getState();
        if (state.sessionId === callUUID && state.status !== 'idle') {
          void hangUp();
          return;
        }
        void apiClient.rtc.decline.mutate({ sessionId: callUUID }).then(async () => {
          if (orgId !== null) {
            const call = displayed.current.get(callUUID);
            await invalidateCalls(queryClient, orgId, call?.channelId);
          }
        });
      });
    })();

    return () => {
      cancelled = true;
      answerSubscription?.remove();
      endSubscription?.remove();
    };
  }, [orgId, selfId, queryClient]);
}
