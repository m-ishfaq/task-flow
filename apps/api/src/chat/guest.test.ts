import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV, testAppRouter, testContext, testPrincipal } from '../testing/fixtures.js';
import { createCallerFactory } from '../trpc/builder.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as channels from './channel.service.js';
import * as messages from './message.service.js';
import * as compliance from './compliance.service.js';
import type { RichTextNode } from '../work/richtext.js';
import type { ChatActor } from './shared.js';

/**
 * Guest access (Wave 4, ai/phase-5-chat.md §3.8, §7.4).
 *
 * ⚠ Covers a human-review surface: guest access is written as relationship
 * tuples, the input to `can()`.
 *
 * ## The property under test is an ABSENCE
 *
 * §3.8's whole design is that a guest needs no new mechanism. `GUEST` grants
 * nothing from the role (`roles.ts` has it as an empty list), so a guest's
 * access IS the `member` tuple on one channel — the same row an ordinary
 * member's membership is, marked `is_guest` only so an access review can see
 * it. There is no `if (isGuest)` branch anywhere, and these tests exist to
 * prove that the absence produces the right answers rather than a hole.
 *
 * The two that matter most:
 *
 *   `reaches exactly one channel and nothing else` — the containment property.
 *     A guest holding one tuple must not read a second private channel, and
 *     must not read PUBLIC channels either, which is the non-obvious half: a
 *     member gets those from their role, and a guest has no role.
 *
 *   `cannot be invited to a direct message` — §7.4, answered no. Channel-scoped
 *     is the definition of a guest; "a guest who can DM anyone in the org" is an
 *     external party with a messaging channel into a company that invited them
 *     to one conversation.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee04-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee04-0000-7000-8000-000000000002');
/** Holds a `guest` membership row: no permissions from the role at all. */
const GUEST = unsafeAsId<'UserId'>('0195ee04-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@guest.test'],
  [MEMBER, 'member@guest.test'],
  [GUEST, 'guest@guest.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee04-0000-7000-8000-0000000000ff');

/* Wired once, at module scope: this only assembles the router structure and
   touches no connection, so it is safe before `beforeAll` opens the pool. */
const { router: chatAppRouter } = testAppRouter();
const callerFactory = createCallerFactory(chatAppRouter);

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

interface Fixture {
  readonly orgId: OrgId;
  readonly owner: ChatActor;
  /**
   * Re-reads the owner's tuples.
   *
   * `createChannel` writes the creator's own membership tuple, so an actor
   * captured before that call does not carry it — and a PRIVATE channel is
   * closed, so its creator is denied their own channel until the actor is
   * rebuilt. Every test here creates channels and then acts on them, which is
   * exactly the shape that trips over it.
   */
  readonly refreshOwner: () => Promise<ChatActor>;
}

async function scaffold(slug: string): Promise<Fixture> {
  const result = await orgs.createOrg(
    { name: `Guest ${slug}`, slug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  await members.addMember(
    result.orgId,
    { email: 'member@guest.test', role: 'member' },
    { userId: OWNER, requestId },
  );
  await members.addMember(
    result.orgId,
    { email: 'guest@guest.test', role: 'guest' },
    { userId: OWNER, requestId },
  );

  return {
    orgId: result.orgId,
    owner: await actorFor(result.orgId, OWNER, 'owner'),
    refreshOwner: () => actorFor(result.orgId, OWNER, 'owner'),
  };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-guest-test' });
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

describe('a guest with no grant', () => {
  it('cannot read a private channel', async () => {
    const { orgId, owner } = await scaffold('guest-none');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'leadership' });

    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(
      await rejectionCode(() => channels.getChannel(guest, { channelId: channel.channelId })),
    ).toBe('NOT_FOUND');
  });

  it('cannot read a PUBLIC channel either', async () => {
    /* The non-obvious half, and the reason `GUEST` is an empty permission list.
       A member reads public channels from their ROLE; a guest has no role
       grants at all, so a public channel is as invisible to them as a private
       one until somebody hands them a tuple. */
    const { orgId, owner } = await scaffold('guest-public');
    const channel = await channels.createChannel(owner, { type: 'public', name: 'general' });

    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(
      await rejectionCode(() => channels.getChannel(guest, { channelId: channel.channelId })),
    ).toBe('NOT_FOUND');
  });

  it('sees an empty channel list', async () => {
    const { orgId, owner } = await scaffold('guest-list-empty');
    await channels.createChannel(owner, { type: 'public', name: 'general' });
    await channels.createChannel(owner, { type: 'private', name: 'leadership' });

    const guest = await actorFor(orgId, GUEST, 'guest');
    /* `listChannels` now answers `{ canCreateChannel, channels }` — the
       sidebar gates its "new channel" control on the server's verdict, so
       the shape changed even though the empty channel list did not. */
    expect((await channels.listChannels(guest)).channels).toEqual([]);
  });
});

describe('a guest granted one channel', () => {
  it('can read and post in exactly that channel', async () => {
    const { orgId, owner, refreshOwner } = await scaffold('guest-granted');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    const guest = await actorFor(orgId, GUEST, 'guest');

    const seen = await channels.getChannel(guest, { channelId: channel.channelId });
    expect(seen.name).toBe('project-x');

    /* Posting works because the `member` relation's grant set includes
       `message:create` — written in Phase 2, for exactly this. No branch in
       chat consults `is_guest`. */
    await expect(
      messages.sendMessage(guest, { channelId: channel.channelId, body: body('hello') }),
    ).resolves.toBeDefined();
  });

  it('reaches exactly one channel and nothing else', async () => {
    /* The containment property. A guest holding a tuple on one channel must not
       thereby reach a second — which is the whole promise of "channel-scoped
       guest access for external collaborators". */
    const { orgId, owner, refreshOwner } = await scaffold('guest-contained');
    const invited = await channels.createChannel(owner, { type: 'private', name: 'project-x' });
    const other = await channels.createChannel(owner, { type: 'private', name: 'leadership' });
    const open = await channels.createChannel(owner, { type: 'public', name: 'general' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: invited.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    const guest = await actorFor(orgId, GUEST, 'guest');

    expect((await channels.listChannels(guest)).channels.map((row) => row.name)).toEqual([
      'project-x',
    ]);
    expect(
      await rejectionCode(() => channels.getChannel(guest, { channelId: other.channelId })),
    ).toBe('NOT_FOUND');
    expect(
      await rejectionCode(() => channels.getChannel(guest, { channelId: open.channelId })),
    ).toBe('NOT_FOUND');
  });

  it('loses access the moment the grant is revoked', async () => {
    const { orgId, owner, refreshOwner } = await scaffold('guest-revoked');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });
    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: false,
      expiresAt: null,
    });

    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(
      await rejectionCode(() => channels.getChannel(guest, { channelId: channel.channelId })),
    ).toBe('NOT_FOUND');
  });

  it('loses access when the grant expires, with no sweep involved', async () => {
    /* `expiresAt` is enforced in `loadTuples`' WHERE clause rather than by a
        cleanup job, so a contractor's access stops working at the moment it
        lapses instead of whenever a sweep next runs. Granted in the PAST here,
        which is the same thing an expiry that has just elapsed looks like. */
    const { orgId, owner, refreshOwner } = await scaffold('guest-expired');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const guest = await actorFor(orgId, GUEST, 'guest');
    expect(
      await rejectionCode(() => channels.getChannel(guest, { channelId: channel.channelId })),
    ).toBe('NOT_FOUND');
  });

  it('is marked as a guest on the tuple, for access review', async () => {
    /* The one thing `is_guest` is for. It changes nothing about how `can()`
       reads the row — that is the design — so its only job is answering "who
       here is external", which the tuple could not otherwise be asked. */
    const { orgId, owner, refreshOwner } = await scaffold('guest-marked');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    await admin.setOrg(orgId);
    const result = await admin.query(
      `SELECT is_guest FROM authz.relationship_tuples
       WHERE org_id = $1 AND subject_id = $2 AND object_id = $3`,
      [orgId, GUEST, channel.channelId],
    );
    await admin.setOrg(null);

    expect((result.rows as { is_guest: boolean }[])[0]?.is_guest).toBe(true);
  });
});

describe('listChannelGuests — the invite panel roster', () => {
  it('lists a granted guest, with their expiry', async () => {
    const { owner, refreshOwner } = await scaffold('guest-list-granted');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });
    const expiresAt = new Date(Date.now() + 60_000 * 60 * 24);

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt,
    });

    const rows = await compliance.listChannelGuests(await refreshOwner(), {
      channelId: channel.channelId,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(GUEST);
    expect(rows[0]?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('does not list an ordinary member alongside a guest', async () => {
    /* `is_guest` is the whole filter — a `member` tuple written by the everyday
       `addChannelMember` path (never `is_guest`) must not appear in a roster
       whose entire purpose is "who here is external". */
    const { owner, refreshOwner } = await scaffold('guest-list-excludes-member');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await channels.addChannelMember(await refreshOwner(), {
      channelId: channel.channelId,
      userId: MEMBER,
    });
    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    const rows = await compliance.listChannelGuests(await refreshOwner(), {
      channelId: channel.channelId,
    });

    expect(rows.map((row) => row.userId)).toEqual([GUEST]);
  });

  it('no longer lists a guest once access is revoked', async () => {
    const { owner, refreshOwner } = await scaffold('guest-list-revoked');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });
    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: false,
      expiresAt: null,
    });

    expect(
      await compliance.listChannelGuests(await refreshOwner(), { channelId: channel.channelId }),
    ).toEqual([]);
  });
});

describe('where a guest cannot be invited', () => {
  it('cannot be invited to a direct message (§7.4)', async () => {
    const { owner, refreshOwner } = await scaffold('guest-no-dm');
    const dm = await channels.openDirectMessage(owner, { userIds: [MEMBER] });

    expect(
      await rejectionCode(async () =>
        compliance.setGuestAccess(await refreshOwner(), {
          channelId: dm.channelId,
          userId: GUEST,
          granted: true,
          expiresAt: null,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('cannot be invited to a public channel', async () => {
    /* A guest in a public channel is a contradiction: public means readable by
       the organization, a guest holds no org membership, so the tuple would be
       the only thing granting access — a private channel with a misleading
       label. */
    const { owner, refreshOwner } = await scaffold('guest-no-public');
    const channel = await channels.createChannel(owner, { type: 'public', name: 'general' });

    expect(
      await rejectionCode(async () =>
        compliance.setGuestAccess(await refreshOwner(), {
          channelId: channel.channelId,
          userId: GUEST,
          granted: true,
          expiresAt: null,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

/**
 * Through the real tRPC router — the layer every test above bypasses.
 *
 * `channels.getChannel(guest, ...)` above calls the service directly, which is
 * exactly how the route-level bug (ai/phase-5-chat.md's "six more findings",
 * item 1) stayed invisible: `builder.ts`'s `route()` middleware sits in front
 * of the service and was never exercised by a test that skips it. Before
 * `couldGrant`, `route()` answered `can(subject, permission)` with no target —
 * role alone — and `GUEST` grants nothing from its role by design, so it
 * refused a guest on every chat route before the tuple-aware service check
 * below it ever ran. These three go through `createCallerFactory`, the same
 * entry point a browser's tRPC client uses.
 */
describe('through the real tRPC router — the layer the service tests bypass', () => {
  it('reaches the channel it was granted, through the route', async () => {
    // The exact case that used to fail: a guest with a real tuple on this
    // channel, refused before the fix by the layer-1 role check alone.
    const { orgId, owner, refreshOwner } = await scaffold('guest-router-granted');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    const tuples = await loadTuples(orgId, GUEST);
    const caller = callerFactory(
      testContext({
        principal: testPrincipal('guest', { userId: GUEST, org: { orgId, role: 'guest', tuples } }),
      }),
    );

    const seen = await caller.chat.channels.get({ channelId: channel.channelId });
    expect(seen.name).toBe('project-x');
  });

  it('is refused by the route with no grant at all', async () => {
    // A guest holding no tuple anywhere is refused before AND after the fix —
    // `couldGrant` still requires the role OR some tuple to cover the
    // permission, and an empty tuple set satisfies neither. Distinguishing
    // this from the case above is the point: the fix narrows who is refused,
    // it does not remove the refusal.
    const { orgId } = await scaffold('guest-router-none');

    const tuples = await loadTuples(orgId, GUEST);
    expect(tuples).toEqual([]);

    const caller = callerFactory(
      testContext({
        principal: testPrincipal('guest', { userId: GUEST, org: { orgId, role: 'guest', tuples } }),
      }),
    );

    await expect(caller.chat.channels.list()).rejects.toThrow();
  });

  it('cannot reach a second channel it holds no tuple on, through the route', async () => {
    // The containment property, through the router this time: `couldGrant` is
    // deliberately coarse (true if ANY tuple covers the permission, on any
    // object), so this proves layer 2's `enforceOnChannel` is still what makes
    // the real per-resource decision once the coarse layer-1 check has passed
    // on the strength of the OTHER channel's tuple.
    const { orgId, owner, refreshOwner } = await scaffold('guest-router-contained');
    const invited = await channels.createChannel(owner, { type: 'private', name: 'project-x' });
    const other = await channels.createChannel(owner, { type: 'private', name: 'leadership' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: invited.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    const tuples = await loadTuples(orgId, GUEST);
    const caller = callerFactory(
      testContext({
        principal: testPrincipal('guest', { userId: GUEST, org: { orgId, role: 'guest', tuples } }),
      }),
    );

    await expect(caller.chat.channels.get({ channelId: other.channelId })).rejects.toThrow();
  });

  it('can post in the channel it was granted, through the route', async () => {
    /* `message:create` is granted to the `member` relation through the
       "extra" list in `tuples.ts` (`grantSet`), not the action-suffix match —
       it has nothing in its own name that says "channel". The second
       `couldGrant` fix (`isOrgLevel`) must not have collaterally broken this:
       a channel tuple has to keep authorizing everything `enforceOnChannel`
       will actually check against that same channel, or the guest-posting
       case `couldGrant` exists for breaks again in the opposite direction. */
    const { orgId, owner, refreshOwner } = await scaffold('guest-router-can-post');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    const tuples = await loadTuples(orgId, GUEST);
    const caller = callerFactory(
      testContext({
        principal: testPrincipal('guest', { userId: GUEST, org: { orgId, role: 'guest', tuples } }),
      }),
    );

    const sent = await caller.chat.messages.send({
      channelId: channel.channelId,
      body: body('hello from the router'),
      parentMessageId: null,
    });

    expect(sent.messageId).toBeDefined();
  });

  it('a channel tuple does not unlock the org audit log or another user’s permission trace', async () => {
    /* The vulnerability an adversarial review caught before merge: `couldGrant`
       used to match a tuple's relation with no check on what the tuple's
       OBJECT actually was, and `member`'s grant set covers every permission
       ending in `:read` by suffix - including `audit:read`, which has nothing
       to do with a channel. `tenancy.audit.list` and `tenancy.authz.explain`
       have no layer 2 (`audit.service.ts` / `authz.service.ts` never call
       `enforce()` again with a target - there is no per-resource grant for an
       org-level capability), so `route()`'s pre-check is their ENTIRE
       authorization decision. A guest holding one ordinary channel tuple must
       not be able to read the org's audit log or any other user's decision
       trace through it. */
    const { orgId, owner, refreshOwner } = await scaffold('guest-router-no-audit-leak');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    await compliance.setGuestAccess(await refreshOwner(), {
      channelId: channel.channelId,
      userId: GUEST,
      granted: true,
      expiresAt: null,
    });

    const tuples = await loadTuples(orgId, GUEST);
    const caller = callerFactory(
      testContext({
        principal: testPrincipal('guest', { userId: GUEST, org: { orgId, role: 'guest', tuples } }),
      }),
    );

    await expect(caller.tenancy.audit.list({})).rejects.toThrow();
    await expect(
      caller.tenancy.authz.explain({
        userId: OWNER,
        permission: 'channel:manage',
        resourceType: null,
        resourceId: null,
      }),
    ).rejects.toThrow();
  });
});

/**
 * Compliance export (Wave 4, §5).
 *
 * Lives in this file because it shares the org/guest fixture, and because the
 * two are the same shape of question: who is allowed to see the contents of a
 * private conversation, and what does the audit trail say about it afterwards.
 */
describe('compliance export', () => {
  it('returns every message, including deleted ones', async () => {
    /* A tombstone's body is withheld from ordinary reads — "delete" must mean
       gone for the people in the channel. An export answering a legal request
       is the one caller for which that is wrong: the question is what was said,
       including what somebody later removed. */
    const { owner, refreshOwner } = await scaffold('export-deleted');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });
    const author = await refreshOwner();

    const kept = await messages.sendMessage(author, {
      channelId: channel.channelId,
      body: body('kept'),
    });
    const removed = await messages.sendMessage(author, {
      channelId: channel.channelId,
      body: body('regrettable'),
    });
    await messages.deleteMessage(author, { messageId: removed.messageId });

    const exported = await compliance.exportChannel(await refreshOwner(), {
      channelId: channel.channelId,
    });

    expect(exported.messages.map((message) => message.messageId).sort()).toEqual(
      [kept.messageId, removed.messageId].sort(),
    );

    const tombstone = exported.messages.find((message) => message.messageId === removed.messageId);
    expect(tombstone?.deletedAt).not.toBeNull();
    // The TEXT survives in an export even though the ordinary read strips it.
    expect(tombstone?.bodyText).toBe('regrettable');
  });

  it('can exclude deleted messages when asked', async () => {
    const { owner, refreshOwner } = await scaffold('export-live-only');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });
    const author = await refreshOwner();

    const kept = await messages.sendMessage(author, {
      channelId: channel.channelId,
      body: body('kept'),
    });
    const removed = await messages.sendMessage(author, {
      channelId: channel.channelId,
      body: body('gone'),
    });
    await messages.deleteMessage(author, { messageId: removed.messageId });

    const exported = await compliance.exportChannel(await refreshOwner(), {
      channelId: channel.channelId,
      includeDeleted: false,
    });

    expect(exported.messages.map((message) => message.messageId)).toEqual([kept.messageId]);
  });

  it('audits the export itself, with a count and not the contents', async () => {
    /* Taking a copy of a private conversation leaves no other trace — the
       caller receives the data and the channel looks untouched. This event is
       what makes it visible, and it carries a COUNT because an outbox row is
       replayed into a log that keeps whatever is put in it. */
    const { orgId, owner, refreshOwner } = await scaffold('export-audited');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });
    const author = await refreshOwner();
    await messages.sendMessage(author, { channelId: channel.channelId, body: body('one') });

    await compliance.exportChannel(await refreshOwner(), { channelId: channel.channelId });

    await admin.setOrg(orgId);
    const result = await admin.query(
      `SELECT payload FROM platform.outbox WHERE org_id = $1 AND name = 'compliance.exported'`,
      [orgId],
    );
    await admin.setOrg(null);

    const rows = result.rows as { payload: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload['messageCount']).toBe(1);
    expect(rows[0]?.payload['includesDeleted']).toBe(true);
    // No message text anywhere in the payload.
    expect(JSON.stringify(rows[0]?.payload)).not.toContain('one');
  });

  it('refuses someone who cannot reach the channel at all', async () => {
    /* `audit:export` is an ORG capability and no tuple can grant it — but the
       exporter must ALSO be able to reach the channel, so `enforce` answers 404
       for a private channel they hold no membership on. "Compliance can export
       anything" is a reasonable policy and this is deliberately not it: the
       audited path is to be added to the channel first, visibly. */
    const { orgId, owner } = await scaffold('export-denied');
    const channel = await channels.createChannel(owner, { type: 'private', name: 'project-x' });

    const member = await actorFor(orgId, MEMBER, 'member');
    expect(
      await rejectionCode(() => compliance.exportChannel(member, { channelId: channel.channelId })),
    ).toBe('NOT_FOUND');
  });
});
