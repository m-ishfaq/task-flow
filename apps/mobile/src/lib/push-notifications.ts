import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type * as ExpoNotifications from 'expo-notifications';
import { apiClient } from './app-session.js';
import { mobilePathFor } from './notification-path.js';

/**
 * Native mobile push (Phase 14 §9, ai/phase-14-mobile.md) — the client half
 * of `apps/api/src/platform/expo-push.ts`/`ExpoPushProvider`. Mirrors
 * `apps/web/src/features/notifications/push.ts`'s own ceremony shape (one
 * function per user action, so the account screen cannot get the ordering
 * wrong), with the browser's service-worker/VAPID/PushManager triad replaced
 * by Expo's own `expo-notifications` module.
 *
 * ## `expo-notifications` is loaded lazily, never as a static top-level import
 *
 * The exact shape `device-key.ts`'s `getNative()`,
 * `biometric-gate.native.ts`'s dynamic `expo-local-authentication` import,
 * `passkeys.ts`'s `loadPasskeys()`, and `qr-code.tsx`'s dynamic
 * `react-native-qrcode-svg` import all already use, for the identical
 * reason each of their own headers documents: a native module's entry file
 * commonly calls `requireNativeModule` at ITS top level, which throws
 * wherever the module is not yet linked (Expo Go, or a dev build predating
 * this dependency), and a static import in a file reachable from the root
 * layout would poison Metro's whole module graph before a single screen
 * renders — this is the FIFTH time this exact bug shape has been named in
 * this codebase.
 *
 * ## Registration is explicit, never automatic on launch
 *
 * The same call web's own header makes for its checkbox: prompting for
 * notification permission the instant the app opens, before the person has
 * done anything, is the platform-review-rejected pattern every mobile
 * guideline warns about, and it is also just rude. `registerForPush` only
 * ever runs from a button press on the account screen
 * (`push-notifications-section.tsx`).
 *
 * ## No `expo-device` dependency for a friendlier label
 *
 * `push_subscriptions`/`expo_push_tokens`' own `userAgentLabel`/
 * `deviceLabel` columns exist for "iPhone 15"-shaped labels — getting one
 * needs `expo-device`'s `Device.modelName`, a SIXTH native dependency for
 * a label that is otherwise cosmetic. `Platform.OS` alone ("iOS device" /
 * "Android device") is honest and dependency-free; upgrading it to a real
 * model name is real, separate, low-priority work.
 *
 * ## Code-complete, infrastructure NOT — the same wall passkeys/biometrics
 * already hit
 *
 * `getExpoPushTokenAsync` only returns a usable token against a REAL EAS
 * project with push credentials configured (an Apple Push key uploaded to
 * EAS, an FCM service account) — `app.config.ts`'s own `extra.eas.projectId`
 * names the project, but the credentials themselves are set up in EAS's own
 * dashboard by whoever owns that account, not by anything in this repo.
 * Until that happens, this ceremony fails cleanly with an honest error
 * (`ExpoPushProviderError` below) rather than a silent no-op — the identical
 * "code complete, infrastructure not" state this file's README already
 * documents twice over for passkeys and biometric app-lock.
 */

let modulePromise: Promise<typeof ExpoNotifications> | undefined;
async function loadNotifications(): Promise<typeof ExpoNotifications> {
  modulePromise ??= import('expo-notifications');
  return modulePromise;
}

/** `registerForPushNotifications` never throws — every failure reason (permission, missing EAS project, no token, a refused registration call) folds into this instead, so the account-screen section needs one branch, not a try/catch around a promise that sometimes rejects. */
export type PushRegistrationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The registered-devices list — `notifications.expoPush.list`. */
export const EXPO_PUSH_TOKENS_QUERY_KEY = ['notifications.expoPush.list'] as const;

/** `Platform.OS`-only — see this file's own header on why no native-model-name dependency was added for something cosmetic. */
function deviceLabel(): string {
  return Platform.OS === 'ios' ? 'iOS device' : 'Android device';
}

/**
 * The full "enable push on this device" ceremony: permission, an Android
 * notification channel (required there before any notification may show),
 * an Expo push token, and registering it with the server. Idempotent — the
 * server's own `(user, token)` upsert (migration 0082) means running this
 * again just refreshes `lastSeenAt`.
 */
export async function registerForPushNotifications(): Promise<PushRegistrationResult> {
  let Notifications: typeof ExpoNotifications;
  try {
    Notifications = await loadNotifications();
  } catch {
    return { ok: false, reason: 'Push notifications are not available in this build.' };
  }

  const existing = await Notifications.getPermissionsAsync();
  let finalStatus = existing.status;
  if (finalStatus !== Notifications.PermissionStatus.GRANTED) {
    // The prompt must follow a user gesture; the button press that called
    // this function is one.
    const requested = await Notifications.requestPermissionsAsync();
    finalStatus = requested.status;
  }
  if (finalStatus !== Notifications.PermissionStatus.GRANTED) {
    return { ok: false, reason: 'Notification permission was not granted.' };
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = readEasProjectId();
  if (projectId === null) {
    return { ok: false, reason: 'This build has no EAS project configured for push.' };
  }

  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync({ projectId });
    token = result.data;
  } catch {
    // A simulator, or an EAS project with no push credentials configured —
    // see this file's own header. Not this function's job to tell the two
    // apart; either way there is no token to register.
    return { ok: false, reason: 'Could not get a push token for this device.' };
  }

  try {
    await apiClient.notifications.expoPush.register.mutate({
      expoPushToken: token,
      deviceLabel: deviceLabel(),
    });
  } catch {
    // A genuine device token, refused only by the network call — the
    // caller's contract is "never throws," so this folds in with every
    // other reason above rather than propagating a raw tRPC error.
    return { ok: false, reason: 'Your device could not be registered right now.' };
  }

  return { ok: true };
}

/**
 * `app.config.ts`'s `extra.eas.projectId`. `expo-constants`' own type for
 * `extra` is `Record<string, any>` — an index signature that presumes
 * every key exists, so a `Record<string, any>`-typed read of `.eas`/
 * `.projectId` waves through with no real check at all. Recast through
 * `unknown` at the boundary so the compiler enforces genuine narrowing on
 * a value this app does not fully own (`config.ts`'s own header on `extra`
 * not being a bag this app controls).
 */
function readEasProjectId(): string | null {
  const extra: unknown = Constants.expoConfig?.extra;
  if (typeof extra !== 'object' || extra === null) return null;

  const eas: unknown = (extra as { eas?: unknown }).eas;
  if (typeof eas !== 'object' || eas === null) return null;

  const projectId: unknown = (eas as { projectId?: unknown }).projectId;
  return typeof projectId === 'string' ? projectId : null;
}

/**
 * Subscribes to tapped notifications for the app's whole lifetime — called
 * once from the root layout, the identical "runs for the app's whole
 * lifetime, not tied to auth state" placement `_layout.tsx`'s own `AppState`
 * listener already uses, and for the same reason: listening costs nothing
 * and prompts no permission, unlike `registerForPushNotifications` above.
 * Also configures FOREGROUND display — without `setNotificationHandler`, a
 * push arriving while the app is already open is silently swallowed rather
 * than shown, which is `expo-notifications`' own default and not what
 * anyone reading a chat screen at the time would expect.
 *
 * Returns a synchronous unsubscribe function immediately, before the lazy
 * module has necessarily finished loading — the same "subscribe now,
 * resolve later" shape a cleanup-returning `useEffect` needs, since React
 * cannot await an async cleanup function.
 */
export function attachNotificationResponseListener(onNavigate: (path: string) => void): () => void {
  let cancelled = false;
  let subscription: { readonly remove: () => void } | undefined;

  void (async () => {
    let Notifications: typeof ExpoNotifications;
    try {
      Notifications = await loadNotifications();
    } catch {
      return;
    }
    if (cancelled) return;

    Notifications.setNotificationHandler({
      handleNotification: () =>
        Promise.resolve({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
    });

    subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data: unknown = response.notification.request.content.data;
      const rawPath =
        typeof data === 'object' && data !== null && 'path' in data && typeof data.path === 'string'
          ? data.path
          : null;
      if (rawPath === null) return;
      const mobilePath = mobilePathFor(rawPath);
      if (mobilePath !== null) onNavigate(mobilePath);
    });
  })();

  return () => {
    cancelled = true;
    subscription?.remove();
  };
}
