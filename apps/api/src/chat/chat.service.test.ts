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
import type { ChatActor } from './shared.js';

/**
 * Chat against real Postgres (PLAN.md §3.2; ai/phase-5-chat.md §5 Wave 1).
 *
 * The properties worth a real database are the ones decided by something other
 * than this code: a private channel that a role grants access to and a tuple
 * does not, a DM whose uniqueness is a set comparison rather than a unique
 * index, a channel name refused by a partial unique index, and a reply refused
 * by a composite foreign key spanning two channels.
 *
 * Everything here goes through the SERVICES rather than the routes, so `can()`
 * is being asked with real tuples loaded by `loadTuples` — which is the input
 * that decides every assertion below.
 */

/**
 * Fixture ids, in a range no other suite uses.
 *
 * ⚠ The prefix is the isolation mechanism, and getting it wrong fails somewhere
 * else. Every suite here deletes its own users in `beforeAll`/`afterAll`, scoped
 * by id — and turbo runs packages in parallel against one `taskflow_test`, so
 * two suites sharing a prefix delete each other's rows mid-run. The symptom is a
 * foreign-key violation (`memberships_user_id_fkey`) in the OTHER file, which
 * reads as a bug in that file's code and is not.
 *
 * This file originally shared `0195ee00` with `work.service.test.ts` and took 22
 * of its tests down with it — intermittently, because it depends on scheduling.
 *
 *   0195ee00  work.service.test.ts
 *   0195ee01  wave2.service.test.ts
 *   0195ee02  this file
 *   0195ee03  retention.test.ts
 *   0195ee04  guest.test.ts
 */
const ALICE = unsafeAsId<'UserId'>('0195ee02-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195ee02-0000-7000-8000-000000000002');
const CAROL = unsafeAsId<'UserId'>('0195ee02-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [ALICE, 'alice@chat.test'],
  [BOB, 'bob@chat.test'],
  [CAROL, 'carol@chat.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee02-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
const created: OrgId[] = [];

/**
 * Rebuilt from the database on every call, never cached.
 *
 * An actor carries its tuples, and channel membership IS a tuple — so an actor
 * built before someone was added to a channel still holds the old answer.
 * Re-reading here is what makes "add Bob, then act as Bob" mean what it looks
 * like it means, and is the same freshness the HTTP path gets by resolving the
 * membership once per request.
 */
async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<ChatActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

/** A TipTap document with the given text — what the message routes accept. */
function body(text: string): RichTextNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** The error code `fn` rejects with, or a description of why it did not. */
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
  const result = await orgs.createOrg({ name: `Chat ${slug}`, slug }, { userId: ALICE, requestId });
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-chat-test' });
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

describe('channel visibility', () => {
  it('lets any member read a public channel without being added to it', async () => {
    const { orgId, alice } = await scaffold('public-read');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const bob = await actorFor(orgId, BOB, 'member');
    const seen = await channels.getChannel(bob, { channelId: channel.channelId });

    expect(seen.name).toBe('general');
  });

  it('hides a private channel from a member who is not in it', async () => {
    const { orgId, alice } = await scaffold('private-hidden');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });

    const bob = await actorFor(orgId, BOB, 'member');

    /* NOT_FOUND, not FORBIDDEN. A 403 would confirm the channel exists, which
       for a private channel is itself the disclosure — `enforce` derives this
       from `channel:read` also failing, so it falls out of the closed check
       rather than needing a branch. */
    expect(
      await rejectionCode(() => channels.getChannel(bob, { channelId: channel.channelId })),
    ).toBe('NOT_FOUND');
  });

  it('admits the same member once they hold the tuple', async () => {
    const { orgId, alice } = await scaffold('private-admitted');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });

    /* Re-read: `createChannel` just wrote alice's OWN membership tuple on this
       channel, and `alice` here is still the actor built in `scaffold`, before
       that tuple existed. `channel:manage` on a closed channel is decided by
       the tuple, not the role (§3.3) — acting with the stale actor would deny
       this with NOT_FOUND, for the same reason a real request wouldn't: each
       HTTP call rebuilds the actor from the database, this test must too. */
    const aliceWithChannel = await actorFor(orgId, ALICE, 'owner');
    await channels.addChannelMember(aliceWithChannel, {
      channelId: channel.channelId,
      userId: BOB,
    });

    const bob = await actorFor(orgId, BOB, 'member');
    const seen = await channels.getChannel(bob, { channelId: channel.channelId });

    expect(seen.name).toBe('leadership');
    expect(seen.memberIds).toContain(BOB);
  });

  it('omits channels the caller cannot open from the list', async () => {
    /* The list and the individual read must agree. A channel visible in the
       sidebar that 404s when clicked is the failure mode of deriving the list
       from a different source than `can()` uses. */
    const { orgId, alice } = await scaffold('list-agrees');
    await channels.createChannel(alice, { type: 'public', name: 'general' });
    await channels.createChannel(alice, { type: 'private', name: 'leadership' });

    const bob = await actorFor(orgId, BOB, 'member');
    const visible = await channels.listChannels(bob);

    expect(visible.channels.map((channel) => channel.name)).toEqual(['general']);
  });

  it('refuses a second channel with the same name', async () => {
    const { alice } = await scaffold('duplicate-name');
    await channels.createChannel(alice, { type: 'public', name: 'general' });

    // Case-insensitively — the partial unique index is on `lower(name)`. Two
    // #General channels is a data-entry accident that makes every "which one did
    // they mean" conversation permanent.
    expect(
      await rejectionCode(() => channels.createChannel(alice, { type: 'public', name: 'General' })),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('direct messages', () => {
  it('returns the same channel when reopened, rather than a second one', async () => {
    /* The property with no unique index behind it. Two DMs between the same pair
       splits their history in half with no error anywhere — each person sees
       whichever one their client opened, and messages appear to vanish. */
    const { orgId, alice } = await scaffold('dm-unique');

    const first = await channels.openDirectMessage(alice, { userIds: [BOB] });

    // Re-read before the second call: `findDirectMessage` matches against the
    // CALLER's already-loaded tuples (§3.1's docstring), and the first call
    // wrote alice's tuple on the new DM to the database, not onto this JS
    // object. Reusing the stale actor would make the second call blind to the
    // conversation it is supposed to find, same as every other closed-channel
    // case in this file.
    const aliceAfterFirst = await actorFor(orgId, ALICE, 'owner');
    const second = await channels.openDirectMessage(aliceAfterFirst, { userIds: [BOB] });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.channelId).toBe(first.channelId);
  });

  it('finds the conversation from the OTHER participant too', async () => {
    const { orgId, alice } = await scaffold('dm-symmetric');
    const opened = await channels.openDirectMessage(alice, { userIds: [BOB] });

    const bob = await actorFor(orgId, BOB, 'member');
    const reopened = await channels.openDirectMessage(bob, { userIds: [ALICE] });

    expect(reopened.created).toBe(false);
    expect(reopened.channelId).toBe(opened.channelId);
  });

  it('treats a group DM as a different conversation from the pair', async () => {
    /* Set EQUALITY, not subset. A subset test would match the two-person DM when
       opening a three-person group and hand a private conversation a third
       participant it never had. */
    const { alice } = await scaffold('dm-group');

    const pair = await channels.openDirectMessage(alice, { userIds: [BOB] });
    const group = await channels.openDirectMessage(alice, { userIds: [BOB, CAROL] });

    expect(group.created).toBe(true);
    expect(group.channelId).not.toBe(pair.channelId);
  });

  it('hides a DM from everyone who is not in it', async () => {
    const { orgId, alice } = await scaffold('dm-private');
    const dm = await channels.openDirectMessage(alice, { userIds: [BOB] });

    const carol = await actorFor(orgId, CAROL, 'member');

    expect(await rejectionCode(() => channels.getChannel(carol, { channelId: dm.channelId }))).toBe(
      'NOT_FOUND',
    );
  });

  it('refuses to open one with a person from outside the org', async () => {
    /* Writing a membership tuple naming a stranger is not a breach on its own —
       `resolveOrgMembership` would still refuse them — but a chat feature that
       can write authorization rows about people who have never heard of the org
       is not something to leave available. */
    const { alice } = await scaffold('dm-stranger');
    const outsider = unsafeAsId<'UserId'>('0195ee02-0000-7000-8000-0000000000aa');

    expect(
      await rejectionCode(() => channels.openDirectMessage(alice, { userIds: [outsider] })),
    ).toBe('NOT_FOUND');
  });

  it('cannot have participants added to it after the fact', async () => {
    const { orgId, alice } = await scaffold('dm-fixed');
    const dm = await channels.openDirectMessage(alice, { userIds: [BOB] });

    // Re-read for the same reason as the private-channel case above: opening
    // the DM just wrote alice's own tuple on it, which the stale actor from
    // `scaffold` does not carry.
    const aliceInDm = await actorFor(orgId, ALICE, 'owner');

    // Adding a third person would silently expose the entire history to someone
    // who was not part of it. The group DM they wanted is a NEW channel.
    expect(
      await rejectionCode(() =>
        channels.addChannelMember(aliceInDm, { channelId: dm.channelId, userId: CAROL }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('messages', () => {
  it('refuses a post from someone who cannot read the channel', async () => {
    const { orgId, alice } = await scaffold('post-denied');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });

    const bob = await actorFor(orgId, BOB, 'member');

    expect(
      await rejectionCode(() =>
        messages.sendMessage(bob, { channelId: channel.channelId, body: body('hello') }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses an empty document', async () => {
    const { alice } = await scaffold('post-empty');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    // A document that renders to nothing is an empty message with structure —
    // a line nobody can see and a notification about nothing.
    expect(
      await rejectionCode(() =>
        messages.sendMessage(alice, {
          channelId: channel.channelId,
          body: { type: 'doc', content: [{ type: 'paragraph' }] },
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('lets only the author edit, with no permission override', async () => {
    const { orgId, alice } = await scaffold('edit-author');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const bob = await actorFor(orgId, BOB, 'member');
    const posted = await messages.sendMessage(bob, {
      channelId: channel.channelId,
      body: body('bob wrote this'),
    });

    /* Alice is the org OWNER and holds every permission there is. She still
       cannot rewrite Bob's words — a discussion where an administrator can put
       words in your mouth is not a record of anything. */
    expect(
      await rejectionCode(() =>
        messages.editMessage(alice, {
          messageId: posted.messageId,
          body: body('alice wrote this'),
        }),
      ),
    ).toBe('FORBIDDEN');

    await expect(
      messages.editMessage(bob, { messageId: posted.messageId, body: body('bob edited this') }),
    ).resolves.toEqual({ edited: true });
  });

  it('lets a moderator delete what they cannot edit', async () => {
    const { orgId, alice } = await scaffold('delete-moderator');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const bob = await actorFor(orgId, BOB, 'member');
    const posted = await messages.sendMessage(bob, {
      channelId: channel.channelId,
      body: body('bob wrote this'),
    });

    await expect(messages.deleteMessage(alice, { messageId: posted.messageId })).resolves.toEqual({
      deleted: true,
    });
  });

  it('does not let an ordinary member delete someone else’s message', async () => {
    /* `message:delete` was removed from the member role in Phase 5. Before that,
       any colleague could erase any message in any channel they could read —
       which is not what "member" means anywhere else in the matrix. */
    const { orgId, alice } = await scaffold('delete-peer');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const posted = await messages.sendMessage(alice, {
      channelId: channel.channelId,
      body: body('alice wrote this'),
    });

    const bob = await actorFor(orgId, BOB, 'member');

    expect(
      await rejectionCode(() => messages.deleteMessage(bob, { messageId: posted.messageId })),
    ).toBe('FORBIDDEN');
  });

  it('keeps a deleted message in place and strips its content', async () => {
    const { alice } = await scaffold('delete-tombstone');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const posted = await messages.sendMessage(alice, {
      channelId: channel.channelId,
      body: body('regrettable'),
    });
    await messages.deleteMessage(alice, { messageId: posted.messageId });

    const listed = await messages.listMessages(alice, { channelId: channel.channelId });
    const tombstone = listed.find((message) => message.messageId === posted.messageId);

    // Still there — a thread that loses its middle becomes incoherent — but the
    // body is gone, because "delete" must not mean "hide in the UI".
    expect(tombstone).toBeDefined();
    expect(tombstone?.body).toBeNull();
    expect(tombstone?.bodyText).toBe('');
  });

  it('hides a message for the viewer only — everyone else still sees it', async () => {
    const { orgId, alice } = await scaffold('hide-per-viewer');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const bob = await actorFor(orgId, BOB, 'member');
    const carol = await actorFor(orgId, CAROL, 'member');
    const posted = await messages.sendMessage(bob, {
      channelId: channel.channelId,
      body: body('bob wrote this'),
    });

    // A plain member hides someone else's message — "remove for me" needs no
    // moderation permission, it only changes the hider's own list.
    await expect(messages.hideMessage(bob, { messageId: posted.messageId })).resolves.toEqual({
      hidden: true,
    });

    const forBob = await messages.listMessages(bob, { channelId: channel.channelId });
    expect(forBob.find((message) => message.messageId === posted.messageId)).toBeUndefined();

    // Carol, who never hid it, still reads it.
    const forCarol = await messages.listMessages(carol, { channelId: channel.channelId });
    const visible = forCarol.find((message) => message.messageId === posted.messageId);
    expect(visible).toBeDefined();
    expect(visible?.bodyText).toBe('bob wrote this');
  });

  it('hides a message only for the hider, not for the author', async () => {
    const { orgId, alice } = await scaffold('hide-author-keeps');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const bob = await actorFor(orgId, BOB, 'member');
    const posted = await messages.sendMessage(bob, {
      channelId: channel.channelId,
      body: body('still mine'),
    });

    // The AUTHOR hides their own message from their view — the row must not
    // affect what the hider sees anywhere else, and hiding is not deletion.
    await messages.hideMessage(bob, { messageId: posted.messageId });

    const forAlice = await messages.listMessages(alice, { channelId: channel.channelId });
    const visible = forAlice.find((message) => message.messageId === posted.messageId);
    expect(visible).toBeDefined();
    expect(visible?.bodyText).toBe('still mine');

    // Hiding again is idempotent — the composite PK is (user, message), so a
    // second hide of the same message must not violate it.
    await expect(messages.hideMessage(bob, { messageId: posted.messageId })).resolves.toEqual({
      hidden: true,
    });
  });

  it('refuses a reply to a message in a different channel', async () => {
    /* The composite foreign key's job (migration 0017). RLS says nothing about
       this: both messages are in one tenant, so `withOrgScope` sees nothing
       wrong with a reply whose parent lives in a channel the author has never
       been a member of. */
    const { alice } = await scaffold('reply-cross-channel');
    const first = await channels.createChannel(alice, { type: 'public', name: 'general' });
    const second = await channels.createChannel(alice, { type: 'public', name: 'random' });

    const parent = await messages.sendMessage(alice, {
      channelId: first.channelId,
      body: body('parent'),
    });

    expect(
      await rejectionCode(() =>
        messages.sendMessage(alice, {
          channelId: second.channelId,
          body: body('reply'),
          parentMessageId: parent.messageId,
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses a reply to a reply', async () => {
    const { alice } = await scaffold('reply-depth');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const parent = await messages.sendMessage(alice, {
      channelId: channel.channelId,
      body: body('parent'),
    });
    const reply = await messages.sendMessage(alice, {
      channelId: channel.channelId,
      body: body('reply'),
      parentMessageId: parent.messageId,
    });

    // One level, enforced by the service — the database cannot express "my
    // parent's parent must be null" without a trigger.
    expect(
      await rejectionCode(() =>
        messages.sendMessage(alice, {
          channelId: channel.channelId,
          body: body('nested'),
          parentMessageId: reply.messageId,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('membership changes', () => {
  it('lets a member join a public channel themselves', async () => {
    const { orgId, alice } = await scaffold('join-public');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const bob = await actorFor(orgId, BOB, 'member');
    await expect(
      channels.addChannelMember(bob, { channelId: channel.channelId, userId: BOB }),
    ).resolves.toEqual({ added: true });
  });

  it('does not let a member add SOMEONE ELSE to a public channel', async () => {
    /* Self-join is `channel:read`; adding another person is `channel:manage`.
       The route cannot tell those apart — it runs before the row is loaded — so
       this is decided in the service, and this test is what holds that split in
       place. */
    const { orgId, alice } = await scaffold('add-other');
    const channel = await channels.createChannel(alice, { type: 'public', name: 'general' });

    const bob = await actorFor(orgId, BOB, 'member');

    expect(
      await rejectionCode(() =>
        channels.addChannelMember(bob, { channelId: channel.channelId, userId: CAROL }),
      ),
    ).toBe('FORBIDDEN');
  });

  it('lets anyone leave a channel they are in', async () => {
    const { orgId, alice } = await scaffold('leave-self');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });
    const aliceWithChannel = await actorFor(orgId, ALICE, 'owner');
    await channels.addChannelMember(aliceWithChannel, {
      channelId: channel.channelId,
      userId: BOB,
    });

    const bob = await actorFor(orgId, BOB, 'member');
    await expect(
      channels.removeChannelMember(bob, { channelId: channel.channelId, userId: BOB }),
    ).resolves.toEqual({ removed: true });

    // And the channel is invisible again immediately after — the tuple was the
    // only thing granting access, so removing it is the whole revocation.
    const after = await actorFor(orgId, BOB, 'member');
    expect(
      await rejectionCode(() => channels.getChannel(after, { channelId: channel.channelId })),
    ).toBe('NOT_FOUND');
  });

  it('is idempotent when adding an existing member', async () => {
    const { orgId, alice } = await scaffold('add-twice');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });
    const aliceWithChannel = await actorFor(orgId, ALICE, 'owner');

    await channels.addChannelMember(aliceWithChannel, {
      channelId: channel.channelId,
      userId: BOB,
    });

    // The unique index on the tuple would refuse the second row anyway;
    // answering cleanly keeps a double-click from surfacing a constraint error.
    await expect(
      channels.addChannelMember(aliceWithChannel, { channelId: channel.channelId, userId: BOB }),
    ).resolves.toEqual({ added: false });
  });
});

describe('the outbox', () => {
  it('records one event per membership change, naming the person', async () => {
    /* Per person, not a set diff. The consumer that acts on this is the
       gateway's force-leave, which cares about ONE socket's authorization and
       would otherwise have to iterate a list to find itself. */
    const { orgId, alice } = await scaffold('events');
    const channel = await channels.createChannel(alice, { type: 'private', name: 'leadership' });
    const aliceWithChannel = await actorFor(orgId, ALICE, 'owner');
    await channels.addChannelMember(aliceWithChannel, {
      channelId: channel.channelId,
      userId: BOB,
    });

    await admin.setOrg(orgId);
    const { rows } = await admin.query(
      `SELECT name, payload FROM platform.outbox WHERE org_id = $1 ORDER BY id`,
      [orgId],
    );
    await admin.setOrg(null);

    const added = rows.filter((row) => row['name'] === 'channel.member_added');

    // Two: the creator, written in the same transaction as the channel, and Bob.
    expect(added).toHaveLength(2);
    expect(
      added.map((row) => (row['payload'] as { userId?: string } | null)?.userId).sort(),
    ).toEqual([ALICE, BOB].sort());
  });
});
