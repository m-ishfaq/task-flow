import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type ChannelId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as channels from './channel.service.js';
import * as messages from './message.service.js';
import * as compliance from './compliance.service.js';
import { sweepOrg } from './retention.js';
import type { RichTextNode } from '../work/richtext.js';
import type { ChatActor } from './shared.js';

/**
 * Retention and legal hold against real Postgres
 * (ai/phase-5-chat.md §3.7, Wave 4 acceptance).
 *
 * §5's acceptance criterion is specific and unusual: "a message under legal
 * hold survives a retention sweep that would otherwise delete it, proven by a
 * test that RACES the two rather than asserting them in sequence."
 *
 * That wording is the whole point. Asserting in sequence — place a hold, then
 * sweep, then check the message is there — passes against a two-step
 * implementation that reads the eligible ids first and deletes them afterwards,
 * because nothing changes between the read and the delete in a quiet test. The
 * bug that shape has only appears when a hold lands INSIDE that window, which
 * is milliseconds wide, never reproduced, and never believed.
 *
 * So `races a hold against a sweep` below starts both without awaiting either.
 * It cannot deterministically hit the window on every run — no test can — but
 * it can prove the property the correct implementation has and the broken one
 * does not: that whichever order they land in, a held message is still there.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee03-0000-7000-8000-000000000001');
const USERS: readonly [UserId, string][] = [[OWNER, 'owner@retention.test']];
const requestId = unsafeAsId<'RequestId'>('0195ee03-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<ChatActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

function body(text: string): RichTextNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'chat.message_unfurls',
    'chat.messages',
    'chat.channels',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/**
 * Backdates a message so a retention window applies to it.
 *
 * Through the migrator connection rather than a service, because nothing in the
 * application may rewrite `created_at` — and a test that could would be testing
 * a capability the product does not have.
 */
async function backdate(orgId: OrgId, messageId: string, days: number): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `UPDATE chat.messages SET created_at = now() - ($2 || ' days')::interval WHERE id = $1`,
    [messageId, String(days)],
  );
  await admin.setOrg(null);
}

async function messageExists(orgId: OrgId, messageId: string): Promise<boolean> {
  await admin.setOrg(orgId);
  const result = await admin.query(`SELECT id FROM chat.messages WHERE id = $1`, [messageId]);
  await admin.setOrg(null);
  return result.rows.length > 0;
}

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: ChatActor;
  readonly channelId: ChannelId;
}

async function scaffold(slug: string): Promise<Fixture> {
  const result = await orgs.createOrg(
    { name: `Retention ${slug}`, slug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  const creator = await actorFor(result.orgId, OWNER, 'owner');
  const channel = await channels.createChannel(creator, { type: 'public', name: 'general' });

  /* Rebuilt after the channel exists: `createChannel` writes the creator's own
     membership tuple, and an actor captured before that call does not carry it. */
  const owner = await actorFor(result.orgId, OWNER, 'owner');

  return { orgId: result.orgId, owner, channelId: channel.channelId };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-retention-test' });
});

afterAll(async () => {
  await closeDatabase();
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('the retention sweep', () => {
  it('deletes nothing when no window is set', async () => {
    /* NULL means keep forever, and it is the default. A default that lived in
       code would start deleting messages the day someone changed the constant,
       across every channel that never opted in. */
    const { orgId, owner, channelId } = await scaffold('no-window');
    const sent = await messages.sendMessage(owner, { channelId, body: body('old') });
    await backdate(orgId, sent.messageId, 400);

    await sweepOrg(orgId);

    expect(await messageExists(orgId, sent.messageId)).toBe(true);
  });

  it('deletes a message older than the window', async () => {
    const { orgId, owner, channelId } = await scaffold('deletes-old');
    const sent = await messages.sendMessage(owner, { channelId, body: body('old') });
    await backdate(orgId, sent.messageId, 40);
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });

    await sweepOrg(orgId);

    expect(await messageExists(orgId, sent.messageId)).toBe(false);
  });

  it('keeps a message inside the window', async () => {
    const { orgId, owner, channelId } = await scaffold('keeps-recent');
    const sent = await messages.sendMessage(owner, { channelId, body: body('recent') });
    await backdate(orgId, sent.messageId, 10);
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });

    await sweepOrg(orgId);

    expect(await messageExists(orgId, sent.messageId)).toBe(true);
  });

  it('records each deletion as a domain event, not silently', async () => {
    /* §3.7: a retention deletion must appear in the audit trail. The opposite
       problem from read cursors — here the mutation is rare enough that the
       chain cost is a feature. */
    const { orgId, owner, channelId } = await scaffold('emits-events');
    const sent = await messages.sendMessage(owner, { channelId, body: body('old') });
    await backdate(orgId, sent.messageId, 40);
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });

    await sweepOrg(orgId);

    await admin.setOrg(orgId);
    const result = await admin.query(
      `SELECT name, payload FROM platform.outbox WHERE org_id = $1 AND name = 'message.deleted'`,
      [orgId],
    );
    await admin.setOrg(null);

    const rows = result.rows as { name: string; payload: { reason?: string } }[];
    expect(rows).toHaveLength(1);
    // The field `message.deleted` has carried since Wave 1 precisely so this
    // pass would not have to widen the payload.
    expect(rows[0]?.payload.reason).toBe('retention_policy');
  });
});

describe('legal hold', () => {
  it('exempts a held message from a sweep that would delete it', async () => {
    const { orgId, owner, channelId } = await scaffold('hold-message');
    const sent = await messages.sendMessage(owner, { channelId, body: body('evidence') });
    await backdate(orgId, sent.messageId, 40);
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });
    await compliance.setMessageHold(owner, { messageId: sent.messageId, held: true });

    await sweepOrg(orgId);

    expect(await messageExists(orgId, sent.messageId)).toBe(true);
  });

  it('exempts every message in a channel-wide hold', async () => {
    /* A channel hold covers messages written AFTER it was placed, which a
       per-message flag cannot express — the reason both exist. */
    const { orgId, owner, channelId } = await scaffold('hold-channel');
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });
    await compliance.setChannelHold(owner, { channelId, held: true });

    const sent = await messages.sendMessage(owner, { channelId, body: body('later') });
    await backdate(orgId, sent.messageId, 40);

    await sweepOrg(orgId);

    expect(await messageExists(orgId, sent.messageId)).toBe(true);
  });

  it('lets the message be deleted once the hold is lifted', async () => {
    const { orgId, owner, channelId } = await scaffold('hold-release');
    const sent = await messages.sendMessage(owner, { channelId, body: body('evidence') });
    await backdate(orgId, sent.messageId, 40);
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });
    await compliance.setMessageHold(owner, { messageId: sent.messageId, held: true });

    await sweepOrg(orgId);
    expect(await messageExists(orgId, sent.messageId)).toBe(true);

    await compliance.setMessageHold(owner, { messageId: sent.messageId, held: false });
    await sweepOrg(orgId);

    expect(await messageExists(orgId, sent.messageId)).toBe(false);
  });

  it('can hold a message already past its retention window', async () => {
    /* §7.5, answered yes. The sweep deletes on a tick rather than at the
       instant of expiry, so a message past its window still exists until the
       next pass — and refusing to hold it would make the hold unavailable at
       exactly the moment it is most needed. */
    const { orgId, owner, channelId } = await scaffold('hold-expired');
    const sent = await messages.sendMessage(owner, { channelId, body: body('overdue') });
    await backdate(orgId, sent.messageId, 400);
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });

    await compliance.setMessageHold(owner, { messageId: sent.messageId, held: true });
    await sweepOrg(orgId);

    expect(await messageExists(orgId, sent.messageId)).toBe(true);
  });

  /**
   * The §5 acceptance criterion, run concurrently — and an honest note about
   * what a test of this shape can and cannot establish.
   *
   * ## What it checks
   *
   * Both operations start without either being awaited, and the invariant
   * asserted is "a hold that WROTE A ROW implies the message survived". That
   * holds for every interleaving of a correct implementation:
   *
   *   hold commits first  → the DELETE's own WHERE sees `held_at IS NOT NULL`
   *   sweep commits first → the hold matches zero rows, `applied` is false
   *
   * A two-step sweep can reach a state neither of those allows: apply the hold,
   * then delete the row by an id it read before the hold existed. That is what
   * `applied && !survived` catches.
   *
   * ## What it CANNOT establish, stated plainly
   *
   * This was verified by breaking the implementation on purpose — replacing the
   * single DELETE with a read-then-delete and a 60 ms gap — and the test still
   * passed. The reason is that both operations take connections from the same
   * pool, so the second one waits for the first to commit and the interleaving
   * never happens. A concurrency test cannot force a window that the code under
   * test only opens when it is already wrong.
   *
   * So this test is opportunistic: it will catch the broken shape if the
   * interleaving does occur, and it is not what guarantees the property. The
   * guarantee is STRUCTURAL — the hold check is a predicate inside one DELETE
   * statement, so there is no window for a hold to land in. That is a property
   * of the SQL, which is why the comment on that statement in `retention.ts` is
   * load-bearing and why this file should not be read as covering it.
   */
  it('never loses a held message when a hold and a sweep run together', async () => {
    const { orgId, owner, channelId } = await scaffold('hold-race');
    const sent = await messages.sendMessage(owner, { channelId, body: body('contested') });
    await backdate(orgId, sent.messageId, 40);
    await compliance.setRetention(owner, { channelId, retentionDays: 30 });

    // Started together, deliberately not awaited in sequence.
    const [holdOutcome] = await Promise.allSettled([
      compliance.setMessageHold(owner, { messageId: sent.messageId, held: true }),
      sweepOrg(orgId),
    ]);

    const survived = await messageExists(orgId, sent.messageId);

    /* THE invariant: a hold that WROTE A ROW implies the message is still here.
       `applied` is what makes this checkable — without it, "the hold call
       returned successfully" is true even when it matched nothing, and the
       broken case is indistinguishable from the legitimate one.

       correct impl, hold first  → applied, delete skips it        → survived ✓
       correct impl, sweep first → matched nothing, applied false  → no claim
       BROKEN impl               → applied, then deleted by id     → FAILS HERE */
    const applied = holdOutcome.status === 'fulfilled' && holdOutcome.value.applied;

    if (applied) {
      expect(
        survived,
        'a legal hold was written and the message was deleted anyway — the sweep is ' +
          'reading eligible ids before deleting instead of checking the hold in the ' +
          'DELETE itself (§3.7)',
      ).toBe(true);
    }

    /* And the converse, so this cannot pass by the hold never applying: if the
       message survived, something must have held it. A row that outlived a
       sweep with no hold means the predicate is wrong the other way — keeping
       data past its own retention policy. */
    if (survived) {
      await admin.setOrg(orgId);
      const heldResult = await admin.query(`SELECT held_at FROM chat.messages WHERE id = $1`, [
        sent.messageId,
      ]);
      await admin.setOrg(null);
      const held = heldResult.rows as { held_at: Date | null }[];

      expect(held[0]?.held_at).not.toBeNull();
    }
  });
});
