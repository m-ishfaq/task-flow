import { escapeHtml } from '@taskflow/mail';
import type { MailQueue } from '@taskflow/mail';
import type { StandupMember, StandupResult } from './standup.service.js';

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
 *
 * ## `scope`: not everyone who subscribes should be mailed the whole roster
 *
 * The interactive standup PAGE deliberately floors on `project:read` and
 * shows every member's buckets to anyone who can open it — `standup.
 * service.ts`'s own header states why: a standup answers "what is my team
 * doing right now," a question every project Member already needs the
 * board for. A daily EMAIL is a different exposure than a page someone
 * chooses to open, though: pushing every colleague's task list into a
 * Member's or Guest's inbox every morning is real, unsolicited noise about
 * people who are not that person's direct concern, not a permission this
 * codebase's own model treats as withheld from them — see `digest-sweep.
 * ts`'s own `scopeFor` for how the sender decides which shape to send.
 * `'team'` is the unchanged full roster (headline plus every member,
 * capped at `MAX_MEMBER_ROWS`); `'personal'` is the recipient's own row
 * alone, with no headline (a team-wide aggregate has nothing to say about
 * one person) and no member cap (there is only ever one row).
 */

export type StandupDigestScope = 'team' | 'personal';

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

function memberLine(member: StandupMember): string {
  return (
    `${member.name ?? member.userId}: ${String(member.yesterday.length)} done, ` +
    `${String(member.today.length)} in progress, ${String(member.overdue.length)} overdue, ` +
    `${String(member.urgent.length)} urgent`
  );
}

function memberRowHtml(member: StandupMember): string {
  const name = escapeHtml(member.name ?? member.userId);
  return (
    `<tr><td style="padding:2px 8px 2px 0">${name}</td>` +
    `<td style="padding:2px 8px">${String(member.yesterday.length)} done</td>` +
    `<td style="padding:2px 8px">${String(member.today.length)} today</td>` +
    `<td style="padding:2px 8px">${String(member.overdue.length)} overdue</td>` +
    `<td style="padding:2px 8px">${String(member.urgent.length)} urgent</td></tr>`
  );
}

export function sendStandupDigest(
  deps: StandupMailDeps,
  input: {
    readonly to: string;
    readonly projectName: string;
    readonly projectId: string;
    readonly standup: StandupResult;
    readonly scope: StandupDigestScope;
    /** Which `StandupMember` is "you" — only consulted for `scope: 'personal'`. */
    readonly recipientUserId: string;
  },
): void {
  const standupUrl = `${deps.webOrigin}/projects/${input.projectId}/standup`;
  const project = escapeHtml(input.projectName);

  const rows =
    input.scope === 'personal'
      ? input.standup.members.filter((member) => member.userId === input.recipientUserId)
      : input.standup.members.slice(0, MAX_MEMBER_ROWS);
  const overflow = input.scope === 'personal' ? 0 : input.standup.members.length - rows.length;

  const subject =
    input.scope === 'personal'
      ? `Your standup for ${input.projectName}`
      : `Standup for ${input.projectName}`;

  const headlineText = input.scope === 'team' ? `${input.standup.headline}\n\n` : '';
  const headlineHtml =
    input.scope === 'team'
      ? `<p><strong>${project}</strong> — ${escapeHtml(input.standup.headline)}</p>`
      : '';

  const body =
    rows.length === 0
      ? 'Nothing to report today.'
      : rows.map((member) => `- ${memberLine(member)}`).join('\n');

  const text =
    headlineText +
    body +
    (overflow > 0 ? `\n...and ${String(overflow)} more` : '') +
    `\n\nOpen the standup: ${standupUrl}`;

  const htmlRows =
    rows.length === 0
      ? '<tr><td style="padding:2px 0">Nothing to report today.</td></tr>'
      : rows.map(memberRowHtml).join('');

  const html =
    headlineHtml +
    `<table>${htmlRows}</table>` +
    (overflow > 0 ? `<p>...and ${String(overflow)} more</p>` : '') +
    `<p><a href="${escapeHtml(standupUrl)}">Open the standup</a></p>`;

  deps.queue.enqueue({ to: input.to, subject, text, html });
}
