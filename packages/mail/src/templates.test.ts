import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderDuplicateRegistration,
  renderPasswordReset,
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
