/**
 * MailProvider — transactional email (PLAN.md §5).
 *
 * Implementations:
 *   SmtpMailProvider    Mailpit locally, any SMTP server   (free tier, now)
 *   ResendMailProvider  Resend API, 3,000/month free       (deployed)
 *   SesMailProvider     AWS SES                            (past 3k/month)
 *
 * Email is a delivery channel for security-critical flows — verification, reset,
 * invitations, MFA fallback — so a silent failure here is a lockout, not a
 * cosmetic bug. Implementations must throw on rejection rather than resolving.
 */

export interface MailAddress {
  readonly email: string;
  readonly name?: string;
}

export interface MailMessage {
  readonly to: MailAddress | readonly MailAddress[];
  readonly subject: string;
  /** Rendered HTML body. */
  readonly html: string;
  /** Plaintext fallback. Required — some clients and most filters need it. */
  readonly text: string;
  readonly replyTo?: MailAddress;
  /**
   * Deduplication key. Providers that support it must not send twice for the
   * same key, which protects against a retried job double-sending an invitation.
   */
  readonly idempotencyKey?: string;
  /**
   * Tags for provider-side analytics. Must never carry PII — these end up in
   * third-party dashboards.
   */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface MailResult {
  /** Provider's message id, recorded for support and debugging. */
  readonly messageId: string;
  readonly accepted: boolean;
}

export interface MailProvider {
  send(message: MailMessage): Promise<MailResult>;

  /**
   * True when the provider is reachable and configured. Backs `/health/ready`.
   * Must not send anything.
   */
  verifyConnection(): Promise<boolean>;
}
