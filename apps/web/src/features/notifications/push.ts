import { api } from '../../lib/trpc.js';

/**
 * The browser side of Web Push (Phase 9 Wave 2, ai/phase-9-notifications.md §3.7).
 *
 * ## The ceremony, and why it lives here
 *
 * Enabling push requires a three-party agreement: the browser's permission
 * prompt, the push service's subscription (keyed to the server's VAPID public
 * key), and the server's `push.subscriptions` row. The four functions here
 * are the whole ceremony, so the preferences page calls one function per
 * user action and cannot get the ordering wrong. Everything the browser hands
 * over — endpoint, p256dh, auth — goes straight to the tRPC route; the
 * server validates shape and safety (see `apps/api/src/platform/push.ts`).
 *
 * ## Service worker registration is lazy
 *
 * The worker is registered only when someone actually enables push — not at
 * app boot. Registering early would install a service worker for users who
 * never use the feature, which is a persistent process on every page load for
 * no benefit. The module-level promise makes the ceremony idempotent: two
 * toggles in one session reuse the same registration.
 */

/**
 * The singleton registration promise. `null` until the first caller; a failed
 * registration is NOT cached, so a transient failure can be retried.
 */
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;

/** Registers the push service worker once per page lifetime. */
export function serviceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    return Promise.reject(new Error('This browser does not support service workers.'));
  }
  /* `??=` keeps the module-level promise idempotent while still retrying a
     failed registration — the LHS is only assigned when null, so the "not
     cached on failure" comment above stays true. */
  registrationPromise ??= navigator.serviceWorker.register('/sw.js');
  return registrationPromise;
}

/**
 * Decodes the server's base64url VAPID public key into the bytes the
 * `PushManager.subscribe` `applicationServerKey` option requires.
 */
function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  // An explicitly-ArrayBuffer-backed view: `PushManager.subscribe`'s
  // `applicationServerKey` accepts a `BufferSource`, which this TS lib version
  // types as ArrayBuffer specifically, not ArrayBufferLike.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Whether this browser can hold a push subscription at all.
 *
 * `Notification` without a push service worker is "I can show notifications
 * while the page is open", which is not what the push channel means — so all
 * three features must exist together.
 */
export function browserSupportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export interface BrowserPushStatus {
  readonly supported: boolean;
  /** `'granted' | 'denied' | 'default'`, or null when the browser cannot push. */
  readonly permission: NotificationPermission | null;
}

/** The parts of push state this browser can report synchronously. */
export function browserPushStatus(): BrowserPushStatus {
  if (!browserSupportsPush()) return { supported: false, permission: null };
  return { supported: true, permission: Notification.permission };
}

/**
 * The full subscribe ceremony. Rejects with a message the preferences page
 * can show the user when any of the four steps is refused — a denied
 * permission prompt, a blocked origin, an unconfigured server.
 *
 * Idempotent: if the browser already holds a subscription, that one is
 * re-registered server-side (a re-approval after a VAPID rotation updates the
 * row rather than duplicating it) and returned.
 */
export async function enablePushOnThisBrowser(): Promise<void> {
  if (!browserSupportsPush()) {
    throw new Error('This browser does not support push notifications.');
  }
  if (Notification.permission === 'denied') {
    throw new Error(
      'Notifications are blocked for this site in your browser settings. Unblock them and try again.',
    );
  }

  const { publicKey } = await api.notifications.push.vapidPublicKey.query();
  if (publicKey === null) {
    throw new Error('Push is not configured on this server.');
  }

  const registration = await serviceWorkerRegistration();

  if (Notification.permission === 'default') {
    // The prompt must be shown from a user gesture; the checkbox click is one.
    const granted = await Notification.requestPermission();
    if (granted !== 'granted') {
      throw new Error('Notification permission was not granted.');
    }
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  // `toJSON()` gives the three fields the server stores; `keys` is absent on
  // a subscription that somehow lost them, which would make every send fail.
  const json = subscription.toJSON();
  if (json.endpoint === undefined || json.keys === undefined) {
    throw new Error('The browser returned a push subscription without keys.');
  }

  await api.notifications.push.register.mutate({
    endpoint: json.endpoint,
    p256dh: json.keys['p256dh'] ?? '',
    auth: json.keys['auth'] ?? '',
  });
}

/**
 * The unsubscribe ceremony — only for the CURRENT browser's own subscription.
 *
 * Called when the user turns the push preference off. The server row for this
 * browser is removed and the browser's local subscription is dropped, so the
 * push service stops holding messages for a device that no longer wants them.
 */
export async function disablePushOnThisBrowser(): Promise<void> {
  if (!browserSupportsPush()) return;

  const registration = await serviceWorkerRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return;

  const endpoint = subscription.endpoint;

  // Drop the server row first: if the local unsubscribe throws, the server
  // no longer lists a subscription that will never be used again.
  const devices = await api.notifications.push.list.query();
  const device = devices.find((entry) => entry.endpoint === endpoint);
  if (device !== undefined) {
    await api.notifications.push.unregister.mutate({ subscriptionId: device.subscriptionId });
  }
  await subscription.unsubscribe();
}
