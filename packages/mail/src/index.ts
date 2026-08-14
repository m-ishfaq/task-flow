/**
 * Transactional mail (PLAN.md §8.1).
 *
 * The messages this package sends are the verification and password-reset links,
 * which are credentials rather than notifications. See `templates.ts` for what
 * that changes, and `queue.ts` for why sending is never awaited by a request.
 */

export {
  escapeHtml,
  renderDuplicateRegistration,
  renderNotificationDigest,
  renderNotificationEmail,
  renderPasswordReset,
  renderVerifyEmail,
  type LinkContext,
  type NotificationLinkContext,
  type RenderedMail,
} from './templates.js';

export {
  MemoryMailer,
  SmtpMailer,
  type Mailer,
  type OutboundMessage,
  type SmtpConfig,
} from './transport.js';

export { MailQueue, type MailFailure, type MailQueueOptions } from './queue.js';
