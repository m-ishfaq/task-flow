import {
  MailQueue,
  renderDuplicateRegistration,
  renderImpossibleTravel,
  renderPasskeyRegistered,
  renderPasswordChanged,
  renderPasswordReset,
  renderTotpEnabled,
  renderVerifyEmail,
  SmtpMailer,
  type Mailer,
  type MailFailure,
  type RenderedMail,
} from '@taskflow/mail';
import type { Env } from '../config/env.js';
import { getResolvedBranding } from '../platform-admin/branding-cache.js';
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
  readonly onFailure?: (failure: MailFailure) => void;
  readonly onSuccess?: (success: { to: string; subject: string }) => void;
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
    ...(options.onSuccess === undefined ? {} : { onSuccess: options.onSuccess }),
  });

  return {
    queue,
    deliver: async (message) => {
      /* Awaited, unlike the actual SEND below — the branding cache lookup
         does not depend on `message` at all, so it takes the same time
         whether the account exists or not and introduces no NEW
         account-existence oracle on top of the one `requestPasswordReset`
         already accepts (it returns before calling `deliver` at all for an
         address with no active account — see that function's own comment).
         It resolves from `branding-cache.ts`'s 30s TTL cache, so this is
         almost always a cache hit costing microseconds, not a database
         round trip. */
      const { productName } = await getResolvedBranding();
      const rendered = render(message, options.env.WEB_ORIGIN, productName);
      queue.enqueue({ to: message.email, ...rendered });

      /* The actual SEND is not awaited here — a handler that waited on it
         would make the response time depend on whether mail was sent, which
         is the real oracle this comment is about. See queue.ts. */
    },
  };
}

function render(message: DeliverableLink, webOrigin: string, productName: string): RenderedMail {
  switch (message.kind) {
    case 'verify_email':
      return renderVerifyEmail({
        webOrigin,
        token: message.token ?? '',
        expiresInHours: VERIFICATION_EXPIRY_HOURS,
        productName,
      });

    case 'password_reset':
      return renderPasswordReset({
        webOrigin,
        token: message.token ?? '',
        expiresInMinutes: PASSWORD_RESET_EXPIRY_MINUTES,
        productName,
      });

    case 'duplicate_registration':
      // Carries no token by design — see the template.
      return renderDuplicateRegistration({ productName });

    case 'impossible_travel':
      return renderImpossibleTravel({
        previousCountry: message.previousCountry ?? '',
        newCountry: message.newCountry ?? '',
        productName,
      });

    case 'password_changed':
      return renderPasswordChanged({ productName });

    case 'totp_enabled':
      return renderTotpEnabled({ productName });

    case 'passkey_registered':
      return renderPasskeyRegistered({ productName });
  }
}
