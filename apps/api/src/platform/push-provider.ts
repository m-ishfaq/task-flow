import { encryptPushPayload, vapidAuthorization } from '@taskflow/security';

/**
 * The push side of PLAN.md §5's provider table (ai/phase-9-notifications.md
 * §3.7) — the row that row adds.
 *
 * | Interface      | Free implementation            | Paid upgrade                  | Trigger to switch  |
 * | -------------- | ------------------------------ | ----------------------------- | ------------------ |
 * | `PushProvider` | Web Push (VAPID) — no service  | Native mobile push (FCM/APNs) | A mobile app ships |
 *
 * Web Push needs no third-party service at any volume this project reaches:
 * it is a direct browser-to-service-worker protocol, and the push service
 * (FCM, Mozilla autopush, ...) is the browser's own intermediary, not a
 * broker we pay for. The value of the interface is the same as it is for
 * `Mailer`: the day a mobile app exists, `FcmPushProvider`/`ApnsPushProvider`
 * implement the same shape and nothing at the call site changes.
 *
 * The cryptography — VAPID signing and RFC 8291 payload encryption — lives
 * in `@taskflow/security`'s `web-push.ts`; this module only composes it with
 * the HTTP request a push service expects. That split is the point of
 * guardrail 5: crypto in the one auditable place, HTTP plumbing here.
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
