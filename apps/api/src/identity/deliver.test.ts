import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { MemoryMailer } from '@taskflow/mail';
import { buildServer } from '../server.js';
import { TEST_ENV } from '../testing/fixtures.js';

/** Every fixed email this file registers — see the note on `afterAll` below. */
const FIXTURE_EMAILS = [
  'deliver-verify@example.test',
  'deliver-roundtrip@example.test',
  'deliver-duplicate@example.test',
  'deliver-reset@example.test',
];

/**
 * The seam between the identity service and outbound mail (PLAN.md §8.1).
 *
 * Every other suite injects `deliver` and reads the token straight out of the
 * callback, which is convenient and bypasses the templates entirely. This one
 * injects only the TRANSPORT, so the real rendering runs — the failure it exists
 * to catch is a link that is well-formed in the service and malformed by the
 * time it reaches an inbox.
 */

let app: FastifyInstance;
let admin: AdminConnection;
const mailer = new MemoryMailer();

/**
 * Deletes this file's own fixture users, scoped to its own fixed addresses —
 * never a whole-table wipe, for the reason `identity.service.test.ts`'s own
 * cleanup gives: `taskflow_test` is shared across every package's suite, so an
 * unscoped delete would race a concurrently-running one.
 *
 * Run before the tests, not only after. A registration answers identically for
 * an address that already exists ("Someone tried to sign up with your email
 * address") and a fresh one, which is the correct anti-enumeration behaviour —
 * and also means a row an ABORTED previous run left behind (skipping this
 * file's own `afterAll`) makes every assertion below fail as if registration
 * itself were broken, not as what it is: stale fixture data from a run that
 * never finished.
 */
async function cleanupFixtures(): Promise<void> {
  await admin.query(`DELETE FROM identity.users WHERE email = ANY($1::text[])`, [FIXTURE_EMAILS]);
}

beforeAll(async () => {
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'deliver-test' });
  admin = await connectAsMigrator();
  await cleanupFixtures();
  app = await buildServer({ env: TEST_ENV, mailer });
});

afterAll(async () => {
  // Closing the server drains the queue, which is what makes the assertions
  // below deterministic rather than racing the background sender.
  await app.close();
  await cleanupFixtures();
  await admin.end();
  await closeDatabase();
});

async function register(email: string): Promise<void> {
  await app.inject({
    method: 'POST',
    url: '/trpc/auth.register',
    payload: { email, password: 'correct horse battery staple 42', name: 'Test User' },
  });
}

async function settle(): Promise<void> {
  // The queue sends on a microtask; nothing in a request awaits it, by design.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('verification mail', () => {
  it('renders a usable link through the real template', async () => {
    const email = 'deliver-verify@example.test';
    await register(email);
    await settle();

    const sent = mailer.sent.find((message) => message.to === email);
    expect(sent).toBeDefined();
    expect(sent?.subject).toMatch(/Confirm/);

    // The link the user actually receives, built from WEB_ORIGIN rather than
    // from anything in the request.
    const match = /http:\/\/localhost:5173\/verify-email\?token=([^\s<"]+)/.exec(sent?.text ?? '');
    expect(match?.[1]).toBeDefined();
  });

  it('sends a link that verifies the account', async () => {
    /* The end-to-end property: a token that survives rendering, percent-encoding
       and extraction is still the token the database will accept. An encoding
       bug here produces mail that looks perfect and links that do not work. */
    const email = 'deliver-roundtrip@example.test';
    await register(email);
    await settle();

    const sent = mailer.sent.find((message) => message.to === email);
    const raw = /verify-email\?token=([^\s<"]+)/.exec(sent?.text ?? '')?.[1] ?? '';
    const token = decodeURIComponent(raw);

    const response = await app.inject({
      method: 'POST',
      url: '/trpc/auth.verifyEmail',
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('duplicate registration', () => {
  it('notifies the owner without sending them a link', async () => {
    /* Registration answers identically for a taken and an untaken address, so
       the endpoint is not an account-existence oracle. The owner is the one
       party entitled to know, and this mail is how they find out — carrying no
       link, because it is triggered by a stranger. */
    const email = 'deliver-duplicate@example.test';
    await register(email);
    await settle();

    const before = mailer.sent.length;
    await register(email);
    await settle();

    const notice = mailer.sent.slice(before).find((message) => message.to === email);
    expect(notice?.subject).toMatch(/tried to sign up/);
    expect(notice?.text).not.toMatch(/https?:\/\//);
  });
});

describe('password reset', () => {
  it('sends nothing at all for an address with no account', async () => {
    /* The timing property, stated as a delivery property because timing is not
       reliably assertable in a test: the unknown-address path must not reach the
       mailer. If sending were inline rather than queued, the two paths would
       differ by however long SMTP takes — a completely reliable remote oracle
       behind an endpoint designed to answer identically either way. */
    const before = mailer.sent.length;

    await app.inject({
      method: 'POST',
      url: '/trpc/auth.requestPasswordReset',
      payload: { email: 'nobody-at-all@example.test' },
    });
    await settle();

    expect(mailer.sent.length).toBe(before);
  });

  it('sends a reset link for an address that has one', async () => {
    const email = 'deliver-reset@example.test';
    await register(email);
    await settle();

    const verifyMail = mailer.sent.find((message) => message.to === email);
    const verifyToken = decodeURIComponent(
      /verify-email\?token=([^\s<"]+)/.exec(verifyMail?.text ?? '')?.[1] ?? '',
    );
    await app.inject({
      method: 'POST',
      url: '/trpc/auth.verifyEmail',
      payload: { token: verifyToken },
    });

    await app.inject({
      method: 'POST',
      url: '/trpc/auth.requestPasswordReset',
      payload: { email },
    });
    await settle();

    const reset = mailer.sent.filter((message) => message.to === email).at(-1);
    expect(reset?.subject).toMatch(/Reset your Rinavai password/);
    expect(reset?.text).toMatch(/reset-password\?token=/);
  });
});
