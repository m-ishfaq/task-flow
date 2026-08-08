import { and, desc, eq, schema, withUserScope } from '@taskflow/db';
import { AppError, type UserId } from '@taskflow/contracts';
import {
  newId,
  isValidSubscriptionKeys,
  isAllowedUrl,
  isIpAddress,
  isBlockedAddress,
} from '@taskflow/security';
import { lookup } from 'node:dns/promises';

/**
 * Web-push subscription registration (Phase 9 Wave 2, ai/phase-9-notifications.md
 * §3.7).
 *
 * ## Global per user, like the preferences
 *
 * A subscription belongs to a PERSON, not an org — the same reason
 * `identity.notification_prefs` is global — so these run under
 * `withUserScope`, keyed on the verified principal's own id. RLS
 * (`push_subscriptions_self_*`, migration 0029) enforces "own rows only" at
 * the database; the `userId` predicates below are the service's half, the
 * identical belt-and-braces pattern `notifications.ts` documents for its own
 * reads.
 *
 * ## The endpoint is the one client-supplied value that matters
 *
 * The browser hands us an endpoint and two keys. The keys are checked for
 * shape (`isValidSubscriptionKeys` — a p256dh that is not a 65-byte P-256
 * point would make every send to it fail). The endpoint is an SSRF-adjacent
 * value: the push relay POSTs to it, so a malicious client could otherwise
 * register an internal address and get the server to send it traffic. Three
 * checks: https only (the Push API mandates it), `isAllowedUrl` (scheme,
 * port, literal-IP shape), and a DNS lookup of the hostname against the
 * same private-range table `outbound-url.ts` uses for unfurls. The residual
 * risk — DNS rebinding between registration and send — is accepted and
 * noted: the payload is encrypted to the SUBSCRIBER's key, so even a
 * redirected request leaks nothing readable.
 */

export interface PushSubscription {
  readonly subscriptionId: string;
  readonly endpoint: string;
  readonly userAgentLabel: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface RegisterSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Validates the endpoint a client wants the server to POST to. Throws VALIDATION_FAILED. */
async function assertSafeEndpoint(endpoint: string): Promise<void> {
  const refuse = (message: string): never => {
    throw new AppError('VALIDATION_FAILED', message);
  };

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return refuse('The push subscription endpoint is not a valid URL.');
  }
  if (url.protocol !== 'https:') {
    return refuse('The push subscription endpoint must be https.');
  }
  if (!isAllowedUrl(endpoint).allowed) {
    return refuse('The push subscription endpoint is not reachable from this server.');
  }

  /* A hostname can resolve to a private address even when its name looks
     public — the check that counts is on the resolved address. */
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIpAddress(host)) {
    let addresses: readonly { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      return refuse('The push subscription endpoint does not resolve.');
    }
    for (const entry of addresses) {
      if (isBlockedAddress(entry.address)) {
        return refuse('The push subscription endpoint is not reachable from this server.');
      }
    }
  }
}

/** Registers (or refreshes) one device row. Idempotent per (user, endpoint). */
export async function registerSubscription(
  userId: UserId,
  input: RegisterSubscriptionInput,
  userAgent: string | null,
): Promise<{ readonly registered: true }> {
  if (!isValidSubscriptionKeys({ p256dh: input.p256dh, auth: input.auth })) {
    throw new AppError('VALIDATION_FAILED', 'The subscription keys are not valid Web Push keys.');
  }
  await assertSafeEndpoint(input.endpoint);

  return withUserScope(userId, async (tx) => {
    await tx
      .insert(schema.pushSubscriptions)
      .values({
        id: newId<'PushSubscriptionId'>(),
        userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgentLabel: parseUserAgentLabel(userAgent),
      })
      /* The same browser re-subscribing (a permission reset, a new VAPID key)
         refreshes the row rather than duplicating it. last_seen_at is bumped
         because registration is proof the device is alive. */
      .onConflictDoUpdate({
        target: [schema.pushSubscriptions.userId, schema.pushSubscriptions.endpoint],
        set: {
          p256dh: input.p256dh,
          auth: input.auth,
          userAgentLabel: parseUserAgentLabel(userAgent),
          lastSeenAt: new Date(),
        },
      });

    return { registered: true as const };
  });
}

/** The caller's own device rows — the seed Phase 12's device screen reads. */
export async function listSubscriptions(userId: UserId): Promise<readonly PushSubscription[]> {
  return withUserScope(userId, async (tx) => {
    const rows = await tx
      .select({
        subscriptionId: schema.pushSubscriptions.id,
        endpoint: schema.pushSubscriptions.endpoint,
        userAgentLabel: schema.pushSubscriptions.userAgentLabel,
        createdAt: schema.pushSubscriptions.createdAt,
        lastSeenAt: schema.pushSubscriptions.lastSeenAt,
      })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, userId))
      .orderBy(desc(schema.pushSubscriptions.lastSeenAt));

    return rows;
  });
}

/** Removes one of the caller's own device rows. Idempotent. */
export async function unregisterSubscription(
  userId: UserId,
  subscriptionId: string,
): Promise<{ readonly removed: number }> {
  return withUserScope(userId, async (tx) => {
    const removed = await tx
      .delete(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.id, subscriptionId),
          eq(schema.pushSubscriptions.userId, userId),
        ),
      )
      .returning({ id: schema.pushSubscriptions.id });

    return { removed: removed.length };
  });
}

/**
 * Turns a browser user-agent into "Chrome on Windows".
 *
 * Recognized names only, because the label is shown to a person and the
 * worst outcome of an unrecognized string is a less helpful label, not an
 * error. `Mac OS X` is normalized to `macOS` so Phase 12's device list does
 * not read like a 2005 browser report.
 */
export function parseUserAgentLabel(userAgent: string | null): string | null {
  if (userAgent === null) return null;

  const browser = /(Chrome|Firefox|Safari|Edg\/|Opera)/i.exec(userAgent)?.[1];
  const browserLabel = browser === undefined ? null : browser === 'Edg/' ? 'Edge' : browser;
  const os = /(Windows|Mac OS X|Linux|Android|iPhone|iPad)/i.exec(userAgent)?.[1];
  const osLabel = os === undefined ? null : os === 'Mac OS X' ? 'macOS' : os;

  if (browserLabel === null && osLabel === null) return null;
  if (browserLabel === null) return osLabel;
  return `${browserLabel} on ${osLabel ?? 'unknown OS'}`;
}
