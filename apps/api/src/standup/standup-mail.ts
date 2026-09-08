import { escapeHtml } from '@taskflow/mail';
import type { MailQueue } from '@taskflow/mail';
import type { StandupResult } from './standup.service.js';

/**
 * The emailed standup digest — the mail half of migration 0108's opt-in
 * subscription. Same standalone `MailQueue`-reusing shape
 * `invitation-mail.ts`/`billing-mail.ts` already established for a mail
 * class that has nothing to do with `apps/api/src/identity`'s own
 * `DeliverableLink` union.
 *
 * Deliberately NOT the AI narration (`narrate.ts`'s `callout`) — that call
 * is spend-gated (`ai:use` + `aiAssistant`) and a subscriber may hold
 * neither. The digest is built entirely from `StandupResult`, the same
 * real, deterministic data `standup.service.ts`'s own `query` route already
 * returns with no AI call at all, so a daily email costs nothing beyond the
 * one query the digest sweep runs to fetch it.
 */

export interface StandupMailDeps {
  readonly queue: MailQueue;
  readonly webOrigin: string;
}

/**
 * Renders and enqueues one project's digest for one subscriber.
 *
 * `standup` is generally the SAME shape as the live page — this is not a
 * cut-down summary — but the roster is capped for the email specifically:
 * an email is read scrolling, not scanning a UI grid, so a project with
 * fifty members gets its top rows and a "and N more — open the standup" line
 * rather than an email long enough nobody reads it.
 */
const MAX_MEMBER_ROWS = 15;

export function sendStandupDigest(
  deps: StandupMailDeps,
  input: {
    readonly to: string;
    readonly projectName: string;
    readonly projectId: string;
    readonly standup: StandupResult;
  },
): void {
  const standupUrl = `${deps.webOrigin}/projects/${input.projectId}/standup`;
  const project = escapeHtml(input.projectName);

  const rows = input.standup.members.slice(0, MAX_MEMBER_ROWS);
  const overflow = input.standup.members.length - rows.length;

  const subject = `Standup for ${input.projectName}`;

  const textLines = rows.map(
    (member) =>
      `- ${member.name ?? member.userId}: ${String(member.yesterday.length)} done, ` +
      `${String(member.today.length)} in progress, ${String(member.overdue.length)} overdue, ` +
      `${String(member.urgent.length)} urgent`,
  );
  const text =
    `${input.standup.headline}\n\n` +
    textLines.join('\n') +
    (overflow > 0 ? `\n...and ${String(overflow)} more` : '') +
    `\n\nOpen the standup: ${standupUrl}`;

  const htmlRows = rows
    .map((member) => {
      const name = escapeHtml(member.name ?? member.userId);
      return (
        `<tr><td style="padding:2px 8px 2px 0">${name}</td>` +
        `<td style="padding:2px 8px">${String(member.yesterday.length)} done</td>` +
        `<td style="padding:2px 8px">${String(member.today.length)} today</td>` +
        `<td style="padding:2px 8px">${String(member.overdue.length)} overdue</td>` +
        `<td style="padding:2px 8px">${String(member.urgent.length)} urgent</td></tr>`
      );
    })
    .join('');

  const html =
    `<p><strong>${project}</strong> — ${escapeHtml(input.standup.headline)}</p>` +
    `<table>${htmlRows}</table>` +
    (overflow > 0 ? `<p>...and ${String(overflow)} more</p>` : '') +
    `<p><a href="${escapeHtml(standupUrl)}">Open the standup</a></p>`;

  deps.queue.enqueue({ to: input.to, subject, text, html });
}
