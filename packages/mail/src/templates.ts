/**
 * Transactional mail bodies (PLAN.md §8.1).
 *
 * ## Every message here carries a credential or a security notice — with one
 * exception, added for Phase 9
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
 *
 * `renderNotificationEmail` (Phase 9, ai/phase-9-notifications.md §3.6) is
 * the exception: a `card.assigned` or `chat.mention` email carries no secret
 * and its link is not single-use — it is an ordinary deep link into the app,
 * gated by the recipient's own session the same way clicking it from the
 * in-app bell already is. Rule 1 (never interpolate unescaped) still applies
 * in full: `title` and `excerpt` are content someone else wrote, snapshotted
 * onto the notification row (see `platform.notifications`), and reach this
 * template exactly as caller-controlled as an email address does.
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
  /**
   * The deployment's branding (migration 0073). Defaults to `'Rinavai'`
   * when not provided.
   */
  readonly productName?: string;
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

/**
 * Wraps a body in the shared plain-text signature.
 *
 * `productName` defaults to `'Rinavai'` so every existing call site that
 * does not pass one renders byte-identical to before platform branding
 * existed. Every subject line and body sentence below reads `productName`
 * from the caller's context.
 */
function textDocument(lines: readonly string[], productName = 'Rinavai'): string {
  return [
    ...lines,
    '',
    '—',
    productName,
    'This is an automated message; replies are not read.',
  ].join('\n');
}

/**
 * Wraps a body in the shared HTML shell.
 *
 * Deliberately plain. Mail clients strip most CSS, and the more a security
 * notice looks like marketing, the more it trains people to ignore it.
 *
 * `productName` is escaped like every other caller-reachable value this
 * package renders (rule 1 in this file's header) — it comes from a
 * platform operator, not an anonymous stranger, but escaping costs
 * nothing and the alternative is one more value in this file that is
 * "probably fine" instead of provably safe.
 */
/**
 * The flow-mark logo as an inline SVG data URI. Used in email headers where
 * CSS custom properties and external image hosting are unavailable.
 * Hardcoded to the default accent (#9333ea) since email clients do not
 * support OKLCH or CSS variables.
 */
const FLOW_MARK_SVG = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'>` +
    `<path d='M8 12C8 12 12 8 16 12C20 16 24 12 24 12' stroke='#9333ea' stroke-width='2.5' stroke-linecap='round' opacity='0.5'/>` +
    `<path d='M8 20C8 20 12 16 16 20C20 24 24 20 24 20' stroke='#9333ea' stroke-width='2.5' stroke-linecap='round' opacity='0.3'/>` +
    `<circle cx='8' cy='16' r='3.5' fill='#9333ea' opacity='0.9'/>` +
    `<circle cx='16' cy='16' r='4.5' fill='#9333ea'/>` +
    `<circle cx='24' cy='16' r='5.5' fill='#9333ea' opacity='0.85'/>` +
    `<circle cx='24' cy='16' r='5.5' fill='white' opacity='0.15'/>` +
    `</svg>`,
)}`;

function htmlDocument(bodyHtml: string, productName = 'Rinavai'): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:520px">',
    /* Logo header — the flow-mark plus the product name, matching the
       login page's own BrandMark + heading layout. */
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">`,
    `<img src="${FLOW_MARK_SVG}" width="28" height="28" alt="" style="border-radius:6px" />`,
    `<span style="font-size:18px;font-weight:600;color:#1a1a1a">${escapeHtml(productName)}</span>`,
    '</div>',
    bodyHtml,
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">',
    `<p style="font-size:13px;color:#666">${escapeHtml(productName)} — this is an automated message; replies are not read.</p>`,
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
  const productName = context.productName ?? 'Rinavai';

  return {
    subject: `Confirm your ${productName} email address`,
    text: textDocument(
      [
        `Confirm your email address to finish setting up your ${productName} account:`,
        '',
        href,
        '',
        `This link works once and expires in ${hours} hours.`,
        '',
        `If you did not create a ${productName} account, ignore this message — nothing`,
        'will happen until the link is used.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>Confirm your email address to finish setting up your ${escapeHtml(productName)} account.</p>`,
        button(href, 'Confirm email address'),
        `<p style="font-size:13px;color:#666">This link works once and expires in ${hours} hours.</p>`,
        `<p style="font-size:13px;color:#666">If you did not create a ${escapeHtml(productName)} account, ignore this message — nothing will happen until the link is used.</p>`,
      ].join('\n'),
      productName,
    ),
  };
}

export function renderPasswordReset(
  context: LinkContext & { expiresInMinutes: number },
): RenderedMail {
  const href = link(context, '/reset-password');
  const minutes = String(context.expiresInMinutes);
  const productName = context.productName ?? 'Rinavai';

  return {
    subject: `Reset your ${productName} password`,
    text: textDocument(
      [
        `Someone asked to reset the password for this ${productName} account.`,
        '',
        href,
        '',
        `This link works once and expires in ${minutes} minutes.`,
        '',
        'Using it will also sign you out everywhere.',
        '',
        'If this was not you, you do not need to do anything — your password has',
        'not changed. If it keeps happening, change your password.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>Someone asked to reset the password for this ${escapeHtml(productName)} account.</p>`,
        button(href, 'Reset password'),
        `<p style="font-size:13px;color:#666">This link works once and expires in ${minutes} minutes. Using it will also sign you out everywhere.</p>`,
        '<p style="font-size:13px;color:#666">If this was not you, you do not need to do anything — your password has not changed. If it keeps happening, change your password.</p>',
      ].join('\n'),
      productName,
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
export interface NotificationLinkContext {
  /** Origin of the web app, from the validated env schema. Never from a request. */
  readonly webOrigin: string;
  /** See `LinkContext.productName`'s own comment. */
  readonly productName?: string;
}

/**
 * One notification, as an email (Phase 9, ai/phase-9-notifications.md §3.6,
 * Wave 1).
 *
 * `title` and `excerpt` are rendered from the SNAPSHOT already written onto
 * `platform.notifications` at the moment the recipient was told — never
 * re-read from the card, comment, or page — for the identical reason
 * `notification-bell.tsx` already renders from that snapshot rather than the
 * live subject: a subject can be archived, or the sender can lose access to
 * it, without erasing the record that someone was notified. Both are
 * escaped: they are content someone else wrote, not this template's own
 * copy.
 *
 * `path` is an absolute in-app path (`/boards/{boardId}?card={cardId}`,
 * `/docs?page={pageId}`, `/chat?channel={channelId}`) built by the caller —
 * this function does not know the routing rules for three different
 * products and should not need to.
 */
export function renderNotificationEmail(
  context: NotificationLinkContext & {
    readonly title: string;
    readonly excerpt: string | null;
    readonly path: string;
  },
): RenderedMail {
  const origin = context.webOrigin.replace(/\/+$/, '');
  const href = `${origin}${context.path}`;
  const productName = context.productName ?? 'Rinavai';

  return {
    subject: context.title,
    text: textDocument(
      [
        context.title,
        ...(context.excerpt === null ? [] : ['', `"${context.excerpt}"`]),
        '',
        href,
        '',
        'Turn these off or change how you get them in Notification settings.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p><strong>${escapeHtml(context.title)}</strong>${
          context.excerpt === null
            ? ''
            : `<br><span style="color:#444">${escapeHtml(context.excerpt)}</span>`
        }</p>`,
        button(href, `Open in ${productName}`),
        '<p style="font-size:13px;color:#666">Turn these off or change how you get them in Notification settings.</p>',
      ].join('\n'),
      productName,
    ),
  };
}

/**
 * One digest covering several notifications (Phase 9 Wave 2,
 * ai/phase-9-notifications.md §3.4).
 *
 * A digest is a batching of the EMAIL channel's delivery — the
 * `platform.notifications` rows were written the moment they happened, and
 * this is a single email that collects the ones that waited for it. Every
 * item renders from the SNAPSHOT stored on the notification row at the time
 * the recipient was told, for the identical reason `renderNotificationEmail`
 * gives — a subject can be archived or a sender lose access without erasing
 * the record that someone was notified.
 *
 * Each item carries its own `path` (an absolute in-app route, built by the
 * caller — this function does not know three products' routing rules), and
 * each is escaped the same way the single-notification email escapes its
 * title and excerpt: they are content someone else wrote.
 */
export function renderNotificationDigest(
  context: NotificationLinkContext & {
    readonly items: readonly {
      readonly title: string;
      readonly excerpt: string | null;
      readonly path: string;
    }[];
  },
): RenderedMail {
  const origin = context.webOrigin.replace(/\/+$/, '');
  const productName = context.productName ?? 'Rinavai';

  const textLines: string[] = [`You have activity waiting in ${productName}:`, ''];
  context.items.forEach((item, index) => {
    textLines.push(`${String(index + 1)}. ${item.title}`);
    if (item.excerpt !== null) textLines.push(`   "${item.excerpt}"`);
    textLines.push(`   ${origin}${item.path}`);
  });
  textLines.push('', 'Turn these off or change how you get them in Notification settings.');

  const itemsHtml = context.items
    .map(
      (item) =>
        `<li style="margin-bottom:12px">` +
        `<strong>${escapeHtml(item.title)}</strong>` +
        (item.excerpt === null
          ? ''
          : `<br><span style="color:#444">${escapeHtml(item.excerpt)}</span>`) +
        `<br><a href="${escapeHtml(`${origin}${item.path}`)}" style="color:#1a1a1a">Open in ${escapeHtml(productName)}</a>` +
        `</li>`,
    )
    .join('');

  const countLabel =
    context.items.length === 1 ? '1 update' : `${String(context.items.length)} updates`;

  return {
    subject: `${countLabel} for you on ${productName}`,
    text: textDocument(textLines, productName),
    html: htmlDocument(
      [
        `<p><strong>${escapeHtml(countLabel)} for you on ${escapeHtml(productName)}</strong></p>`,
        `<ol style="padding-left:20px;margin:12px 0">${itemsHtml}</ol>`,
        '<p style="font-size:13px;color:#666">Turn these off or change how you get them in Notification settings.</p>',
      ].join('\n'),
      productName,
    ),
  };
}

/**
 * Sent when a login is flagged for impossible travel (Phase 12 Wave 2,
 * `identity/identity.service.ts`'s `issueSession`).
 *
 * Carries no link, for the identical reason `renderDuplicateRegistration`
 * carries none: this message can be triggered by an attacker who has the
 * account's password, and a "secure your account" link in an unsolicited
 * mail is exactly the shape of a phishing message. The one actionable
 * instruction is to go reset the password the way the recipient normally
 * would, not to follow anything this message provides.
 *
 * `previousCountry`/`newCountry` are ISO country codes read off the session
 * rows (`identity.sessions.country`) — informational text, not a credential,
 * but still escaped like every other caller-reachable value this package
 * renders (rule 1 in this file's header).
 */
export function renderImpossibleTravel(context: {
  readonly previousCountry: string;
  readonly newCountry: string;
  readonly productName?: string;
}): RenderedMail {
  const previous = escapeHtml(context.previousCountry);
  const next = escapeHtml(context.newCountry);
  const productName = context.productName ?? 'Rinavai';

  return {
    subject: 'New sign-in from an unusual location',
    text: textDocument(
      [
        `Your ${productName} account was just signed in to from ${context.newCountry}, shortly`,
        `after a sign-in from ${context.previousCountry} — too soon for the same person to`,
        'have traveled between them.',
        '',
        'If this was you (a VPN, a trip, a new device), no action is needed.',
        '',
        'If it was not you, change your password now and sign out your other',
        'sessions from Settings — do not use a link from this message, go to',
        `${productName} the way you normally do.`,
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>Your ${escapeHtml(productName)} account was just signed in to from ${next}, shortly after a sign-in from ${previous} — too soon for the same person to have traveled between them.</p>`,
        '<p>If this was you (a VPN, a trip, a new device), no action is needed.</p>',
        `<p style="font-size:13px;color:#666">If it was not you, change your password now and sign out your other sessions from Settings — do not use a link from this message, go to ${escapeHtml(productName)} the way you normally do.</p>`,
      ].join('\n'),
      productName,
    ),
  };
}

/**
 * Sent to an org's owner when a platform operator suspends or deletes it
 * (Phase 12 Wave 1/Wave 2, `platform-admin/org-directory.service.ts`).
 *
 * Carries no link — unlike an ordinary notification email, there is nothing
 * left to click: a suspended org's owner cannot open it (`resolveOrgMembership`
 * refuses every route the moment `status` flips), and a deleted org no
 * longer exists to link to at all.
 */
export function renderOrgSuspended(context: {
  readonly orgName: string;
  readonly productName?: string;
}): RenderedMail {
  const org = escapeHtml(context.orgName);
  const productName = context.productName ?? 'Rinavai';

  return {
    subject: `${context.orgName} has been suspended`,
    text: textDocument(
      [
        `${context.orgName} has been suspended by a ${productName} platform operator.`,
        '',
        'Nobody can sign in to it or access its data while it is suspended. This',
        'does not delete anything — the organization can be reactivated.',
        '',
        'If you believe this is a mistake, contact support.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>${org} has been suspended by a ${escapeHtml(productName)} platform operator.</p>`,
        '<p>Nobody can sign in to it or access its data while it is suspended. This does not delete anything — the organization can be reactivated.</p>',
        '<p style="font-size:13px;color:#666">If you believe this is a mistake, contact support.</p>',
      ].join('\n'),
      productName,
    ),
  };
}

export function renderOrgDeleted(context: {
  readonly orgName: string;
  readonly productName?: string;
}): RenderedMail {
  const org = escapeHtml(context.orgName);
  const productName = context.productName ?? 'Rinavai';

  return {
    subject: `${context.orgName} has been deleted`,
    text: textDocument(
      [
        `${context.orgName} has been permanently deleted by a ${productName} platform`,
        'operator. Every project, message, document and file it contained is',
        'gone and cannot be recovered.',
        '',
        'If you believe this is a mistake, contact support immediately.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>${org} has been permanently deleted by a ${escapeHtml(productName)} platform operator. Every project, message, document and file it contained is gone and cannot be recovered.</p>`,
        '<p style="font-size:13px;color:#666">If you believe this is a mistake, contact support immediately.</p>',
      ].join('\n'),
      productName,
    ),
  };
}

/**
 * Sent when a password reset actually completes (`identity/identity.service.ts`'s
 * `resetPassword`). Not the reset LINK — the confirmation that it was used.
 *
 * Carries no link, the same reasoning as `renderImpossibleTravel`: whoever
 * used the link just proved they control the account by the definition this
 * system uses, but that "whoever" is exactly who this message needs to
 * reach if it was an attacker rather than the real owner.
 */
export function renderPasswordChanged(context?: { readonly productName?: string }): RenderedMail {
  const productName = context?.productName ?? 'Rinavai';

  return {
    subject: `Your ${productName} password was changed`,
    text: textDocument(
      [
        `Your ${productName} password was just changed, and every other session was`,
        'signed out.',
        '',
        'If this was you, no action is needed.',
        '',
        'If it was not you, someone else may have access to your account. Go to',
        `${productName} the way you normally do and use "forgot password" again to`,
        'regain control — do not use a link from this message.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>Your ${escapeHtml(productName)} password was just changed, and every other session was signed out.</p>`,
        '<p>If this was you, no action is needed.</p>',
        `<p style="font-size:13px;color:#666">If it was not you, someone else may have access to your account. Go to ${escapeHtml(productName)} the way you normally do and use "forgot password" again to regain control — do not use a link from this message.</p>`,
      ].join('\n'),
      productName,
    ),
  };
}

/** Sent when TOTP two-factor is enabled on an account. */
export function renderTotpEnabled(context?: { readonly productName?: string }): RenderedMail {
  const productName = context?.productName ?? 'Rinavai';

  return {
    subject: `Two-factor authentication was enabled on your ${productName} account`,
    text: textDocument(
      [
        'Two-factor authentication (an authenticator app) was just enabled on',
        `your ${productName} account.`,
        '',
        'If this was you, no action is needed.',
        '',
        `If it was not you, go to ${productName} the way you normally do and change`,
        'your password — do not use a link from this message.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>Two-factor authentication (an authenticator app) was just enabled on your ${escapeHtml(productName)} account.</p>`,
        '<p>If this was you, no action is needed.</p>',
        `<p style="font-size:13px;color:#666">If it was not you, go to ${escapeHtml(productName)} the way you normally do and change your password — do not use a link from this message.</p>`,
      ].join('\n'),
      productName,
    ),
  };
}

/** Sent when a new passkey is registered on an account. */
export function renderPasskeyRegistered(context?: { readonly productName?: string }): RenderedMail {
  const productName = context?.productName ?? 'Rinavai';

  return {
    subject: `A new passkey was added to your ${productName} account`,
    text: textDocument(
      [
        `A new passkey was just registered on your ${productName} account.`,
        '',
        'If this was you, no action is needed.',
        '',
        `If it was not you, go to ${productName} the way you normally do, remove the`,
        'passkey you do not recognize, and change your password — do not use a',
        'link from this message.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>A new passkey was just registered on your ${escapeHtml(productName)} account.</p>`,
        '<p>If this was you, no action is needed.</p>',
        `<p style="font-size:13px;color:#666">If it was not you, go to ${escapeHtml(productName)} the way you normally do, remove the passkey you do not recognize, and change your password — do not use a link from this message.</p>`,
      ].join('\n'),
      productName,
    ),
  };
}

export function renderDuplicateRegistration(context?: {
  readonly productName?: string;
}): RenderedMail {
  const productName = context?.productName ?? 'Rinavai';

  return {
    subject: 'Someone tried to sign up with your email address',
    text: textDocument(
      [
        `Someone just tried to create a ${productName} account with this email address,`,
        'but an account already exists.',
        '',
        'No new account was created and nothing about yours has changed.',
        '',
        'If it was you, sign in as usual, or use "forgot password" if you cannot.',
        `We have deliberately not put a link in this message — go to ${productName} the`,
        'way you normally do.',
        '',
        'If it was not you, no action is needed.',
      ],
      productName,
    ),
    html: htmlDocument(
      [
        `<p>Someone just tried to create a ${escapeHtml(productName)} account with this email address, but an account already exists.</p>`,
        '<p>No new account was created and nothing about yours has changed.</p>',
        '<p>If it was you, sign in as usual, or use “forgot password” if you cannot. We have deliberately not put a link in this message — go to  the way you normally do.</p>',
        '<p style="font-size:13px;color:#666">If it was not you, no action is needed.</p>',
      ].join('\n'),
      productName,
    ),
  };
}
