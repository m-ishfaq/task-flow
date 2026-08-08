import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, eq, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakeTelephonyProvider } from '@taskflow/telephony';
import { SoftwareKeyProvider, signTwilioRequest } from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import {
  ensureSubaccount,
  loadSubaccount,
  loadSubaccountAuthToken,
  setSubaccountStatus,
} from './subaccount.service.js';
import { commitWebhookNonce, pruneWebhookNonces, verifyInboundWebhook } from './webhook.js';
import type { TelephonyActor } from './shared.js';

/**
 * Subaccount provisioning and inbound webhook verification, against real
 * Postgres (ai/phase-7-voice.md §3.1, §3.11).
 *
 * ⚠ Both surfaces under test are human-review surfaces (CLAUDE.md §2.2 —
 * "any webhook signature verification", "any code touching telephony spend").
 *
 * Signatures here are produced by `signTwilioRequest`, which reproduces
 * Twilio's own published vector in `twilio-signature.test.ts` — not by stubbing
 * the verifier. A webhook test whose signature check is mocked asserts that the
 * handler works on trusted input, which is the one case it is not defending
 * against.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee30-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195ee30-0000-7000-8000-0000000000ff');
const USERS: readonly [UserId, string][] = [[OWNER, 'owner@telephony-sub.test']];

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: [{ id: MASTER_KEY_ID, key: new Uint8Array(32).fill(7) }],
});

const WEBHOOK_URL = 'https://api.taskflow.test/telephony/voice';

let admin: AdminConnection;
let created: OrgId[] = [];
let provider: FakeTelephonyProvider;

async function actorFor(orgId: OrgId): Promise<TelephonyActor> {
  const tuples = await loadTuples(orgId, OWNER);
  const subject: Subject = { orgId, userId: OWNER, role: 'owner', tuples };
  return { subject, requestId };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.webhook_nonces WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.spend_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.spend_policy WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.subaccount_orgs WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM comms.subaccounts WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-tel-sub-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
  provider = new FakeTelephonyProvider();
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

describe('ensureSubaccount', () => {
  it('provisions a subaccount and records it with its directory row', async () => {
    const orgId = await newOrg('sub-create');
    const actor = await actorFor(orgId);

    const record = await ensureSubaccount(actor, { telephony: provider, keys });

    expect(record.subaccountSid).toMatch(/^AC/);
    expect(provider.subaccounts.size).toBe(1);

    /* The directory row must land in the SAME transaction: a subaccount whose
       SID resolves to no org is a webhook that can never be verified. */
    await admin.setOrg(null);
    const directory = await admin.query(
      `SELECT org_id FROM comms.subaccount_orgs WHERE subaccount_sid = $1`,
      [record.subaccountSid],
    );
    expect(directory.rows).toHaveLength(1);
    expect(directory.rows[0]?.['org_id']).toBe(orgId);
  });

  it('is idempotent — a second call creates nothing at the carrier', async () => {
    const orgId = await newOrg('sub-idem');
    const actor = await actorFor(orgId);

    const first = await ensureSubaccount(actor, { telephony: provider, keys });
    const second = await ensureSubaccount(actor, { telephony: provider, keys });

    expect(second.subaccountSid).toBe(first.subaccountSid);
    /* An orphaned subaccount still bills, and nothing in this system would ever
       mention it again. */
    expect(provider.subaccounts.size).toBe(1);
  });

  it('emits subaccount.provisioned with the SID and never the auth token', async () => {
    const orgId = await newOrg('sub-event');
    const actor = await actorFor(orgId);
    await ensureSubaccount(actor, { telephony: provider, keys });

    await admin.setOrg(orgId);
    const outbox = await admin.query(
      `SELECT name, payload FROM platform.outbox WHERE org_id = $1`,
      [orgId],
    );
    await admin.setOrg(null);

    const event = outbox.rows.find((row) => row['name'] === 'subaccount.provisioned');
    expect(event).toBeDefined();

    /* An outbox payload is persisted and projected into the audit log, where
       REDACTION_PATHS never runs. A credential must not be in it. */
    const payload = JSON.stringify(event?.['payload']);
    expect(payload).not.toContain('tok');
    expect(payload).toContain('subaccountSid');
  });
});

describe('the stored auth token', () => {
  it('round-trips through envelope encryption', async () => {
    const orgId = await newOrg('sub-token');
    const actor = await actorFor(orgId);
    await ensureSubaccount(actor, { telephony: provider, keys });

    const token = await loadSubaccountAuthToken(orgId, keys);
    expect(token).toBeDefined();
    expect(token?.length).toBeGreaterThan(0);
  });

  it('is not stored in plaintext', async () => {
    const orgId = await newOrg('sub-token-cipher');
    const actor = await actorFor(orgId);
    await ensureSubaccount(actor, { telephony: provider, keys });
    const token = await loadSubaccountAuthToken(orgId, keys);

    const stored = await withOrgScope(orgId, async (tx) => {
      const rows = await tx
        .select({ ciphertext: schema.subaccounts.authTokenCiphertext })
        .from(schema.subaccounts)
        .limit(1);
      return rows[0]?.ciphertext;
    });

    expect(stored).toBeDefined();
    expect(stored?.toString('utf8')).not.toContain(token ?? 'unreachable');
  });

  it('refuses to decrypt a ciphertext moved to another org', async () => {
    /* The AAD binds the ciphertext to its row. Without it, a restore that
       shuffled rows — or a deliberate copy — would decrypt cleanly and hand
       back the wrong tenant's carrier credential. With it, decryption FAILS. */
    const mine = await newOrg('sub-aad-mine');
    const theirs = await newOrg('sub-aad-theirs');
    await ensureSubaccount(await actorFor(mine), { telephony: provider, keys });
    await ensureSubaccount(await actorFor(theirs), { telephony: provider, keys });

    const stolen = await withOrgScope(mine, async (tx) => {
      const rows = await tx
        .select({
          ciphertext: schema.subaccounts.authTokenCiphertext,
          wrapped: schema.subaccounts.dataKeyWrapped,
          masterKeyId: schema.subaccounts.dataKeyMasterId,
        })
        .from(schema.subaccounts)
        .limit(1);
      return rows[0];
    });

    await withOrgScope(theirs, async (tx) => {
      await tx
        .update(schema.subaccounts)
        .set({
          authTokenCiphertext: stolen?.ciphertext ?? Buffer.alloc(0),
          dataKeyWrapped: stolen?.wrapped ?? Buffer.alloc(0),
          dataKeyMasterId: stolen?.masterKeyId ?? MASTER_KEY_ID,
        })
        .where(eq(schema.subaccounts.orgId, theirs));
    });

    await expect(loadSubaccountAuthToken(theirs, keys)).rejects.toThrow();
  });
});

describe('setSubaccountStatus', () => {
  it('freezes at the carrier as well as locally', async () => {
    const orgId = await newOrg('sub-freeze');
    const actor = await actorFor(orgId);
    const record = await ensureSubaccount(actor, { telephony: provider, keys });

    const result = await setSubaccountStatus(actor, { telephony: provider, keys }, 'suspended');

    expect(result.carrierUpdated).toBe(true);
    /* Refusing locally does nothing about a leaked credential used directly
       against Twilio, which answers to whoever holds the token
       (ai/phase-12-admin.md §9). */
    expect(provider.subaccounts.get(record.subaccountSid)?.status).toBe('suspended');
    expect((await loadSubaccount(orgId))?.status).toBe('suspended');
  });

  it('still records the freeze locally when the carrier is unreachable', async () => {
    /* A half-applied freeze that is RECORDED as half-applied is far better than
       one that silently reports success — the difference is whether an incident
       responder knows the credential is still live at Twilio. */
    const orgId = await newOrg('sub-freeze-fail');
    const actor = await actorFor(orgId);
    await ensureSubaccount(actor, { telephony: provider, keys });

    provider.failNext = new Error('carrier unreachable');
    const result = await setSubaccountStatus(actor, { telephony: provider, keys }, 'suspended');

    expect(result.carrierUpdated).toBe(false);
    expect((await loadSubaccount(orgId))?.status).toBe('suspended');
  });
});

describe('verifyInboundWebhook', () => {
  async function provisioned(slug: string): Promise<{ orgId: OrgId; sid: string; token: string }> {
    const orgId = await newOrg(slug);
    const record = await ensureSubaccount(await actorFor(orgId), { telephony: provider, keys });
    const token = await loadSubaccountAuthToken(orgId, keys);
    return { orgId, sid: record.subaccountSid, token: token ?? '' };
  }

  function signed(sid: string, token: string, extra: Record<string, string> = {}) {
    const params = { AccountSid: sid, CallSid: 'CA123', CallStatus: 'completed', ...extra };
    return {
      url: WEBHOOK_URL,
      params,
      signature: signTwilioRequest({ url: WEBHOOK_URL, params, authToken: token }),
    };
  }

  it('accepts a correctly signed webhook and resolves its org', async () => {
    const { orgId, sid, token } = await provisioned('wh-ok');

    const verdict = await verifyInboundWebhook(signed(sid, token), keys);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.orgId).toBe(orgId);
      expect(verdict.subaccountSid).toBe(sid);
    }
  });

  it('rejects an unsigned request', async () => {
    const { sid, token } = await provisioned('wh-unsigned');
    const request = { ...signed(sid, token), signature: undefined };

    const verdict = await verifyInboundWebhook(request, keys);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  it('rejects a tampered parameter', async () => {
    const { sid, token } = await provisioned('wh-tampered');
    const request = signed(sid, token);

    const verdict = await verifyInboundWebhook(
      { ...request, params: { ...request.params, CallStatus: 'in-progress' } },
      keys,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  it('rejects a signature computed for a different URL', async () => {
    /* The signature covers the URL, which is why it must come from configuration
       rather than from the request's own Host header. */
    const { sid, token } = await provisioned('wh-url');
    const request = signed(sid, token);

    const verdict = await verifyInboundWebhook(
      { ...request, url: 'https://evil.test/telephony/voice' },
      keys,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  it('rejects an unknown subaccount without disclosing anything else', async () => {
    const verdict = await verifyInboundWebhook(
      { url: WEBHOOK_URL, params: { AccountSid: 'ACnotours' }, signature: 'whatever' },
      keys,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('unknown_subaccount');
  });

  it("refuses a signature made with ANOTHER org's token", async () => {
    /* Naming a subaccount you do not hold the token for resolves to an org
       whose key then refuses your signature. That is why using the payload's
       AccountSid as a LOOKUP KEY is not the same as trusting it. */
    const mine = await provisioned('wh-cross-mine');
    const theirs = await provisioned('wh-cross-theirs');

    const forged = signed(mine.sid, theirs.token);

    const verdict = await verifyInboundWebhook(forged, keys);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  describe('replay', () => {
    it('refuses a byte-identical request that already succeeded', async () => {
      const { orgId, sid, token } = await provisioned('wh-replay');
      const request = signed(sid, token);

      const first = await verifyInboundWebhook(request, keys);
      expect(first.ok).toBe(true);

      if (first.ok) {
        await withOrgScope(orgId, async (tx) => {
          await commitWebhookNonce(tx, orgId, first.signature);
        });
      }

      const second = await verifyInboundWebhook(request, keys);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.reason).toBe('replayed');
    });

    it('ALLOWS a retry after a handler failure rolled the nonce back', async () => {
      /* The failure this design prevents: Twilio retries on 5xx with a
         byte-identical signature. A nonce written on RECEIPT would mark the
         request seen, the handler would fail, and the retry that exists to
         recover the event would be refused as a replay — losing the event,
         silently, exactly when something was already going wrong. */
      const { orgId, sid, token } = await provisioned('wh-retry');
      const request = signed(sid, token);

      const first = await verifyInboundWebhook(request, keys);
      expect(first.ok).toBe(true);

      await expect(
        withOrgScope(orgId, async (tx) => {
          if (first.ok) await commitWebhookNonce(tx, orgId, first.signature);
          throw new Error('handler failed after recording the nonce');
        }),
      ).rejects.toThrow(/handler failed/);

      const retry = await verifyInboundWebhook(request, keys);
      expect(retry.ok, 'a retry after a rolled-back handler must proceed').toBe(true);
    });

    it('does not leak nonces across orgs', async () => {
      const mine = await provisioned('wh-nonce-mine');
      const theirs = await provisioned('wh-nonce-theirs');

      const request = signed(mine.sid, mine.token);
      const verdict = await verifyInboundWebhook(request, keys);
      if (verdict.ok) {
        await withOrgScope(mine.orgId, async (tx) => {
          await commitWebhookNonce(tx, mine.orgId, verdict.signature);
        });
      }

      const theirRequest = signed(theirs.sid, theirs.token);
      const theirVerdict = await verifyInboundWebhook(theirRequest, keys);
      expect(theirVerdict.ok).toBe(true);
    });

    it('prunes nonces past the retention window', async () => {
      const { orgId, sid, token } = await provisioned('wh-prune');
      const request = signed(sid, token);
      const verdict = await verifyInboundWebhook(request, keys);

      if (verdict.ok) {
        await withOrgScope(orgId, async (tx) => {
          await commitWebhookNonce(tx, orgId, verdict.signature);
        });
      }

      expect((await verifyInboundWebhook(request, keys)).ok).toBe(false);

      /* Pruning with a zero window drops everything, which is what makes the
         retention window observable rather than a comment. */
      await pruneWebhookNonces(orgId, 0);
      expect((await verifyInboundWebhook(request, keys)).ok).toBe(true);
    });
  });
});
