/**
 * Dev-only: make a number bought in the Twilio CONSOLE usable by this app.
 *
 * ## The mismatch this bridges, and why it is a hack
 *
 * The product model is one Twilio SUBACCOUNT per org (PLAN.md §8.5 — "a leaked
 * credential's blast radius is one tenant"), and `numbers.purchase` buys into
 * that subaccount. A TRIAL account cannot buy numbers through the API at all
 * (error 21404), so the only way to hold one is to claim it in the Console —
 * where it lands on the PARENT account instead.
 *
 * The app would then dial `/Accounts/<subaccount>/Calls.json` with a `From` the
 * subaccount does not own, and Twilio refuses it. So this repoints the org's
 * subaccount record at the parent account and registers the number.
 *
 * That deliberately collapses the per-org isolation the design exists for. It
 * is acceptable in a single-tenant development database and nowhere else: on a
 * real deployment the org's telephony now runs directly on the parent
 * credential, so a leak is every tenant rather than one. UNDO IT (see the
 * printed instructions) rather than leaving it in place.
 *
 * ## Usage
 *
 *   pnpm --filter @taskflow/api exec tsx scripts/dev-attach-console-number.ts \
 *     --org <orgId> --number +19802914100
 *
 * Reads the ACTIVE TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from .env, confirms
 * the number really is on that account, and refuses if it is not — a row
 * naming a number the credential cannot use produces a confusing carrier
 * refusal later rather than a clear failure now.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
        if (process.env[key] === undefined) {
          /* Strip an inline `# comment`, matching process.loadEnvFile. */
          process.env[key] = raw.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
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

const { initializeDatabase, withOrgScope, schema, eq } = await import('@taskflow/db');
const { SoftwareKeyProvider, encryptString, fieldAad, newId } = await import('@taskflow/security');

initializeDatabase({
  url: process.env['DATABASE_URL'] ?? '',
  maxConnections: 2,
  applicationName: 'taskflow-dev-attach-number',
});

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const die = (message: string): never => {
  console.error(`\n  ${message}\n`);
  process.exit(1);
};

const orgArg = flag('org');
const numberArg = flag('number');
if (orgArg === undefined || numberArg === undefined) {
  die('Usage: --org <orgId> --number <+E164>');
}

const accountSid = process.env['TWILIO_ACCOUNT_SID'] ?? '';
const authToken = process.env['TWILIO_AUTH_TOKEN'] ?? '';
if (!accountSid.startsWith('AC') || accountSid === 'AC00000000000000000000000000000000') {
  die('TWILIO_ACCOUNT_SID must be the LIVE account that owns the number, not the mock SID.');
}

/* ------------------------------------------------------------------ *
 * Confirm the carrier agrees this number is ours
 * ------------------------------------------------------------------ */

const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`, 'utf8').toString('base64')}`;
const listed = (await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(numberArg)}`,
  { headers: { Authorization: auth } },
).then((response) => response.json())) as {
  incoming_phone_numbers?: { sid: string; phone_number: string }[];
  code?: number;
};

if (listed.code !== undefined) die(`Twilio refused the lookup: error ${String(listed.code)}.`);

const carrierNumber = listed.incoming_phone_numbers?.[0];
if (carrierNumber === undefined) {
  die(`${numberArg} is not on account ${accountSid}. Check the Console's account selector.`);
}

/* ------------------------------------------------------------------ *
 * Repoint the subaccount record and register the number
 * ------------------------------------------------------------------ */

const orgId = orgArg as Parameters<typeof withOrgScope>[0];

const keys = new SoftwareKeyProvider({
  currentMasterKeyId: process.env['MASTER_KEY_ID'] ?? '',
  masterKeys: [
    {
      id: process.env['MASTER_KEY_ID'] ?? '',
      key: new Uint8Array(Buffer.from(process.env['MASTER_KEY_BASE64'] ?? '', 'base64')),
    },
  ],
});

/* Re-derived here rather than imported: `tokenAad` is module-private in
   subaccount.service.ts, and it should stay that way — the AAD binding a
   ciphertext to its row is not a thing scripts should be able to vary. Any
   drift between these two shapes shows up immediately as a decrypt failure,
   which is the safe direction. */
const tokenAad = fieldAad({
  orgId,
  table: 'comms.subaccounts',
  column: 'auth_token_ciphertext',
  rowId: orgId,
});

const dataKey = await keys.generateDataKey({ orgId });
const ciphertext = Buffer.from(encryptString(dataKey.plaintext.key, authToken, tokenAad));

const previous = await withOrgScope(orgId, async (tx) => {
  const before = await tx
    .select({ sid: schema.subaccounts.subaccountSid })
    .from(schema.subaccounts)
    .limit(1);

  await tx
    .update(schema.subaccounts)
    .set({
      subaccountSid: accountSid,
      authTokenCiphertext: ciphertext,
      dataKeyWrapped: Buffer.from(dataKey.wrapped.wrapped),
      dataKeyMasterId: dataKey.wrapped.masterKeyId,
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(schema.subaccounts.orgId, orgId));

  /* The pre-tenant lookup row webhooks resolve through. Without it an inbound
     POST carrying this AccountSid maps to no org and is refused before its
     signature is ever checked. */
  await tx
    .insert(schema.subaccountOrgs)
    .values({ subaccountSid: accountSid, orgId })
    .onConflictDoNothing({ target: schema.subaccountOrgs.subaccountSid });

  const existing = await tx
    .select({ id: schema.phoneNumbers.id })
    .from(schema.phoneNumbers)
    .where(eq(schema.phoneNumbers.e164, numberArg))
    .limit(1);

  if (existing.length === 0) {
    await tx.insert(schema.phoneNumbers).values({
      id: newId<'PhoneNumberId'>(),
      orgId,
      e164: numberArg,
      providerSid: carrierNumber.sid,
      isoCountry: 'US',
      purchasedBy: null,
    });
  }

  return before[0]?.sid;
});

console.log(`
  Attached ${numberArg} (${carrierNumber.sid}) to org ${orgArg}.

    comms.subaccounts.subaccount_sid : ${previous ?? '(none)'} -> ${accountSid}
    comms.subaccount_orgs            : + ${accountSid}
    comms.phone_numbers              : + ${numberArg}

  This org's telephony now runs on the PARENT credential — per-org isolation is
  off for it. To undo, delete the phone_numbers row and restore the old
  subaccount sid, or drop the org's comms.subaccounts row entirely and let
  ensureSubaccount provision a fresh one.

  Next: restart the API, then place a call from /calls to a VERIFIED number.
`);

process.exit(0);
