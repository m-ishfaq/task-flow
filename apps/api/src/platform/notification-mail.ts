import {
  MailQueue,
  renderNotificationDigest,
  renderNotificationEmail,
  SmtpMailer,
  type Mailer,
} from '@taskflow/mail';
import type { Env } from '../config/env.js';
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
  readonly onFailure?: (failure: { to: string; subject: string; attempts: number }) => void;
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
      user: options.env.MAIL_USER,
      password: options.env.MAIL_PASSWORD,
    });

  const queue = new MailQueue({
    mailer,
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
  });

  return {
    queue,
    send: (send) => {
      const rendered = renderNotificationEmail({
        webOrigin: options.env.WEB_ORIGIN,
        title: send.title,
        excerpt: send.excerpt,
        path: send.path,
      });
      queue.enqueue({ to: send.to, ...rendered });
    },
    sendDigest: (batch) => {
      const rendered = renderNotificationDigest({
        webOrigin: options.env.WEB_ORIGIN,
        items: batch.items.map((item) => ({
          title: item.title,
          excerpt: item.excerpt,
          path: item.path,
        })),
      });
      queue.enqueue({ to: batch.to, ...rendered });
    },
  };
}
