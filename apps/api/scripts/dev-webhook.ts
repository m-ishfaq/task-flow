/**
 * Dev-only: POST a correctly SIGNED carrier webhook at this instance.
 *
 * ## Why this exists
 *
 * `FakeTelephonyProvider` covers everything the application asks the carrier to
 * do, and nothing the carrier asks the application to do. Call progress,
 * delivery receipts, inbound SMS, STOP, recording-ready — all of those arrive as
 * webhooks, so with the fake in place a call sits at `queued` forever and
 * `actual_cents` never reconciles. This script is the missing half.
 *
 * It signs with `signTwilioRequest` from `@taskflow/security` — the SAME
 * function `verifyTwilioSignature` computes its comparison from — so the
 * server's verification runs for real. Nothing here weakens or bypasses a
 * control: the signature is genuine, the replay nonce is committed exactly as
 * it would be for Twilio's own POST, and a payload signed with the wrong token
 * is refused. That is the point. A dev tool that stubbed the check would let
 * every webhook test assert the handler works on trusted input, which is the
 * one case it is not defending against.
 *
 * The auth token it signs with is the org's own stored subaccount credential,
 * decrypted through the app's key provider — the same value the server will
 * verify against, obtained the same way. So this proves the whole chain
 * (AccountSid -> org lookup -> token decrypt -> HMAC) and not just the handler.
 *
 * ## Usage
 *
 *   pnpm --filter @taskflow/api exec tsx scripts/dev-webhook.ts <kind> --org <orgId> [options]
 *
 *   sms              Inbound SMS. Auto-targets the org's first phone number.
 *                    --from <e164>   sender (default +447848140877)
 *                    --body <text>   message body (default "Hello from dev-webhook")
 *                    Send --body STOP to exercise the suppression list.
 *
 *   call-status      Call progress. Auto-targets the org's most recent call.
 *                    --status <s>    queued|ringing|in-progress|completed|failed
 *                                    (default completed)
 *                    --duration <n>  seconds (default 42)
 *
 *   message-status   Delivery receipt. Auto-targets the most recent SMS.
 *                    --status <s>    sent|delivered|undelivered|failed
 *                                    (default delivered)
 *
 * NOT part of the app. Nothing in `src` imports it, and `eslint src` never sees
 * it. It reads the repo `.env` directly rather than the validated schema
 * (guardrail 3 governs the server, not a developer's one-off client) — it is a
 * CLIENT of this API, standing in for Twilio, and Twilio does not import our
 * env parser either.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * Environment, before anything that reads it is imported
 * ------------------------------------------------------------------ */

function loadDotEnv(): void {
  let dir = process.cwd();
  for (let hops = 0; hops < 8; hops += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (match === null) continue;
        const [, key, raw] = match;
        if (key === undefined || raw === undefined) continue;
        /* Do not clobber a variable the caller exported deliberately. */
        if (process.env[key] === undefined) {
          process.env[key] = raw.replace(/^["']|["']$/g, '');
        }
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not find a .env walking up from ' + process.cwd());
}

loadDotEnv();

/* Imported dynamically so `loadDotEnv` has already run — a static import is
   hoisted above it, and `@taskflow/db` reads its connection string on load. */
const { initializeDatabase, withOrgScope, schema, eq, desc } = await import('@taskflow/db');

/* The pool is a boot-time singleton the server normally creates in main.ts.
   This script is its own process, so it opens one itself — as `taskflow_app`,
   the same RLS-bound role the server uses, never the migrator. A dev tool that
   reached past RLS to read a token would be a different tool than the one
   whose output we are trusting. */
initializeDatabase({
  url: process.env['DATABASE_URL'] ?? '',
  maxConnections: 2,
  applicationName: 'taskflow-dev-webhook',
});
const { SoftwareKeyProvider, signTwilioRequest } = await import('@taskflow/security');
const { loadSubaccount, loadSubaccountAuthToken } = await import(
  '../src/telephony/subaccount.service.js'
);

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const kind = argv[0];

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function die(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const KINDS = ['sms', 'call-status', 'message-status'] as const;
type Kind = (typeof KINDS)[number];

if (kind === undefined || !KINDS.includes(kind as Kind)) {
  die(`Usage: tsx scripts/dev-webhook.ts <${KINDS.join('|')}> --org <orgId> [options]`);
}

const orgIdRaw = flag('org');
if (orgIdRaw === undefined) {
  die('--org <orgId> is required. It is the org whose subaccount signs the payload.');
}
const orgId = orgIdRaw as Parameters<typeof loadSubaccount>[0];

const origin = process.env['TELEPHONY_WEBHOOK_ORIGIN'];
if (origin === undefined || origin.length === 0) {
  die('TELEPHONY_WEBHOOK_ORIGIN is not set in .env — that is the origin the URL is signed against.');
}

/* ------------------------------------------------------------------ *
 * The org's carrier identity
 * ------------------------------------------------------------------ */

const subaccount = await loadSubaccount(orgId);
if (subaccount === undefined) {
  die(
    `No comms.subaccounts row for org ${orgId}. Open /calls in the app once — any ` +
      'telephony call provisions the subaccount — then run this again.',
  );
}

const keys = new SoftwareKeyProvider({
  currentMasterKeyId: process.env['MASTER_KEY_ID'] ?? '',
  masterKeys: [
    {
      id: process.env['MASTER_KEY_ID'] ?? '',
      key: new Uint8Array(Buffer.from(process.env['MASTER_KEY_BASE64'] ?? '', 'base64')),
    },
  ],
});

const authToken = await loadSubaccountAuthToken(orgId, keys);
if (authToken === undefined) {
  die(`Could not decrypt the stored auth token for org ${orgId}.`);
}

/* ------------------------------------------------------------------ *
 * Build the request for the requested kind
 * ------------------------------------------------------------------ */

/** Every payload carries AccountSid — it is how the handler finds the org. */
const base = { AccountSid: subaccount.subaccountSid };

let path: string;
let params: Record<string, string>;

if (kind === 'sms') {
  const number = await withOrgScope(orgId, async (tx) =>
    tx
      .select({ id: schema.phoneNumbers.id, e164: schema.phoneNumbers.e164 })
      .from(schema.phoneNumbers)
      .limit(1)
      .then((rows) => rows[0]),
  );
  if (number === undefined) {
    die('This org owns no phone number. Buy one in /calls (the fake provider sells them free).');
  }

  path = `/telephony/sms/${number.id}`;
  params = {
    ...base,
    From: flag('from') ?? '+447848140877',
    To: number.e164,
    Body: flag('body') ?? 'Hello from dev-webhook',
    MessageSid: `SM${Date.now().toString(16).padStart(32, '0').slice(-32)}`,
  };
} else if (kind === 'call-status') {
  const call = await withOrgScope(orgId, async (tx) =>
    tx
      .select({ id: schema.calls.id, providerSid: schema.calls.providerSid })
      .from(schema.calls)
      .orderBy(desc(schema.calls.createdAt))
      .limit(1)
      .then((rows) => rows[0]),
  );
  if (call === undefined) die('This org has placed no calls yet. Place one from /calls first.');

  path = `/telephony/status/${call.id}`;
  params = {
    ...base,
    CallSid: call.providerSid ?? '',
    CallStatus: flag('status') ?? 'completed',
    CallDuration: flag('duration') ?? '42',
  };
} else {
  const message = await withOrgScope(orgId, async (tx) =>
    tx
      .select({ id: schema.smsMessages.id, providerSid: schema.smsMessages.providerSid })
      .from(schema.smsMessages)
      .where(eq(schema.smsMessages.direction, 'outbound'))
      .orderBy(desc(schema.smsMessages.createdAt))
      .limit(1)
      .then((rows) => rows[0]),
  );
  if (message === undefined) die('This org has sent no SMS yet. Send one from /calls first.');

  path = `/telephony/message-status/${message.id}`;
  params = {
    ...base,
    MessageSid: message.providerSid ?? '',
    MessageStatus: flag('status') ?? 'delivered',
  };
}

/* ------------------------------------------------------------------ *
 * Sign and send
 * ------------------------------------------------------------------ */

/* The URL must be byte-identical to the one signed — that is the whole
   contract, and it is why the origin comes from configuration rather than
   being rebuilt from the response. */
const url = `${origin.replace(/\/$/, '')}${path}`;
const signature = signTwilioRequest({ url, params, authToken });

console.log(`\n  POST ${url}`);
for (const [key, value] of Object.entries(params)) {
  console.log(`       ${key} = ${value}`);
}

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    'X-Twilio-Signature': signature,
  },
  body: new URLSearchParams(params).toString(),
});

const text = await response.text();
console.log(`\n  -> ${String(response.status)} ${response.statusText}`);
if (text.length > 0) console.log(`     ${text.slice(0, 300)}`);

if (response.status === 403) {
  console.log(
    '\n  403 means the signature was refused. The usual cause is TELEPHONY_WEBHOOK_ORIGIN\n' +
      '  not matching the origin the request actually arrived on — the URL is part of what\n' +
      '  is signed, so a tunnel restart that changes the hostname breaks it.',
  );
}

process.exit(response.ok ? 0 : 1);
