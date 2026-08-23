import { encryptPushPayload, vapidAuthorization } from '@taskflow/security';

/**
 * The push side of PLAN.md §5's provider table (ai/phase-9-notifications.md
 * §3.7) — the row that row adds, plus the row it predicted
 * (ai/phase-14-mobile.md §9): "the day a mobile app exists,
 * FcmPushProvider/ApnsPushProvider implement the same shape and nothing at
 * the call site changes." That day arrived — `ExpoPushProvider` below is
 * the implementation, and `notification-push.ts`'s drain loop calls it
 * exactly the way it already called `WebPushProvider`.
 *
 * | Interface           | Free implementation            | Paid upgrade | Trigger to switch  |
 * | -------------------- | ------------------------------ | ------------ | ------------------ |
 * | `PushProvider`       | Web Push (VAPID) — no service  | —            | (shipped)          |
 * | `ExpoPushProvider`   | Expo's push relay — no service | —            | (shipped)          |
 *
 * Web Push needs no third-party service at any volume this project reaches:
 * it is a direct browser-to-service-worker protocol, and the push service
 * (FCM, Mozilla autopush, ...) is the browser's own intermediary, not a
 * broker we pay for. The cryptography — VAPID signing and RFC 8291 payload
 * encryption — lives in `@taskflow/security`'s `web-push.ts`; this module
 * only composes it with the HTTP request a push service expects. That split
 * is the point of guardrail 5: crypto in the one auditable place, HTTP
 * plumbing here.
 *
 * `ExpoPushProvider` needs no key material of ITS OWN either — unlike a
 * hand-rolled FCM/APNs integration, Expo's push relay already sits in front
 * of both, and the credentials that let it reach a real device (an Apple
 * Push key, an FCM service account) live in the EAS project configuration,
 * not in this server's environment. An `EXPO_ACCESS_TOKEN` could be added
 * later for higher rate limits and per-project scoping; sends work without
 * one at the volume this project reaches today, so it is not required.
 */

/** How long a push message may wait with the push service, in seconds. */
const TTL_SECONDS = 24 * 60 * 60;

export type PushSendOutcome = 'sent' | 'gone' | 'failed';

export interface PushSendInput {
  /** The subscription's endpoint (the push service URL). */
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  /** The JSON message the service worker will `data.json()` when it arrives. */
  readonly payload: string;
}

export interface PushProvider {
  /**
   * Sends one encrypted push message.
   *
   * `'sent'` means the push service accepted it (201/204 — the exact meaning
   * of "accepted" for that service); `'gone'` means the endpoint is dead
   * (404/410 — the browser will never use it again, so the subscription
   * should be dropped); `'failed'` is any other HTTP outcome. Transport
   * errors (network down, timeout) THROW — they are transient, unlike a
   * 404, and the caller treats a throw as "try again later" by leaving the
   * delivery `pending`.
   */
  readonly send: (input: PushSendInput) => Promise<PushSendOutcome>;
}

/**
 * The Web Push provider. Constructed from the validated VAPID environment
 * variables — there is no per-request state, so one instance is shared.
 */
export class WebPushProvider implements PushProvider {
  readonly #subject: string;
  readonly #privateKey: string;

  /**
   * Both values are required because an instance without them is not a push
   * sender — `main.ts` narrows the optional env fields before constructing.
   */
  constructor(env: { readonly VAPID_SUBJECT: string; readonly VAPID_PRIVATE_KEY: string }) {
    this.#subject = env.VAPID_SUBJECT;
    this.#privateKey = env.VAPID_PRIVATE_KEY;
  }

  async send(input: PushSendInput): Promise<PushSendOutcome> {
    const audience = new URL(input.endpoint).origin;
    const { body } = encryptPushPayload({ p256dh: input.p256dh, auth: input.auth }, input.payload);
    const { authorization } = vapidAuthorization({
      subject: this.#subject,
      privateKey: this.#privateKey,
      audience,
    });

    /* The browser's push service, not ours, is being asked to hold a message
       for a device. The VAPID header proves to it that we are who we claim
       (RFC 8292); the body is encrypted to the subscription's own key, so
       the service cannot read it (RFC 8291). Both are required: a service
       that accepted an unauthenticated message would be an open relay. */
    const response = await fetch(input.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(TTL_SECONDS),
      },
      // The endpoint is the browser's chosen push service, vetted at
      // registration (https + public address). A push service that cannot be
      // reached in a few seconds is not worth queuing behind.
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 201 || response.status === 204 || response.status === 200) {
      return 'sent';
    }
    // 404 and 410 are the push service telling us the endpoint is gone —
    // permanently, not transiently.
    if (response.status === 404 || response.status === 410) return 'gone';
    // 400 (malformed), 413 (payload too large), 429 (rate limited) are all
    // retryable-in-principle, but a stuck delivery should surface as failed
    // rather than pending forever.
    return 'failed';
  }
}

const EXPO_PUSH_API_URL = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushSendInput {
  readonly expoPushToken: string;
  readonly title: string;
  readonly body: string | null;
  /** Where tapping the notification should navigate — carried in `data`, read by the app's own notification-response handler. */
  readonly path: string | null;
}

/**
 * One Expo push ticket's outcome, as reported synchronously by the send
 * call. Expo's API returns this shape for every message in the request,
 * whether it ultimately succeeded on the DEVICE (Expo answers a RECEIPT for
 * that, checked separately and not implemented here — see this module's own
 * header on why this codebase does not chase that second round trip yet)
 * or was refused outright (a malformed token, an unregistered device).
 */
interface ExpoTicket {
  readonly status: 'ok' | 'error';
  readonly message?: string;
  readonly details?: { readonly error?: string };
}

export interface ExpoPushProviderOptions {
  /** Optional — improves rate limits and scopes sends to this Expo project. Omit to send unauthenticated, which works at this project's volume. */
  readonly accessToken?: string;
}

/**
 * Sends via Expo's hosted push relay — the implementation `push-provider.ts`'s
 * own header predicted before a mobile app existed. One HTTP call per
 * message rather than a batch: `notification-push.ts` already sends one
 * `PushProvider.send()` per (delivery, subscription) pair for web push, and
 * matching that shape here means the drain loop's retry/mark bookkeeping
 * does not need a second code path for a batched provider.
 */
export class ExpoPushProvider {
  readonly #accessToken: string | undefined;

  constructor(options: ExpoPushProviderOptions = {}) {
    this.#accessToken = options.accessToken;
  }

  async send(input: ExpoPushSendInput): Promise<PushSendOutcome> {
    const response = await fetch(EXPO_PUSH_API_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        ...(this.#accessToken === undefined
          ? {}
          : { Authorization: `Bearer ${this.#accessToken}` }),
      },
      body: JSON.stringify([
        {
          to: input.expoPushToken,
          title: input.title,
          body: input.body ?? undefined,
          // Read by the app's notification-response listener to navigate —
          // the same `path` shape `notification-push.ts`'s web-push payload
          // already carries.
          data: input.path === null ? undefined : { path: input.path },
        },
      ]),
      signal: AbortSignal.timeout(10_000),
    });

    // A non-2xx here means the REQUEST was refused (malformed JSON, an
    // outage) — transient, so this throws and the caller's existing
    // "transport errors throw" contract leaves the delivery pending for the
    // next tick, exactly as `WebPushProvider.send` documents.
    if (!response.ok) {
      throw new Error(`Expo push API responded ${String(response.status)}`);
    }

    const body: unknown = await response.json();
    const ticket = firstTicket(body);
    if (ticket === null) throw new Error('Expo push API returned no ticket');

    if (ticket.status === 'ok') return 'sent';
    // "DeviceNotRegistered" is Expo's own name for the receiving end of a
    // 404/410 in the web-push provider above — the token will never work
    // again (uninstalled, or rotated past what this row remembers).
    if (ticket.details?.error === 'DeviceNotRegistered') return 'gone';
    return 'failed';
  }
}

/**
 * Expo's array-request response is `{ data: [ticket, ...] }`, matched
 * positionally to the request array — this provider always sends exactly
 * one message, so the first (only) ticket is the whole answer. Parsed
 * defensively rather than trusted: this is a THIRD PARTY's response body,
 * and a shape this does not recognize is a `failed` outcome, not a crash.
 */
function firstTicket(body: unknown): ExpoTicket | null {
  if (typeof body !== 'object' || body === null || !('data' in body)) return null;
  const data = (body as { readonly data: unknown }).data;
  const first = Array.isArray(data) ? (data[0] as unknown) : undefined;
  if (typeof first !== 'object' || first === null || !('status' in first)) return null;
  const status = (first as { readonly status: unknown }).status;
  if (status !== 'ok' && status !== 'error') return null;
  return first as ExpoTicket;
}
