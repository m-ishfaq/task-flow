/**
 * Transactional mail bodies (PLAN.md §8.1).
 *
 * ## Every message here carries a credential or a security notice
 *
 * A verification link and a reset link ARE credentials — possession of the URL
 * is the whole proof. That shapes three things below:
 *
 *   1. **Nothing is interpolated unescaped.** The only caller-controlled value
 *      that reaches a template is an email address, and an address is allowed to
 *      contain `<` and `&`. An unescaped one is stored XSS in whatever webmail
 *      renders it.
 *   2. **No message reveals whether an account exists**, except the ones sent to
 *      the address itself — which is the one recipient already entitled to know.
 *   3. **Links are single-use and time-boxed**, and each message says so, because
 *      a user who understands the link expires does not forward it.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface LinkContext {
  /** Origin of the web app, from the validated env schema. Never from a request. */
  readonly webOrigin: string;
  readonly token: string;
}

/**
 * Escapes text for interpolation into HTML.
 *
 * Includes the quote characters, not just the angle brackets: these values land
 * inside attributes as well as element bodies, and a template that escapes only
 * `<` and `>` breaks out of `href="..."` with a single `"`.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds a link to the web app.
 *
 * The token is percent-encoded even though the alphabet it comes from is
 * URL-safe today. That is one line of insurance against a future token format
 * quietly breaking every link in every inbox — a failure nobody can fix
 * retroactively, because the mail has already been sent.
 */
function link(context: LinkContext, path: string): string {
  const origin = context.webOrigin.replace(/\/+$/, '');
  return `${origin}${path}?token=${encodeURIComponent(context.token)}`;
}

/** Wraps a body in the shared plain-text signature. */
function textDocument(lines: readonly string[]): string {
  return [
    ...lines,
    '',
    '—',
    'TaskFlow',
    'This is an automated message; replies are not read.',
  ].join('\n');
}

/**
 * Wraps a body in the shared HTML shell.
 *
 * Deliberately plain. Mail clients strip most CSS, and the more a security
 * notice looks like marketing, the more it trains people to ignore it.
 */
function htmlDocument(bodyHtml: string): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:520px">',
    bodyHtml,
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">',
    '<p style="font-size:13px;color:#666">TaskFlow — this is an automated message; replies are not read.</p>',
    '</div>',
  ].join('\n');
}

function button(href: string, label: string): string {
  const safeHref = escapeHtml(href);
  return (
    `<p><a href="${safeHref}" style="display:inline-block;background:#1a1a1a;color:#fff;` +
    `padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(label)}</a></p>` +
    /* The raw URL as well as the button. Clients that block styled links, and
       users who have learned not to click buttons in email, both need it — and a
       visible URL is the only way to check where a link goes before following
       it. */
    `<p style="font-size:13px;color:#666">Or paste this into your browser:<br>` +
    `<span style="word-break:break-all">${safeHref}</span></p>`
  );
}

export function renderVerifyEmail(context: LinkContext & { expiresInHours: number }): RenderedMail {
  const href = link(context, '/verify-email');
  const hours = String(context.expiresInHours);

  return {
    subject: 'Confirm your TaskFlow email address',
    text: textDocument([
      'Confirm your email address to finish setting up your TaskFlow account:',
      '',
      href,
      '',
      `This link works once and expires in ${hours} hours.`,
      '',
      'If you did not create a TaskFlow account, ignore this message — nothing',
      'will happen until the link is used.',
    ]),
    html: htmlDocument(
      [
        '<p>Confirm your email address to finish setting up your TaskFlow account.</p>',
        button(href, 'Confirm email address'),
        `<p style="font-size:13px;color:#666">This link works once and expires in ${hours} hours.</p>`,
        '<p style="font-size:13px;color:#666">If you did not create a TaskFlow account, ignore this message — nothing will happen until the link is used.</p>',
      ].join('\n'),
    ),
  };
}

export function renderPasswordReset(
  context: LinkContext & { expiresInMinutes: number },
): RenderedMail {
  const href = link(context, '/reset-password');
  const minutes = String(context.expiresInMinutes);

  return {
    subject: 'Reset your TaskFlow password',
    text: textDocument([
      'Someone asked to reset the password for this TaskFlow account.',
      '',
      href,
      '',
      `This link works once and expires in ${minutes} minutes.`,
      '',
      'Using it will also sign you out everywhere.',
      '',
      'If this was not you, you do not need to do anything — your password has',
      'not changed. If it keeps happening, change your password.',
    ]),
    html: htmlDocument(
      [
        '<p>Someone asked to reset the password for this TaskFlow account.</p>',
        button(href, 'Reset password'),
        `<p style="font-size:13px;color:#666">This link works once and expires in ${minutes} minutes. Using it will also sign you out everywhere.</p>`,
        '<p style="font-size:13px;color:#666">If this was not you, you do not need to do anything — your password has not changed. If it keeps happening, change your password.</p>',
      ].join('\n'),
    ),
  };
}

/**
 * Sent when someone tries to register an address that already has an account.
 *
 * The reason this message exists: registration answers identically for a taken
 * and an untaken address, so the endpoint is not an account-existence oracle.
 * The person who actually owns the address is the one party entitled to know,
 * and this is how they find out — which is also the only way a real duplicate
 * signup ever gets noticed.
 *
 * It carries NO link. There is nothing to click that would be safe: a
 * "sign in" link in an unsolicited mail is the exact shape of a phishing
 * message, and this one is triggered by a stranger.
 */
export function renderDuplicateRegistration(): RenderedMail {
  return {
    subject: 'Someone tried to sign up with your email address',
    text: textDocument([
      'Someone just tried to create a TaskFlow account with this email address,',
      'but an account already exists.',
      '',
      'No new account was created and nothing about yours has changed.',
      '',
      'If it was you, sign in as usual, or use "forgot password" if you cannot.',
      'We have deliberately not put a link in this message — go to TaskFlow the',
      'way you normally do.',
      '',
      'If it was not you, no action is needed.',
    ]),
    html: htmlDocument(
      [
        '<p>Someone just tried to create a TaskFlow account with this email address, but an account already exists.</p>',
        '<p>No new account was created and nothing about yours has changed.</p>',
        '<p>If it was you, sign in as usual, or use “forgot password” if you cannot. We have deliberately not put a link in this message — go to TaskFlow the way you normally do.</p>',
        '<p style="font-size:13px;color:#666">If it was not you, no action is needed.</p>',
      ].join('\n'),
    ),
  };
}
