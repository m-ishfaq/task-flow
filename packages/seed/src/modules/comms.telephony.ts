import { PhoneNumberSchema, type OrgId, type PhoneNumber } from '@taskflow/contracts';
import { blindIndex, encryptString, fieldAad } from '@taskflow/security';
import { defineSeedModule } from '../registry.js';
import type { SeedContext } from '../context.js';
import { orgsModule, type SeededOrg } from './tenancy.orgs.js';
import type { Rng } from '../rng.js';
import { cardsModule } from './work.cards.js';

/**
 * Voice & Messaging fixtures (Phase 7, ai/phase-7-voice.md).
 *
 * ## The number is REAL, or there is no telephony
 *
 * Every other module in this package invents its data. This one cannot invent
 * the one row everything else hangs off: `comms.phone_numbers.e164` is the
 * address outbound sends originate from, and a number the Twilio account does
 * not actually hold is rejected by the carrier at send time — long after the
 * seeded call log made the feature look wired up. So the number is read from
 * the account with `listOwnedNumbers` (read-only; see `ctx.telephony`), and
 * when there is no account, no credentials, or no number on it, this module
 * seeds NOTHING and says so.
 *
 * That is the same "null means skip, never fake it" rule `platform.attachments`
 * follows for object storage, for the same reason: a row with nothing real
 * behind it is a lie that looks like data, and the person it misleads is
 * whoever next tries to demo the feature.
 *
 * It never PURCHASES. `purchaseNumber` is a recurring charge on a real
 * account, and a seeder runs every time someone resets their database.
 *
 * ## Encryption is real too, and must match the application exactly
 *
 * `comms.calls`, `comms.message_threads` and `comms.suppressions` each store a
 * counterparty as two columns — AES-GCM ciphertext plus a keyed blind index —
 * and `apps/api/src/telephony/counterparty.ts` is the only thing that writes
 * them in production. The AAD it binds is reproduced here EXACTLY, including
 * the detail that looks like a bug and is not: the table component is always
 * `'comms.calls'`, even for a thread or a suppression row, because
 * `sealCounterparty` hardcodes it and every reader passes through the same
 * function. Deriving a "more correct" AAD per table here would produce rows
 * that decrypt to nothing in the UI while looking perfectly well-formed in
 * psql.
 *
 * `rowId` is each row's OWN id, so ids are minted before sealing and can never
 * be reassigned afterwards without the ciphertext becoming garbage.
 *
 * The subaccount's data key is generated through the real `KeyProvider` with
 * the same `{ orgId }` context `subaccount.service.ts` passes — a placeholder
 * there fails to unwrap the first time real code reads it, which is a bug this
 * repository has already had once (see the Phase 7 commit fixing exactly that).
 */

/** The counterparties a seeded org has talked to, as E.164. */
const COUNTERPARTIES = [
  '+14155550142',
  '+14155550178',
  '+442071838750',
  '+14155550196',
] as const;

/**
 * Always `'comms.calls'`, for calls, threads AND suppressions alike.
 *
 * Not a copy-paste slip — see the file header. This mirrors
 * `counterparty.ts`'s `counterpartyAad`, and the application is the authority
 * on what it will later try to decrypt with.
 */
function counterpartyAad(orgId: string, rowId: string): string {
  return fieldAad({
    orgId,
    table: 'comms.calls',
    column: 'counterparty_ciphertext',
    rowId,
  });
}

function seal(
  dataKey: Uint8Array,
  indexKey: Uint8Array,
  orgId: string,
  rowId: string,
  number: PhoneNumber,
): { ciphertext: Buffer; index: Buffer } {
  return {
    ciphertext: Buffer.from(encryptString(dataKey, number, counterpartyAad(orgId, rowId))),
    /* Namespaced by org, so the same number in two tenants produces unrelated
       indexes — otherwise the index itself would be a cross-tenant join. */
    index: blindIndex(indexKey, orgId, number),
  };
}

export interface TelephonyOutput {
  /** Null when the module skipped — no credentials, or no number on the account. */
  readonly number: { readonly e164: string; readonly sid: string } | null;
  readonly callCount: number;
  readonly messageCount: number;
}

export const telephonyModule = defineSeedModule({
  name: 'comms.telephony',
  /* Cards, because a recording can be attached to one (`comms.recording_cards`,
     Wave 3's "this call is about this piece of work" link). */
  requires: [orgsModule, cardsModule],
  tables: [
    /* Teardown order is the reverse of this list, so children last here.
       recording_cards before recordings before calls, threads after their
       messages — every one of these carries a real foreign key. */
    'comms.subaccounts',
    'comms.subaccount_orgs',
    'comms.phone_numbers',
    'comms.spend_policy',
    'comms.calls',
    'comms.recordings',
    'comms.transcripts',
    'comms.recording_cards',
    'comms.message_threads',
    'comms.messages',
    'comms.spend_ledger',
    'comms.suppressions',
  ],

  async seed(ctx): Promise<TelephonyOutput> {
    const skipped: TelephonyOutput = { number: null, callCount: 0, messageCount: 0 };

    const config = ctx.telephony;
    if (config === null) {
      ctx.log('comms.telephony: skipped — no carrier credentials or key material.');
      return skipped;
    }

    /* The one carrier call this module makes. A failure here is a SKIP, not a
       crash: an expired token or an offline network should not take down a
       seed run whose other fifteen modules need no carrier at all. */
    let owned;
    try {
      owned = await config.provider.listOwnedNumbers();
    } catch (error) {
      ctx.log(
        `comms.telephony: skipped — the carrier refused listOwnedNumbers (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
      return skipped;
    }

    /* Prefer a number that can actually do both, since the fixtures below
       include calls AND texts; fall back to the first owned number so an
       account holding only a voice number still seeds its call log. */
    const chosen = owned.find((entry) => entry.capabilities.voice && entry.capabilities.sms)
      ?? owned[0];

    if (chosen === undefined) {
      ctx.log('comms.telephony: skipped — the Twilio account holds no phone numbers.');
      return skipped;
    }

    const { orgs } = ctx.use(orgsModule);
    const org = orgs[0];
    if (!org) {
      ctx.log('comms.telephony: skipped — no seeded org to attach a number to.');
      return skipped;
    }

    const rng = ctx.rng.fork('comms.telephony');
    const counterparties = COUNTERPARTIES.map((value) => PhoneNumberSchema.parse(value));

    /* Real wrap, real context — see the file header on why a placeholder here
       is a bug that only surfaces the first time the app reads the row. */
    const dataKey = await config.keys.generateDataKey({ orgId: org.id });
    const subaccountSid = `AC${rng.uuid(ctx.now).replaceAll('-', '').slice(0, 30)}`;

    const result = await ctx.orgScope(org.id, async () =>
      seedOrgTelephony({
        ctx,
        rng,
        org,
        indexKey: config.indexKey,
        dataKeyPlaintext: dataKey.plaintext.key,
        wrapped: dataKey.wrapped,
        subaccountSid,
        number: { e164: chosen.phoneNumber, sid: chosen.sid, isoCountry: chosen.isoCountry },
        counterparties,
      }),
    );

    ctx.log(
      `comms.telephony: ${chosen.phoneNumber} (${chosen.sid}) — ` +
        `${String(result.callCount)} call(s), ${String(result.messageCount)} message(s)`,
    );

    return {
      number: { e164: chosen.phoneNumber, sid: chosen.sid },
      callCount: result.callCount,
      messageCount: result.messageCount,
    };
  },
});

interface SeedOrgArgs {
  readonly ctx: SeedContext;
  readonly rng: Rng;
  readonly org: SeededOrg;
  readonly indexKey: Uint8Array;
  readonly dataKeyPlaintext: Uint8Array;
  readonly wrapped: { readonly wrapped: Uint8Array; readonly masterKeyId: string };
  readonly subaccountSid: string;
  readonly number: { readonly e164: string; readonly sid: string; readonly isoCountry: string };
  readonly counterparties: readonly PhoneNumber[];
}

async function seedOrgTelephony(
  args: SeedOrgArgs,
): Promise<{ callCount: number; messageCount: number }> {
  const { ctx, rng, org, indexKey, dataKeyPlaintext, number, counterparties } = args;
  const orgId = org.id as OrgId;
  const owner = org.owner;
  const members = org.members;

  const minutes = (n: number): Date => new Date(ctx.now.getTime() - n * 60_000);

  /* ---- subaccount + its pre-tenant lookup row -------------------------- */

  await ctx.db.insert(
    'comms.subaccounts',
    [
      'org_id',
      'provider',
      'subaccount_sid',
      'auth_token_ciphertext',
      'data_key_wrapped',
      'data_key_master_id',
      'status',
      'created_at',
      'updated_at',
    ],
    [
      [
        orgId,
        'twilio',
        args.subaccountSid,
        /* A seeded subaccount token, encrypted under the SAME AAD
           subaccount.service.ts uses (rowId is the org id, not a row id — the
           table is keyed by org). Not a real Twilio subaccount token: this
           module never creates a subaccount at the carrier, because that is a
           billable object a reset would orphan. */
        Buffer.from(
          encryptString(
            dataKeyPlaintext,
            `seeded-subaccount-token-${args.subaccountSid}`,
            fieldAad({
              orgId,
              table: 'comms.subaccounts',
              column: 'auth_token_ciphertext',
              rowId: orgId,
            }),
          ),
        ),
        Buffer.from(args.wrapped.wrapped),
        args.wrapped.masterKeyId,
        'active',
        ctx.now,
        ctx.now,
      ],
    ],
  );

  /* Resolves an inbound webhook's subaccount to a tenant BEFORE any org scope
     exists (§3.11). A subaccount with no row here is a webhook that can never
     be verified. */
  await ctx.db.insert(
    'comms.subaccount_orgs',
    ['subaccount_sid', 'org_id'],
    [[args.subaccountSid, orgId]],
  );

  /* ---- the number ------------------------------------------------------ */

  const numberId = rng.uuid(ctx.now);
  await ctx.db.insert(
    'comms.phone_numbers',
    ['id', 'org_id', 'e164', 'provider_sid', 'iso_country', 'inbound_route::jsonb', 'purchased_by', 'purchased_at'],
    [
      [
        numberId,
        orgId,
        number.e164,
        number.sid,
        /* 'ZZ' is what the provider reports when Twilio omits the country;
           the CHECK only demands two uppercase letters, so it stores cleanly
           and stays honest about not being known. */
        number.isoCountry,
        { kind: 'voicemail', greeting: 'You have reached the demo workspace.' },
        owner.id,
        minutes(60 * 24 * 30),
      ],
    ],
  );

  await ctx.db.insert(
    'comms.spend_policy',
    ['org_id', 'cap_cents', 'window_days', 'updated_at', 'updated_by'],
    [[orgId, 2500, 30, ctx.now, owner.id]],
  );

  /* ---- calls ----------------------------------------------------------- */

  interface CallPlan {
    readonly direction: 'inbound' | 'outbound';
    readonly status: string;
    readonly minutesAgo: number;
    readonly durationSeconds: number | null;
    readonly recorded: boolean;
  }

  const plans: readonly CallPlan[] = [
    { direction: 'outbound', status: 'completed', minutesAgo: 90, durationSeconds: 214, recorded: true },
    { direction: 'inbound', status: 'completed', minutesAgo: 240, durationSeconds: 96, recorded: true },
    { direction: 'outbound', status: 'no_answer', minutesAgo: 400, durationSeconds: 0, recorded: false },
    { direction: 'inbound', status: 'completed', minutesAgo: 1500, durationSeconds: 331, recorded: false },
    { direction: 'outbound', status: 'busy', minutesAgo: 2200, durationSeconds: 0, recorded: false },
    { direction: 'inbound', status: 'failed', minutesAgo: 3000, durationSeconds: null, recorded: false },
    { direction: 'outbound', status: 'completed', minutesAgo: 4300, durationSeconds: 158, recorded: true },
    { direction: 'inbound', status: 'completed', minutesAgo: 5600, durationSeconds: 42, recorded: false },
    { direction: 'outbound', status: 'canceled', minutesAgo: 6100, durationSeconds: null, recorded: false },
    { direction: 'inbound', status: 'completed', minutesAgo: 7200, durationSeconds: 275, recorded: false },
    { direction: 'outbound', status: 'completed', minutesAgo: 8800, durationSeconds: 63, recorded: false },
    { direction: 'inbound', status: 'no_answer', minutesAgo: 9900, durationSeconds: 0, recorded: false },
  ];

  const callRows: unknown[][] = [];
  const ledgerRows: unknown[][] = [];
  const recorded: { callId: string; startedAt: Date; durationSeconds: number }[] = [];

  for (const [index, plan] of plans.entries()) {
    const callId = rng.uuid(ctx.now);
    const counterparty = counterparties[index % counterparties.length];
    if (counterparty === undefined) continue;

    const sealed = seal(dataKeyPlaintext, indexKey, orgId, callId, counterparty);
    const startedAt = minutes(plan.minutesAgo);
    const answered = plan.durationSeconds !== null && plan.durationSeconds > 0;
    const answeredAt = answered ? new Date(startedAt.getTime() + 6_000) : null;
    const endedAt =
      answeredAt !== null && plan.durationSeconds !== null
        ? new Date(answeredAt.getTime() + plan.durationSeconds * 1000)
        : null;

    /* `calls_recording_after_announcement`: a recorded call must have played
       its announcement FIRST. The constraint is the consent rule made
       unrepresentable-if-violated, so the fixture obeys the real ordering
       rather than nulling the announcement out. */
    const announcementPlayedAt = plan.recorded && answeredAt !== null ? answeredAt : null;
    const recordingStartedAt =
      announcementPlayedAt === null ? null : new Date(announcementPlayedAt.getTime() + 1_000);

    callRows.push([
      callId,
      orgId,
      plan.direction,
      numberId,
      sealed.ciphertext,
      sealed.index,
      plan.status,
      `CA${callId.replaceAll('-', '').slice(0, 30)}`,
      plan.direction === 'outbound' ? (members[index % members.length]?.id ?? owner.id) : null,
      startedAt,
      answeredAt,
      endedAt,
      plan.durationSeconds,
      plan.recorded ? 'all_party' : null,
      plan.recorded ? 'announced' : null,
      true,
      announcementPlayedAt,
      recordingStartedAt,
      startedAt,
      endedAt ?? startedAt,
      plan.recorded,
    ]);

    if (plan.durationSeconds !== null && plan.durationSeconds > 0) {
      /* Estimate and actual differ deliberately: the gate reserves an
         estimate before the call and reconciles afterwards, and a ledger where
         the two always match would hide a reconciliation bug. */
      const estimate = 5 + Math.ceil(plan.durationSeconds / 60) * 2;
      ledgerRows.push([
        rng.uuid(ctx.now),
        orgId,
        'call',
        estimate,
        estimate + (index % 3 === 0 ? 1 : 0),
        `CA${callId.replaceAll('-', '').slice(0, 30)}`,
        startedAt,
      ]);
    }

    if (plan.recorded && recordingStartedAt !== null && plan.durationSeconds !== null) {
      recorded.push({ callId, startedAt: recordingStartedAt, durationSeconds: plan.durationSeconds });
    }
  }

  await ctx.db.insert(
    'comms.calls',
    [
      'id',
      'org_id',
      'direction',
      'phone_number_id',
      'counterparty_ciphertext',
      'counterparty_index',
      'status',
      'provider_sid',
      'placed_by',
      'started_at',
      'answered_at',
      'ended_at',
      'duration_seconds',
      'consent_rule',
      'consent_basis',
      'announcement_required',
      'announcement_played_at',
      'recording_started_at',
      'created_at',
      'updated_at',
      'record_requested',
    ],
    callRows,
  );

  /* ---- recordings, transcripts, and one card link ---------------------- */

  const { cardRefs } = ctx.use(cardsModule);
  const orgCards = cardRefs.filter((card) => card.orgId === org.id);

  const recordingRows: unknown[][] = [];
  const transcriptRows: unknown[][] = [];
  const recordingCardRows: unknown[][] = [];

  for (const [index, entry] of recorded.entries()) {
    const recordingId = rng.uuid(ctx.now);
    const storedAt = new Date(entry.startedAt.getTime() + entry.durationSeconds * 1000 + 30_000);

    recordingRows.push([
      recordingId,
      orgId,
      entry.callId,
      `RE${recordingId.replaceAll('-', '').slice(0, 30)}`,
      null,
      /* `recordings_stored_has_key` refuses 'stored' without both a key and a
         timestamp, so the fixture supplies both rather than weakening the
         status. */
      'stored',
      `orgs/${orgId}/recordings/${recordingId}.mp3`,
      120_000 + entry.durationSeconds * 2_000,
      entry.durationSeconds,
      null,
      1,
      entry.startedAt,
      storedAt,
    ]);

    transcriptRows.push([
      rng.uuid(ctx.now),
      orgId,
      recordingId,
      index === 0
        ? 'Thanks for calling. I have raised the billing question with the team and will follow up by Friday.'
        : 'Confirming the delivery window for next week. Nothing else needed from your side for now.',
      'en',
      /* Redaction counts are part of the record: `redactTranscript` reports
         what it removed, and a zeroed map would suggest nothing was ever
         scanned rather than that nothing was found. */
      { card_number: 0, ssn: 0 },
      storedAt,
    ]);

    const card = orgCards[index % Math.max(1, orgCards.length)];
    if (card !== undefined && index === 0) {
      recordingCardRows.push([orgId, recordingId, card.id, owner.id, storedAt]);
    }
  }

  await ctx.db.insert(
    'comms.recordings',
    [
      'id',
      'org_id',
      'call_id',
      'provider_sid',
      'provider_url',
      'status',
      'storage_key',
      'bytes',
      'duration_seconds',
      'last_error',
      'attempts',
      'created_at',
      'stored_at',
    ],
    recordingRows,
  );

  await ctx.db.insert(
    'comms.transcripts',
    ['id', 'org_id', 'recording_id', 'text', 'language', 'redaction_counts::jsonb', 'created_at'],
    transcriptRows,
  );

  await ctx.db.insert(
    'comms.recording_cards',
    ['org_id', 'recording_id', 'card_id', 'attached_by', 'attached_at'],
    recordingCardRows,
  );

  /* ---- SMS threads and messages ---------------------------------------- */

  const threadRows: unknown[][] = [];
  const messageRows: unknown[][] = [];

  const conversations: readonly (readonly { direction: 'inbound' | 'outbound'; body: string; status: string }[])[] = [
    [
      { direction: 'outbound', body: 'Hi — following up on the invoice we sent Tuesday.', status: 'delivered' },
      { direction: 'inbound', body: 'Got it, thanks. Paying it this afternoon.', status: 'received' },
      { direction: 'outbound', body: 'Perfect, appreciate it.', status: 'delivered' },
    ],
    [
      { direction: 'inbound', body: 'Are you open tomorrow?', status: 'received' },
      { direction: 'outbound', body: 'We are — 9 to 5.', status: 'delivered' },
    ],
    [
      { direction: 'outbound', body: 'Your appointment is confirmed for Thursday at 14:00.', status: 'sent' },
      { direction: 'inbound', body: 'STOP', status: 'received' },
    ],
  ];

  let messageCount = 0;

  for (const [index, conversation] of conversations.entries()) {
    const threadId = rng.uuid(ctx.now);
    const counterparty = counterparties[index % counterparties.length];
    if (counterparty === undefined) continue;

    /* Threads seal the counterparty with the THREAD's id as rowId — the same
       rule calls follow, and the reason ids are minted before sealing. */
    const sealed = seal(dataKeyPlaintext, indexKey, orgId, threadId, counterparty);

    const baseMinutes = 200 + index * 640;
    let lastAt = ctx.now;

    for (const [messageIndex, message] of conversation.entries()) {
      const sentAt = minutes(baseMinutes - messageIndex * 7);
      lastAt = sentAt;
      const messageId = rng.uuid(ctx.now);

      messageRows.push([
        messageId,
        orgId,
        threadId,
        message.direction,
        message.body,
        message.status,
        `SM${messageId.replaceAll('-', '').slice(0, 30)}`,
        1,
        message.direction === 'outbound' ? owner.id : null,
        null,
        sentAt,
        message.status === 'delivered' ? new Date(sentAt.getTime() + 4_000) : null,
      ]);

      if (message.direction === 'outbound') {
        ledgerRows.push([rng.uuid(ctx.now), orgId, 'sms', 2, 2, null, sentAt]);
      }
      messageCount += 1;
    }

    threadRows.push([
      threadId,
      orgId,
      'sms',
      numberId,
      sealed.ciphertext,
      sealed.index,
      lastAt,
      /* The last conversation ends on an inbound message nobody has read —
         the state the unread badge exists to show. */
      index === conversations.length - 1 ? 1 : 0,
      minutes(baseMinutes + 10),
    ]);
  }

  /* Threads before messages: `comms.messages.thread_id` references them. */
  await ctx.db.insert(
    'comms.message_threads',
    [
      'id',
      'org_id',
      'channel',
      'phone_number_id',
      'counterparty_ciphertext',
      'counterparty_index',
      'last_message_at',
      'unread_count',
      'created_at',
    ],
    threadRows,
  );

  await ctx.db.insert(
    'comms.messages',
    [
      'id',
      'org_id',
      'thread_id',
      'direction',
      'body',
      'status',
      'provider_sid',
      'segments',
      'sent_by',
      'error_code',
      'created_at',
      'delivered_at',
    ],
    messageRows,
  );

  await ctx.db.insert(
    'comms.spend_ledger',
    ['id', 'org_id', 'kind', 'estimated_cents', 'actual_cents', 'provider_sid', 'occurred_at'],
    ledgerRows,
  );

  /* ---- suppression ------------------------------------------------------ */

  /* The 'STOP' above is only half the feature. A conversation containing the
     keyword with no suppression row behind it would demo the inbound message
     and silently leave the org able to text that number again — which is the
     compliance failure the table exists to prevent. */
  const lastCounterparty = counterparties[(conversations.length - 1) % counterparties.length];
  if (lastCounterparty !== undefined) {
    const suppressionId = rng.uuid(ctx.now);
    const sealed = seal(dataKeyPlaintext, indexKey, orgId, suppressionId, lastCounterparty);
    await ctx.db.insert(
      'comms.suppressions',
      [
        'id',
        'org_id',
        'counterparty_ciphertext',
        'counterparty_index',
        'reason',
        'suppressed_at',
        'revoked_at',
      ],
      [[suppressionId, orgId, sealed.ciphertext, sealed.index, 'stop_keyword', minutes(190), null]],
    );
  }

  return { callCount: callRows.length, messageCount };
}
