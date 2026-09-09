import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, initializeSearchDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { TEST_ENV, testAppRouter, testContext, testPrincipal } from '../testing/fixtures.js';
import { createCallerFactory } from '../trpc/builder.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as channels from '../chat/channel.service.js';
import * as messages from '../chat/message.service.js';
import type { ChatActor } from '../chat/shared.js';
import type { RichTextNode } from '../work/richtext.js';
import { indexMessage, indexTranscript } from './indexer.relay.js';

/**
 * The search route (ai/phase-8-search.md §2.7), through the real tRPC router.
 *
 * ## The property under test is a DM that never surfaces
 *
 * The index answers "which org" and RLS admits every document row in the
 * org — including a message in a direct message between two OTHER people.
 * `member` holds `channel:read` from the role matrix, so a route that
 * stopped at the floor would hand that member the DM's contents with a
 * decision trace that looks entirely correct: the role genuinely grants the
 * permission and there is genuinely no tuple to weigh against it — the
 * exact shape `chat/shared.ts`'s `closed` target exists to prevent.
 *
 * So the real gate is the per-hit `can()` in the router: a message is shown
 * exactly when its CHANNEL is reachable, and a closed channel (a DM) is
 * reachable only through a relation on it. These tests prove the absence of
 * the relation is what keeps another person's DM out of search results.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000002');
/** A third user who has a DM with the owner that MEMBER is not in. */
const THIRD = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@search.test'],
  [MEMBER, 'member@search.test'],
  [THIRD, 'third@search.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee10-0000-7000-8000-0000000000ff');

/* Wired once, at module scope: only assembles the router structure, touches
   no connection — safe before `beforeAll` opens the pool. */
const { router: searchAppRouter } = testAppRouter();
const callerFactory = createCallerFactory(searchAppRouter);

let admin: AdminConnection;
const created: OrgId[] = [];
let fixtureCounter = 0;

async function actorFor(
  orgId: OrgId,
  userId: UserId,
  role: ChatActor['subject']['role'],
): Promise<ChatActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

function body(text: string): RichTextNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  /* Dispatch rows reference outbox rows and have no org_id of their own —
     they go first, keyed through the parent. Same ordering and shape the
     relay test documents. */
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'search.documents',
    'comms.transcripts',
    'comms.recordings',
    'comms.calls',
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

async function scaffold(
  slug: string,
): Promise<{ orgId: OrgId; owner: ChatActor; refreshOwner: () => Promise<ChatActor> }> {
  fixtureCounter += 1;
  /* An org left behind by an aborted earlier run keeps its slug — a random
     suffix so a crashed run cannot poison the next one (the relay test's own
     lesson, which keeps its counter slugs safe only because its cleanup ran). */
  const uniqueSlug = `sr-${fixtureCounter.toString(36)}-${slug.slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Search ${slug}`, slug: uniqueSlug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  await members.addMember(
    result.orgId,
    { email: 'member@search.test', role: 'member' },
    { userId: OWNER, requestId },
  );
  await members.addMember(
    result.orgId,
    { email: 'third@search.test', role: 'member' },
    { userId: OWNER, requestId },
  );

  return {
    orgId: result.orgId,
    owner: await actorFor(result.orgId, OWNER, 'owner'),
    /* `openDirectMessage` writes the creator's own membership tuple, so an
       actor captured before that call does not carry it — and a DM is closed,
       so its creator is denied their own DM until the actor is rebuilt. The
       same trap guest.test.ts documents for private channels. */
    refreshOwner: () => actorFor(result.orgId, OWNER, 'owner'),
  };
}

/**
 * Indexes the message directly through the indexer.
 *
 * Deliberately NOT the outbox drain: the relay's claim loop is the relay
 * test's job, and this file shares the global `search` consumer queue with it
 * — two files draining one queue in parallel is exactly the cross-file
 * fixture race the Phase 4 lesson names. The route layer under test here is
 * the per-hit `can()`, and `indexMessage` re-reads the real source row either
 * way, so nothing the relay contributes is lost by driving it directly.
 */
async function indexSentMessage(orgId: OrgId, messageId: string, channelId: string): Promise<void> {
  const written = await indexMessage(orgId, { messageId, channelId });
  expect(written).toBe(true);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-search-route-test' });
  initializeSearchDatabase({
    url: 'postgresql://taskflow_search:search-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-search-route-test',
  });
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

describe('the search route through the real tRPC router', () => {
  it('never surfaces a DM between other users, even though RLS admitted the row', async () => {
    const { orgId, owner, refreshOwner } = await scaffold('dm-hide');

    const open = await channels.createChannel(owner, { type: 'public', name: 'incidents' });
    const dm = await channels.openDirectMessage(owner, { userIds: [THIRD] });
    const otherDm = await channels.openDirectMessage(owner, { userIds: [MEMBER] });
    /* The DMs above wrote the owner's own membership tuples — rebuild the
       actor so sending into a closed channel passes the layer-2 check. */
    const author = await refreshOwner();

    const publicSent = await messages.sendMessage(author, {
      channelId: open.channelId,
      body: body('is anyone looking at the outage'),
    });
    const dmSent = await messages.sendMessage(author, {
      channelId: dm.channelId,
      body: body('the outage caused the breach'),
    });
    /* A DM MEMBER IS in — the positive control proving the check is per-tuple:
       this one must come back, the one above must not. */
    const memberDmSent = await messages.sendMessage(author, {
      channelId: otherDm.channelId,
      body: body('outage postmortem schedule'),
    });

    await indexSentMessage(orgId, publicSent.messageId, open.channelId);
    await indexSentMessage(orgId, dmSent.messageId, dm.channelId);
    await indexSentMessage(orgId, memberDmSent.messageId, otherDm.channelId);

    const tuples = await loadTuples(orgId, MEMBER);
    const caller = callerFactory(
      testContext({
        principal: testPrincipal('member', {
          userId: MEMBER,
          org: { orgId, role: 'member', tuples, memberGrants: [] },
        }),
      }),
    );

    const hits = await caller.search.query({ query: 'outage' });

    const returned = hits.map((hit) => hit.entityId).sort();
    /* The DM between owner and THIRD — which MEMBER holds no tuple on — is
       admitted by RLS (same org) and matches the query, and must NOT be
       returned. The public message and MEMBER's own DM come back. */
    expect(returned).not.toContain(dmSent.messageId);
    expect(returned).toEqual([publicSent.messageId, memberDmSent.messageId].sort());
  });

  it('refuses a guest at the floor — search:query is membership-only', async () => {
    const { orgId } = await scaffold('floor');

    const tuples = await loadTuples(orgId, MEMBER);
    expect(tuples).toEqual([]);

    /* A guest — grants nothing from the role, and no relation grants
       `search:query` — is refused before any row loads. */
    const caller = callerFactory(
      testContext({
        principal: testPrincipal('guest', {
          userId: MEMBER,
          org: { orgId, role: 'guest', tuples, memberGrants: [] },
        }),
      }),
    );

    await expect(caller.search.query({ query: 'outage' })).rejects.toThrow();
  });

  /**
   * Transcripts (Wave 3, migration 0046) — the same per-hit discipline, asked
   * with the one permission that has no target.
   *
   * A transcript is a written record of a private phone call, gated on
   * `recording:read`, which the matrix gives Admin and Owner and withholds
   * from Member. The failure this proves absent is the tempting one: indexing
   * transcripts into the same projection every member queries, and letting the
   * ROUTE FLOOR (`search:query`, which members hold) be the whole decision.
   * That would make search a cheaper door to a recorded conversation than the
   * telephony surface it came from — the exact "two authorization questions,
   * deliberately not merged" failure, arrived at from the other side.
   */
  it('returns a call transcript to an owner and never to a member', async () => {
    const { orgId } = await scaffold('transcript');

    const callId = crypto.randomUUID();
    const recordingId = crypto.randomUUID();
    const transcriptId = crypto.randomUUID();

    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO comms.calls (id, org_id, direction, counterparty_ciphertext, counterparty_index, status)
       VALUES ($1, $2, 'outbound', '\\x01'::bytea, '\\x02'::bytea, 'completed')`,
      [callId, orgId],
    );
    await admin.query(
      `INSERT INTO comms.recordings (id, org_id, call_id, provider_sid, status, storage_key, stored_at)
       VALUES ($1, $2, $3, $4, 'stored', 'recordings/x', now())`,
      [recordingId, orgId, callId, `RE${crypto.randomUUID().replace(/-/g, '')}`],
    );
    await admin.query(
      `INSERT INTO comms.transcripts (id, org_id, recording_id, text)
       VALUES ($1, $2, $3, 'we discussed the outage on the phone')`,
      [transcriptId, orgId, recordingId],
    );
    await admin.setOrg(null);

    expect(await indexTranscript(orgId, { transcriptId })).toBe(true);

    const callerFor = (userId: UserId, role: 'owner' | 'member') =>
      callerFactory(
        testContext({
          principal: testPrincipal(role, {
            userId,
            org: { orgId, role, tuples: [], memberGrants: [] },
          }),
        }),
      );

    const ownerHits = await callerFor(OWNER, 'owner').search.query({ query: 'outage' });
    expect(ownerHits.map((hit) => hit.entityId)).toContain(transcriptId);
    /* The permalink context the client needs — a hit that could not open the
       call would prove only that the index works. */
    expect(ownerHits.find((hit) => hit.entityId === transcriptId)?.metadata).toEqual({
      recording_id: recordingId,
      call_id: callId,
    });

    /* Same org, same query, same indexed row, RLS admits it — and the member
       does not get it, because `recording:read` is answered by role alone. */
    const memberHits = await callerFor(MEMBER, 'member').search.query({ query: 'outage' });
    expect(memberHits.map((hit) => hit.entityId)).not.toContain(transcriptId);
  });
});
