import {
  createCachedDomainCheck,
  MailQueue,
  renderNotificationDigest,
  renderNotificationEmail,
  SmtpMailer,
  type Mailer,
  type MailFailure,
} from '@taskflow/mail';
import type { Env } from '../config/env.js';
import { getResolvedBranding } from '../platform-admin/branding-cache.js';
import type { PendingEmailSend } from './notification.projection.js';
import type { DigestBatch } from './digest.js';

/**
 * Turns a decided notification into an outbound message (Phase 9,
 * ai/phase-9-notifications.md §3.6).
 *
 * The identity module's own `identity/deliver.ts` is the template this
 * follows, and deliberately NOT the same `MailQueue` instance: identity's
 * queue exists as part of that module's own deps, and threading it here would
 * mean this module reaching into identity's wiring for an unrelated reason.
 * Two queues against the same SMTP transport cost one more open connection —
 * cheap, and it keeps a slow notification backlog from ever contending with a
 * password-reset email's delivery.
 */

export interface NotificationMailDeliveryOptions {
  readonly env: Env;
  /** Injected by tests. Production builds an SmtpMailer from the environment. */
  readonly mailer?: Mailer;
  readonly onFailure?: (failure: MailFailure) => void;
  readonly onSuccess?: (success: { to: string; subject: string }) => void;
}

export interface NotificationMailDelivery {
  /** Hand to `relay.ts`'s `sendNotificationEmail` option. Returns immediately — see `queue.ts`. */
  readonly send: (send: PendingEmailSend) => void;
  /** Hand to the digest sweep. One email covering the batch's items (§3.4). */
  readonly sendDigest: (batch: DigestBatch) => void;
  readonly queue: MailQueue;
}

export function createNotificationMailDelivery(
  options: NotificationMailDeliveryOptions,
): NotificationMailDelivery {
  const mailer =
    options.mailer ??
    new SmtpMailer({
      host: options.env.MAIL_HOST,
      port: options.env.MAIL_PORT,
      secure: options.env.MAIL_SECURE,
      from: options.env.MAIL_FROM,
      /* exactOptionalPropertyTypes: `user?: string` rejects `string | undefined`
         explicitly assigned — the key must be absent, not present-as-undefined. */
      ...(options.env.MAIL_USER === undefined ? {} : { user: options.env.MAIL_USER }),
      ...(options.env.MAIL_PASSWORD === undefined ? {} : { password: options.env.MAIL_PASSWORD }),
    });

  const queue = new MailQueue({
    mailer,
    /* Off unless MAIL_VALIDATE_RECIPIENT_DOMAIN is set — see that variable's
       own comment in config/env.ts. This is the queue that carries chat DM
       notifications, so it is what a seeded account (packages/seed's
        `rinavai.seed.test` users) actually hits: without this, every DM to a
       seeded recipient burns a full SMTP retry budget against a domain that
       was never going to accept it. */
    ...(options.env.MAIL_VALIDATE_RECIPIENT_DOMAIN
      ? { checkDomain: createCachedDomainCheck() }
      : {}),
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    ...(options.onSuccess === undefined ? {} : { onSuccess: options.onSuccess }),
  });

  return {
    queue,
    send: (send) => {
      /* Fire-and-forget, matching this function's own declared `void`
         return and `relay.ts`'s uncalled-with-await call site — the async
         body just moves the actual `queue.enqueue` from this tick to the
         microtask after the (almost always cached) branding lookup
         resolves, which nothing here depends on happening synchronously. */
      void (async () => {
        const { productName } = await getResolvedBranding();
        const rendered = renderNotificationEmail({
          webOrigin: options.env.WEB_ORIGIN,
          title: send.title,
          excerpt: send.excerpt,
          path: send.path,
          productName,
        });
        queue.enqueue({ to: send.to, ...rendered });
      })();
    },
    sendDigest: (batch) => {
      void (async () => {
        const { productName } = await getResolvedBranding();
        const rendered = renderNotificationDigest({
          webOrigin: options.env.WEB_ORIGIN,
          items: batch.items.map((item) => ({
            title: item.title,
            excerpt: item.excerpt,
            path: item.path,
          })),
          productName,
        });
        queue.enqueue({ to: batch.to, ...rendered });
      })();
    },
  };
}
