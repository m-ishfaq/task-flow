import {
  MailQueue,
  renderDuplicateRegistration,
  renderPasswordReset,
  renderVerifyEmail,
  SmtpMailer,
  type Mailer,
  type RenderedMail,
} from '@taskflow/mail';
import type { Env } from '../config/env.js';
import type { DeliverableLink } from './identity.service.js';

/**
 * Turns an identity event into an outbound message (PLAN.md §8.1).
 *
 * This is the seam between "the identity service decided something must be
 * told to a user" and "a message left the process". It exists as its own file
 * because the identity service must not know about SMTP, and the mail package
 * must not know what a `DeliverableLink` is.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — these messages carry credentials.
 */

export interface MailDeliveryOptions {
  readonly env: Env;
  /** Injected by tests. Production builds an SmtpMailer from the environment. */
  readonly mailer?: Mailer;
  readonly onFailure?: (failure: { to: string; subject: string; attempts: number }) => void;
}

export interface MailDelivery {
  /** Hand to `IdentityDeps.deliver`. Returns as soon as the message is queued. */
  readonly deliver: (message: DeliverableLink) => Promise<void>;
  readonly queue: MailQueue;
}

/**
 * Link lifetimes, stated to the user.
 *
 * Duplicated from deps.ts rather than imported, and that is a real cost — but
 * the alternative is a mail template importing the identity wiring, and these
 * two numbers appearing in a message is a copy edit, not a security control. The
 * lifetimes that are ENFORCED are the ones in deps.ts.
 */
const VERIFICATION_EXPIRY_HOURS = 24;
const PASSWORD_RESET_EXPIRY_MINUTES = 60;

export function createMailDelivery(options: MailDeliveryOptions): MailDelivery {
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
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }),
  });

  return {
    queue,
    deliver: (message) => {
      const rendered = render(message, options.env.WEB_ORIGIN);
      queue.enqueue({ to: message.email, ...rendered });

      /* Resolved, not awaited on delivery. A handler that waited here would make
         the response time depend on whether mail was sent — and
         requestPasswordReset only sends for an address that exists, so the wait
         would be a free account-existence oracle. See queue.ts. */
      return Promise.resolve();
    },
  };
}

function render(message: DeliverableLink, webOrigin: string): RenderedMail {
  switch (message.kind) {
    case 'verify_email':
      return renderVerifyEmail({
        webOrigin,
        token: message.token ?? '',
        expiresInHours: VERIFICATION_EXPIRY_HOURS,
      });

    case 'password_reset':
      return renderPasswordReset({
        webOrigin,
        token: message.token ?? '',
        expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
      });

    case 'duplicate_registration':
      // Carries no token by design — see the template.
      return renderDuplicateRegistration();
  }
}
