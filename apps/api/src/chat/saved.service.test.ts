import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
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
import * as saved from './saved.service.js';
import type { ChatActor } from './shared.js';

/**
 * Saved messages (ai/phase-5-chat.md §2, Wave 2) against real Postgres, same
 * reasoning as `wave2.service.test.ts`'s pins suite: the property worth
 * proving here is `listSaved`'s per-channel re-check on read, which a mocked
 * database would only prove agrees with itself about.
 */

const ALICE = unsafeAsId<'UserId'>('0195ee02-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195ee02-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [ALICE, 'alice@saved.test'],
  [BOB, 'bob@saved.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee02-0000-7000-8000-0000000000ff');

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
    'chat.saved_messages',
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
  const result = await orgs.createOrg(
    { name: `Saved ${slug}`, slug },
    { userId: ALICE, requestId },
  );
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-saved-test' });
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

describe('save / unsave', () => {
  it('saves and unsaves a message, idempotently', async () => {
    const { alice } = await scaffold('save-toggle');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const sent = await messages.sendMessage(alice, {
      channelId: channel.channelId,
      body: body('hi'),
    });

    const first = await saved.saveMessage(alice, { messageId: sent.messageId });
    expect(first.saved).toBe(true);

    // Saving twice is a double-click, not an error.
    await saved.saveMessage(alice, { messageId: sent.messageId });

    const listed = await saved.listSaved(alice);
    expect(listed.map((row) => row.messageId)).toEqual([sent.messageId]);

    const unsaved = await saved.unsaveMessage(alice, { messageId: sent.messageId });
    expect(unsaved.saved).toBe(false);

    // Unsaving something not saved is a no-op, not an error.
    await saved.unsaveMessage(alice, { messageId: sent.messageId });

    expect(await saved.listSaved(alice)).toEqual([]);
  });

  it('is personal — one person saving a message does not save it for another', async () => {
    const { orgId, alice } = await scaffold('save-personal');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const sent = await messages.sendMessage(alice, {
      channelId: channel.channelId,
      body: body('hi'),
    });

    await saved.saveMessage(alice, { messageId: sent.messageId });

    const bob = await actorFor(orgId, BOB, 'member');
    expect(await saved.listSaved(bob)).toEqual([]);
  });
});

describe('listSaved — with channel info and an excerpt', () => {
  it('aggregates saves from more than one channel', async () => {
    const { orgId, alice: creator } = await scaffold('save-aggregate');
    const general = await channels.createChannel(creator, { type: 'public', name: 'general' });
    const secret = await channels.createChannel(creator, { type: 'private', name: 'secret' });

    /* `secret` is CLOSED (`decide.ts`'s `target.closed` bypasses role
       entirely), so `creator`'s pre-existing snapshot — captured before
       `secret` existed — does not carry the `member` tuple `createChannel`
       just wrote for her on it. Same trap `wave2.service.test.ts`'s own
       reaction suite already documents. */
    const alice = await actorFor(orgId, ALICE, 'owner');

    const first = await messages.sendMessage(alice, {
      channelId: general.channelId,
      body: body('hello from general'),
    });
    const second = await messages.sendMessage(alice, {
      channelId: secret.channelId,
      body: body('hello from secret'),
    });

    await saved.saveMessage(alice, { messageId: first.messageId });
    await saved.saveMessage(alice, { messageId: second.messageId });

    const all = await saved.listSaved(alice);
    const byId = new Map(all.map((row) => [row.messageId, row]));

    expect(all).toHaveLength(2);
    expect(byId.get(first.messageId)).toMatchObject({
      channelId: general.channelId,
      channelName: 'general',
      channelType: 'public',
      excerpt: 'hello from general',
    });
    expect(byId.get(second.messageId)).toMatchObject({
      channelId: secret.channelId,
      channelName: 'secret',
      channelType: 'private',
      excerpt: 'hello from secret',
    });
  });

  it('stops resolving a save in a channel the caller has since lost access to', async () => {
    const { orgId, alice: preCreation } = await scaffold('save-lost-access');

    const priv = await channels.createChannel(preCreation, { type: 'private', name: 'secret' });
    // Refreshed: `preCreation` does not carry the tuple `createChannel` just
    // wrote for her on `priv`, and `addChannelMember` needs `channel:manage`
    // on it to add someone else.
    const alice = await actorFor(orgId, ALICE, 'owner');
    await channels.addChannelMember(alice, { channelId: priv.channelId, userId: BOB });

    const bob = await actorFor(orgId, BOB, 'member');
    const sent = await messages.sendMessage(bob, {
      channelId: priv.channelId,
      body: body('careful now'),
    });
    await saved.saveMessage(bob, { messageId: sent.messageId });

    expect((await saved.listSaved(bob)).map((row) => row.messageId)).toEqual([sent.messageId]);

    await channels.removeChannelMember(alice, { channelId: priv.channelId, userId: BOB });

    // The bookmark survives — it is Bob's — but it must stop resolving rather
    // than re-disclosing a channel he was removed from.
    const bobAfterRemoval = await actorFor(orgId, BOB, 'member');
    expect(await saved.listSaved(bobAfterRemoval)).toEqual([]);
  });

  it('reports a deleted message as gone rather than re-showing its content', async () => {
    const { alice } = await scaffold('save-deleted');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const sent = await messages.sendMessage(alice, {
      channelId: channel.channelId,
      body: body('temporary'),
    });
    await saved.saveMessage(alice, { messageId: sent.messageId });

    await messages.deleteMessage(alice, { messageId: sent.messageId });

    const all = await saved.listSaved(alice);
    expect(all).toHaveLength(1);
    expect(all[0]?.excerpt).toBeNull();
  });
});
