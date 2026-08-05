import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import type { RichTextNode } from '../work/richtext.js';
import * as channels from './channel.service.js';
import * as messages from './message.service.js';
import * as reactions from './reaction.service.js';
import * as pins from './pin.service.js';
import * as readCursors from './read-cursor.service.js';
import type { ChatActor } from './shared.js';

/**
 * Chat Wave 2 — reactions, pins, read cursors (ai/phase-5-chat.md §5) against
 * real Postgres, same reasoning as `chat.service.test.ts`: the properties
 * worth asserting here are decided by the composite foreign keys (a reaction
 * or pin cannot name a message in another channel even when both ids are
 * real) and by `can()` deciding a closed channel, neither of which a unit
 * test against a mock would exercise.
 */

const ALICE = unsafeAsId<'UserId'>('0195ee01-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195ee01-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [ALICE, 'alice@wave2.test'],
  [BOB, 'bob@wave2.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee01-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<ChatActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

function body(text: string): RichTextNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

async function rejectionCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'no error thrown';
  } catch (error) {
    return isAppError(error) ? error.code : `not an AppError: ${String(error)}`;
  }
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
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

interface Fixture {
  readonly orgId: OrgId;
  readonly alice: ChatActor;
}

async function scaffold(slug: string): Promise<Fixture> {
  const result = await orgs.createOrg({ name: `Wave2 ${slug}`, slug }, { userId: ALICE, requestId });
  created.push(result.orgId);

  const alice = await actorFor(result.orgId, ALICE, 'owner');

  for (const [userId, email] of USERS) {
    if (userId === ALICE) continue;
    await members.addMember(result.orgId, { email, role: 'member' }, { userId: ALICE, requestId });
  }

  return { orgId: result.orgId, alice };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-wave2-test' });
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

describe('reactions', () => {
  it('toggles a reaction on and off', async () => {
    const { orgId, alice } = await scaffold('react-toggle');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const sent = await messages.sendMessage(alice, { channelId: channel.channelId, body: body('hi') });

    const first = await reactions.toggleReaction(alice, {
      channelId: channel.channelId,
      messageId: sent.messageId,
      emoji: '👍',
    });
    expect(first.reacted).toBe(true);

    const listed = await reactions.listReactions(alice, {
      channelId: channel.channelId,
      messageIds: [sent.messageId],
    });
    expect(listed).toEqual([{ messageId: sent.messageId, userId: ALICE, emoji: '👍' }]);

    const second = await reactions.toggleReaction(alice, {
      channelId: channel.channelId,
      messageId: sent.messageId,
      emoji: '👍',
    });
    expect(second.reacted).toBe(false);

    const listedAfter = await reactions.listReactions(alice, {
      channelId: channel.channelId,
      messageIds: [sent.messageId],
    });
    expect(listedAfter).toEqual([]);

    void orgId;
  });

  it('refuses to react to a message in a different channel', async () => {
    const { alice } = await scaffold('react-cross-channel');
    const channelA = await channels.createChannel(alice, { type: 'public', name: 'a' });
    const channelB = await channels.createChannel(alice, { type: 'public', name: 'b' });
    const sent = await messages.sendMessage(alice, { channelId: channelA.channelId, body: body('hi') });

    expect(
      await rejectionCode(() =>
        reactions.toggleReaction(alice, {
          channelId: channelB.channelId,
          messageId: sent.messageId,
          emoji: '👍',
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses an oversized emoji string', async () => {
    const { alice } = await scaffold('react-oversized');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const sent = await messages.sendMessage(alice, { channelId: channel.channelId, body: body('hi') });

    expect(
      await rejectionCode(() =>
        reactions.toggleReaction(alice, {
          channelId: channel.channelId,
          messageId: sent.messageId,
          emoji: 'x'.repeat(33),
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('hides a private channel from someone not in it, even to react', async () => {
    const { orgId, alice } = await scaffold('react-private-hidden');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });

    /* Rebuilt AFTER the channel exists. `createChannel` writes the creator's own
       `member` tuple, and an actor captured before that call does not carry it —
       so posting into your own private channel is refused, which reads as a bug
       in the service rather than a stale fixture. */
    const author = await actorFor(orgId, ALICE, 'owner');
    const sent = await messages.sendMessage(author, {
      channelId: channel.channelId,
      body: body('hi'),
    });

    const bob = await actorFor(orgId, BOB, 'member');

    expect(
      await rejectionCode(() =>
        reactions.toggleReaction(bob, {
          channelId: channel.channelId,
          messageId: sent.messageId,
          emoji: '👍',
        }),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('pins', () => {
  it('pins and unpins a message, idempotently', async () => {
    const { alice } = await scaffold('pin-toggle');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const sent = await messages.sendMessage(alice, { channelId: channel.channelId, body: body('hi') });

    const first = await pins.pinMessage(alice, { channelId: channel.channelId, messageId: sent.messageId });
    expect(first.pinned).toBe(true);

    // Pinning again is a no-op, not an error.
    const again = await pins.pinMessage(alice, { channelId: channel.channelId, messageId: sent.messageId });
    expect(again.pinned).toBe(false);

    const listed = await pins.listPinnedMessages(alice, { channelId: channel.channelId });
    expect(listed.map((row) => row.messageId)).toEqual([sent.messageId]);

    const unpinned = await pins.unpinMessage(alice, {
      channelId: channel.channelId,
      messageId: sent.messageId,
    });
    expect(unpinned.unpinned).toBe(true);

    // Unpinning something not pinned is a no-op, not an error.
    const unpinnedAgain = await pins.unpinMessage(alice, {
      channelId: channel.channelId,
      messageId: sent.messageId,
    });
    expect(unpinnedAgain.unpinned).toBe(false);

    const listedAfter = await pins.listPinnedMessages(alice, { channelId: channel.channelId });
    expect(listedAfter).toEqual([]);
  });

  it('refuses to pin a message in a different channel', async () => {
    const { alice } = await scaffold('pin-cross-channel');
    const channelA = await channels.createChannel(alice, { type: 'public', name: 'a' });
    const channelB = await channels.createChannel(alice, { type: 'public', name: 'b' });
    const sent = await messages.sendMessage(alice, { channelId: channelA.channelId, body: body('hi') });

    expect(
      await rejectionCode(() =>
        pins.pinMessage(alice, { channelId: channelB.channelId, messageId: sent.messageId }),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('read cursors', () => {
  it('advances the cursor and reports zero unread once caught up', async () => {
    const { orgId, alice } = await scaffold('read-advance');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    await messages.sendMessage(alice, { channelId: channel.channelId, body: body('one') });
    const two = await messages.sendMessage(alice, { channelId: channel.channelId, body: body('two') });
    await messages.sendMessage(alice, { channelId: channel.channelId, body: body('three') });

    const beforeCounts = await readCursors.unreadCounts(alice, { channelIds: [channel.channelId] });
    /* Null, not the first message's id: this person has never opened the
       channel, so there is no cursor — which is what tells a client to draw no
       "new messages" divider rather than one above the whole conversation. */
    expect(beforeCounts).toEqual([
      { channelId: channel.channelId, unreadCount: 3, lastReadMessageId: null },
    ]);

    const advanced = await readCursors.markRead(alice, {
      channelId: channel.channelId,
      messageId: two.messageId,
    });
    expect(advanced.advanced).toBe(true);

    const midCounts = await readCursors.unreadCounts(alice, { channelIds: [channel.channelId] });
    expect(midCounts).toEqual([
      { channelId: channel.channelId, unreadCount: 1, lastReadMessageId: two.messageId },
    ]);

    void orgId;
  });

  it('refuses to move the cursor backward', async () => {
    const { alice } = await scaffold('read-no-rewind');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const one = await messages.sendMessage(alice, { channelId: channel.channelId, body: body('one') });
    const two = await messages.sendMessage(alice, { channelId: channel.channelId, body: body('two') });

    await readCursors.markRead(alice, { channelId: channel.channelId, messageId: two.messageId });

    const rewound = await readCursors.markRead(alice, {
      channelId: channel.channelId,
      messageId: one.messageId,
    });
    expect(rewound.advanced).toBe(false);

    const counts = await readCursors.unreadCounts(alice, { channelIds: [channel.channelId] });
    /* The cursor stayed on `two` — that is what "refuses to move backward"
       means, and reporting it is how a client can tell a rewind was ignored. */
    expect(counts).toEqual([
      { channelId: channel.channelId, unreadCount: 0, lastReadMessageId: two.messageId },
    ]);
  });

  it('drops a channel the caller cannot read from the unread counts, silently', async () => {
    const { orgId, alice } = await scaffold('read-unreadable');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });

    // Rebuilt after creation — see the note in the reactions suite above.
    const author = await actorFor(orgId, ALICE, 'owner');
    await messages.sendMessage(author, { channelId: channel.channelId, body: body('secret') });

    const bob = await actorFor(orgId, BOB, 'member');
    const counts = await readCursors.unreadCounts(bob, { channelIds: [channel.channelId] });

    expect(counts).toEqual([]);
  });
});
