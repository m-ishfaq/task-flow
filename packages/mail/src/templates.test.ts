import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderDuplicateRegistration,
  renderImpossibleTravel,
  renderNotificationDigest,
  renderOrgDeleted,
  renderOrgSuspended,
  renderPasskeyRegistered,
  renderPasswordChanged,
  renderPasswordReset,
  renderTotpEnabled,
  renderVerifyEmail,
} from './templates.js';

/**
 * Mail bodies (PLAN.md §8.1).
 *
 * These carry credentials, so the assertions are about disclosure and escaping
 * rather than about wording.
 */

const CONTEXT = { webOrigin: 'http://localhost:5173', token: 'tf_ev_abc123' };

describe('escapeHtml', () => {
  it('escapes the characters that break out of an attribute', () => {
    // Escaping only < and > is the common half-measure: a single quote character
    // still escapes `href="..."` and adds an attribute of the author's choosing.
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    );
  });

  it('escapes the ampersand first', () => {
    // Otherwise `&lt;` produced by an earlier replacement is re-escaped into
    // `&amp;lt;` and the output is double-encoded.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderVerifyEmail', () => {
  it('puts the link in both the text and the HTML body', () => {
    // Plain text is not a courtesy: a client that renders only text and finds no
    // link leaves the user with an account they cannot activate.
    const mail = renderVerifyEmail({ ...CONTEXT, expiresInHours: 24 });

    expect(mail.text).toContain('http://localhost:5173/verify-email?token=tf_ev_abc123');
    expect(mail.html).toContain('http://localhost:5173/verify-email?token=tf_ev_abc123');
  });

  it('says the link expires', () => {
    const mail = renderVerifyEmail({ ...CONTEXT, expiresInHours: 24 });
    expect(mail.text).toMatch(/expires in 24 hours/);
  });

  it('does not accuse the recipient of anything', () => {
    // The recipient may not have asked for this — anyone can type an address
    // into a signup form. The message has to work for a bystander.
    const mail = renderVerifyEmail({ ...CONTEXT, expiresInHours: 24 });
    expect(mail.text).toMatch(/If you did not create/);
  });

  it('tolerates a trailing slash on the origin', () => {
    const mail = renderVerifyEmail({
      webOrigin: 'http://localhost:5173/',
      token: 'abc',
      expiresInHours: 24,
    });

    expect(mail.text).toContain('http://localhost:5173/verify-email?token=abc');
    expect(mail.text).not.toContain('5173//verify-email');
  });

  it('encodes a token containing URL metacharacters', () => {
    // Insurance against a future token alphabet. A link broken by an unencoded
    // character cannot be fixed retroactively — the mail has already been sent.
    const mail = renderVerifyEmail({
      ...CONTEXT,
      token: 'a b&c=d#e',
      expiresInHours: 24,
    });

    expect(mail.text).toContain('token=a%20b%26c%3Dd%23e');
  });

  it('does not put a raw quote into the HTML href', () => {
    const mail = renderVerifyEmail({
      ...CONTEXT,
      token: 'x"onmouseover="alert(1)',
      expiresInHours: 24,
    });

    expect(mail.html).not.toContain('onmouseover="alert(1)');
    expect(mail.html).not.toMatch(/href="[^"]*"[^>]*onmouseover/);
  });
});

describe('renderPasswordReset', () => {
  it('warns that the link revokes every session', () => {
    // A user who does not expect it reads "signed out everywhere" as a second
    // compromise rather than as the reset working.
    const mail = renderPasswordReset({ ...CONTEXT, expiresInMinutes: 60 });
    expect(mail.text).toMatch(/sign you out everywhere/);
  });

  it('tells a recipient who did not request it that nothing has changed', () => {
    const mail = renderPasswordReset({ ...CONTEXT, expiresInMinutes: 60 });
    expect(mail.text).toMatch(/your password has\s*\n?\s*not changed/);
  });

  it('states the shorter expiry', () => {
    const mail = renderPasswordReset({ ...CONTEXT, expiresInMinutes: 60 });
    expect(mail.text).toMatch(/expires in 60 minutes/);
  });
});

describe('renderNotificationDigest', () => {
  const items = [
    {
      title: 'Mentioned in #general',
      excerpt: 'ping @bob',
      path: '/chat?channel=0195ee05-0000-7000-8000-000000000020',
    },
    {
      title: 'Card due soon: Ship the launch page',
      excerpt: null,
      path: '/boards/0195ee05-0000-7000-8000-000000000031?card=0195ee05-0000-7000-8000-000000000030',
    },
  ];

  it('names the count in the subject', () => {
    expect(renderNotificationDigest({ webOrigin: 'http://localhost:5173', items }).subject).toBe(
      '2 updates for you on TaskFlow',
    );
    expect(
      renderNotificationDigest({
        webOrigin: 'http://localhost:5173',
        items: [items[0]!],
      }).subject,
    ).toBe('1 update for you on TaskFlow');
  });

  it('includes every item with its own link, in text and HTML', () => {
    const mail = renderNotificationDigest({ webOrigin: 'http://localhost:5173', items });

    expect(mail.text).toContain('1. Mentioned in #general');
    expect(mail.text).toContain('http://localhost:5173/chat?channel=0195ee05');
    expect(mail.text).toContain('2. Card due soon: Ship the launch page');
    expect(mail.html).toContain('Mentioned in #general');
    expect(mail.html).toContain('Open in TaskFlow');
  });

  it('escapes item content the same way the single email does', () => {
    const mail = renderNotificationDigest({
      webOrigin: 'http://localhost:5173',
      items: [{ title: '<script>alert(1)</script>', excerpt: '" onmouseover="x', path: '/chat' }],
    });

    expect(mail.html).not.toContain('<script>alert');
    // The quote is what breaks out of an attribute; escaped text containing the
    // words is fine, an unescaped `onmouseover="` is not.
    expect(mail.html).not.toContain('onmouseover="');
  });

  it('tolerates a trailing slash on the origin', () => {
    const mail = renderNotificationDigest({ webOrigin: 'http://localhost:5173/', items });
    expect(mail.text).not.toContain('5173//chat');
  });
});

describe('renderImpossibleTravel', () => {
  const CONTEXT = { previousCountry: 'US', newCountry: 'RU' };

  it('names both countries', () => {
    const mail = renderImpossibleTravel(CONTEXT);
    expect(mail.text).toContain('RU');
    expect(mail.text).toContain('US');
    expect(mail.html).toContain('RU');
    expect(mail.html).toContain('US');
  });

  it('carries no link — an unsolicited "secure your account" link is a phishing shape', () => {
    const mail = renderImpossibleTravel(CONTEXT);
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
    expect(mail.html).not.toContain('href');
  });

  it('tells someone who was not affected that no action is needed', () => {
    const mail = renderImpossibleTravel(CONTEXT);
    expect(mail.text).toMatch(/If this was you.*no action is needed/s);
  });

  it('escapes the country codes', () => {
    const mail = renderImpossibleTravel({
      previousCountry: 'US',
      newCountry: '<script>alert(1)</script>',
    });
    expect(mail.html).not.toContain('<script>alert');
  });
});

describe('renderOrgSuspended', () => {
  it('names the org and says nothing was deleted', () => {
    const mail = renderOrgSuspended({ orgName: 'Acme' });
    expect(mail.subject).toContain('Acme');
    expect(mail.text).toMatch(/does not delete anything/);
  });

  it('carries no link — a suspended owner has nowhere left to click through to', () => {
    const mail = renderOrgSuspended({ orgName: 'Acme' });
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
  });

  it('escapes the org name', () => {
    const mail = renderOrgSuspended({ orgName: '<script>alert(1)</script>' });
    expect(mail.html).not.toContain('<script>alert');
  });
});

describe('renderOrgDeleted', () => {
  it('names the org and says the data is gone', () => {
    const mail = renderOrgDeleted({ orgName: 'Acme' });
    expect(mail.subject).toContain('Acme');
    expect(mail.text).toMatch(/cannot be recovered/);
  });

  it('carries no link — nothing left to link to', () => {
    const mail = renderOrgDeleted({ orgName: 'Acme' });
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
  });

  it('escapes the org name', () => {
    const mail = renderOrgDeleted({ orgName: '<script>alert(1)</script>' });
    expect(mail.html).not.toContain('<script>alert');
  });
});

describe('renderPasswordChanged', () => {
  it('tells someone who did not request it that their account may be compromised', () => {
    const mail = renderPasswordChanged();
    expect(mail.text).toMatch(/someone else may have access/);
  });

  it('says every other session was signed out', () => {
    const mail = renderPasswordChanged();
    expect(mail.text).toMatch(/signed out/);
  });

  it('carries no link', () => {
    const mail = renderPasswordChanged();
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
  });
});

describe('renderTotpEnabled', () => {
  it('tells someone who did not enable it what to do', () => {
    const mail = renderTotpEnabled();
    expect(mail.text).toMatch(/go to TaskFlow.*change\s*\n?\s*your password/);
  });

  it('carries no link', () => {
    const mail = renderTotpEnabled();
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
  });
});

describe('renderPasskeyRegistered', () => {
  it('tells someone who did not register it to remove it', () => {
    const mail = renderPasskeyRegistered();
    expect(mail.text).toMatch(/remove the/);
  });

  it('carries no link', () => {
    const mail = renderPasskeyRegistered();
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
  });
});

describe('renderDuplicateRegistration', () => {
  it('carries no link at all', () => {
    /* The message is triggered by a STRANGER typing someone's address into a
       signup form. A clickable link in an unsolicited mail is the exact shape of
       a phishing message, and training users to follow one is worse than the
       inconvenience of asking them to navigate themselves. */
    const mail = renderDuplicateRegistration();

    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toContain('<a ');
    expect(mail.html).not.toContain('href');
  });

  it('confirms nothing beyond the attempt', () => {
    const mail = renderDuplicateRegistration();
    expect(mail.text).toMatch(/No new account was created/);
  });
});

describe('the branded footer', () => {
  /* Every render function threads `productName` through to the shared
     `textDocument`/`htmlDocument` footer — this exercises the three
     distinct signature shapes the render functions actually have
     (a `LinkContext`-based context, an inline object context, and no
     context at all) rather than re-testing the same two helper functions
     eleven times over. Only the FOOTER is branded in v1 (templates.ts's
     own header on `textDocument`); subject lines and body copy keep
     "TaskFlow" regardless of what's asserted here. */

  it('defaults the footer to TaskFlow when no productName is given', () => {
    expect(renderVerifyEmail({ ...CONTEXT, expiresInHours: 24 }).text).toMatch(/\n—\nTaskFlow\n/);
    expect(renderPasswordChanged().text).toMatch(/\n—\nTaskFlow\n/);
    expect(renderOrgSuspended({ orgName: 'Acme' }).text).toMatch(/\n—\nTaskFlow\n/);
  });

  it('uses the given productName in the text footer, for all three context shapes', () => {
    expect(
      renderVerifyEmail({ ...CONTEXT, expiresInHours: 24, productName: 'Acme Flow' }).text,
    ).toMatch(/\n—\nAcme Flow\n/);
    expect(renderPasswordChanged({ productName: 'Acme Flow' }).text).toMatch(/\n—\nAcme Flow\n/);
    expect(renderOrgSuspended({ orgName: 'Acme', productName: 'Acme Flow' }).text).toMatch(
      /\n—\nAcme Flow\n/,
    );
  });

  it('uses the given productName in the HTML footer too', () => {
    const mail = renderVerifyEmail({ ...CONTEXT, expiresInHours: 24, productName: 'Acme Flow' });
    expect(mail.html).toContain('Acme Flow — this is an automated message');
  });

  it('escapes productName in the HTML footer', () => {
    const mail = renderVerifyEmail({
      ...CONTEXT,
      expiresInHours: 24,
      productName: '<script>alert(1)</script>',
    });
    expect(mail.html).not.toContain('<script>alert');
  });

  it('never touches the subject line or body copy — v1 scope is the footer only', () => {
    const mail = renderVerifyEmail({ ...CONTEXT, expiresInHours: 24, productName: 'Acme Flow' });
    expect(mail.subject).toBe('Confirm your TaskFlow email address');
    expect(mail.text).toMatch(/finish setting up your TaskFlow account/);
  });
});
