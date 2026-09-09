import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../../testing/fixtures.js';
import * as orgs from '../../tenancy/org.service.js';
import * as members from '../../tenancy/member.service.js';
import { loadTuples } from '../../tenancy/resolve.js';
import * as channels from '../../chat/channel.service.js';
import type { ChatActor } from '../../chat/shared.js';
import { createChatPostMessageTool, createListChannelsTool } from './chat.js';
import type { ToolContext } from './registry.js';

/**
 * `chat_post_message` (§4.1, §4.3's last item), against real Postgres.
 *
 * The property that matters most: the mention SEGMENT this tool accepts
 * becomes a real `mention` TipTap node on the real send path, which is
 * what makes `mentionedUserIds` (Phase 9's notification extraction) see it
 * — proven here by asserting the stored message's mentioned users, not
 * just that the call succeeded.
 */

const OWNER = unsafeAsId<'UserId'>('0195f700-0000-7000-8000-000000000001');
const BOB = unsafeAsId<'UserId'>('0195f700-0000-7000-8000-000000000002');
const requestId: RequestId = unsafeAsId<'RequestId'>('0195f700-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  await members.addMember(
    result.orgId,
    { email: 'bob@ai-chat-tools.test', role: 'member' },
    { userId: OWNER, requestId },
  );
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  for (const table of [
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

async function ownerSubject(orgId: OrgId): Promise<Subject> {
  const tuples = await loadTuples(orgId, OWNER);
  return { orgId, userId: OWNER, role: 'owner', tuples };
}

async function ownerActor(orgId: OrgId): Promise<ChatActor> {
  return { subject: await ownerSubject(orgId), requestId };
}

function guestCtx(orgId: OrgId): ToolContext {
  return { subject: { orgId, userId: OWNER, role: 'guest', tuples: [] }, requestId };
}

function ownerCtx(subject: Subject): ToolContext {
  return { subject, requestId };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [[OWNER, BOB]]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@ai-chat-tools.test', 'owner@ai-chat-tools.test', now()),
            ($2, 'bob@ai-chat-tools.test', 'bob@ai-chat-tools.test', now())`,
    [OWNER, BOB],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-chat-tools-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [[OWNER, BOB]]);
  await admin.end();
  await closeDatabase();
});

describe('chat_post_message', () => {
  it('posts a real message with a real mention node', async () => {
    const orgId = await newOrg('chat-post-owner');
    const actor = await ownerActor(orgId);
    const channel = await channels.createChannel(actor, { type: 'public', name: 'general' });
    const subject = await ownerSubject(orgId);

    const tool = createChatPostMessageTool();
    const result = await tool.execute(ownerCtx(subject), {
      channelId: channel.channelId,
      segments: [
        { type: 'text', text: 'Hey ' },
        { type: 'mention', userId: BOB, label: 'Bob' },
        { type: 'text', text: ', can you take a look?' },
      ],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { messageId: string };

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT body_text, body FROM chat.messages WHERE id = $1`, [
      parsed.messageId,
    ]);
    await admin.setOrg(null);
    // `flattenToText` renders a mention as `@<label>`, matching how a human
    // would read it — not just the bare label.
    expect(rows.rows[0]?.['body_text']).toBe('Hey @Bob, can you take a look?');

    const body = rows.rows[0]?.['body'] as { content: readonly { content: readonly unknown[] }[] };
    expect(body.content[0]?.content).toContainEqual({
      type: 'mention',
      attrs: { userId: BOB, label: 'Bob' },
    });
  });

  it('refuses a guest, who holds message:create from no role by design', async () => {
    const orgId = await newOrg('chat-post-guest');
    const actor = await ownerActor(orgId);
    const channel = await channels.createChannel(actor, { type: 'public', name: 'general' });

    const tool = createChatPostMessageTool();
    const result = await tool.execute(guestCtx(orgId), {
      channelId: channel.channelId,
      segments: [{ type: 'text', text: 'Should not post.' }],
    });

    expect(result.isError).toBe(true);

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT id FROM chat.messages WHERE org_id = $1`, [orgId]);
    await admin.setOrg(null);
    expect(rows.rowCount).toBe(0);
  });

  it('refuses an all-empty-text message rather than posting a blank line', async () => {
    const orgId = await newOrg('chat-post-empty');
    const actor = await ownerActor(orgId);
    const channel = await channels.createChannel(actor, { type: 'public', name: 'general' });
    const subject = await ownerSubject(orgId);

    const tool = createChatPostMessageTool();
    const result = await tool.execute(ownerCtx(subject), {
      channelId: channel.channelId,
      segments: [{ type: 'text', text: '' }],
    });

    expect(result.isError).toBe(true);
  });

  it('opens a DM automatically via dmUserIds and posts into it', async () => {
    const orgId = await newOrg('chat-post-dm-open');
    const subject = await ownerSubject(orgId);

    const tool = createChatPostMessageTool();
    const result = await tool.execute(ownerCtx(subject), {
      dmUserIds: [BOB],
      segments: [{ type: 'text', text: 'Hey there' }],
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { channelId: string; messageId: string };

    await admin.setOrg(orgId);
    const channelRows = await admin.query(`SELECT type FROM chat.channels WHERE id = $1`, [
      parsed.channelId,
    ]);
    await admin.setOrg(null);
    expect(channelRows.rows[0]?.['type']).toBe('dm');
  });

  it('reuses the same DM on a second dmUserIds call rather than creating a duplicate', async () => {
    const orgId = await newOrg('chat-post-dm-reuse');
    const subject = await ownerSubject(orgId);
    const tool = createChatPostMessageTool();

    const first = await tool.execute(ownerCtx(subject), {
      dmUserIds: [BOB],
      segments: [{ type: 'text', text: 'First' }],
    });
    const second = await tool.execute(ownerCtx(subject), {
      dmUserIds: [BOB],
      segments: [{ type: 'text', text: 'Second' }],
    });

    const firstParsed = JSON.parse(first.content) as { channelId: string };
    const secondParsed = JSON.parse(second.content) as { channelId: string };
    expect(secondParsed.channelId).toBe(firstParsed.channelId);
  });

  it('rejects a call giving both channelId and dmUserIds', async () => {
    const orgId = await newOrg('chat-post-both');
    const actor = await ownerActor(orgId);
    const channel = await channels.createChannel(actor, { type: 'public', name: 'general' });
    const subject = await ownerSubject(orgId);

    const tool = createChatPostMessageTool();
    const result = await tool.execute(ownerCtx(subject), {
      channelId: channel.channelId,
      dmUserIds: [BOB],
      segments: [{ type: 'text', text: 'Should not post.' }],
    });

    expect(result.isError).toBe(true);
  });

  it('rejects a call giving neither channelId nor dmUserIds', async () => {
    const orgId = await newOrg('chat-post-neither');
    const subject = await ownerSubject(orgId);

    const tool = createChatPostMessageTool();
    const result = await tool.execute(ownerCtx(subject), {
      segments: [{ type: 'text', text: 'Should not post.' }],
    });

    expect(result.isError).toBe(true);
  });

  it('declares requiresConfirmation: true', () => {
    expect(createChatPostMessageTool().requiresConfirmation).toBe(true);
  });
});

describe('list_channels', () => {
  it('lists a public channel by name', async () => {
    const orgId = await newOrg('chat-list-channels-public');
    const actor = await ownerActor(orgId);
    await channels.createChannel(actor, { type: 'public', name: 'general' });
    const subject = await ownerSubject(orgId);

    const tool = createListChannelsTool();
    const result = await tool.execute(ownerCtx(subject), {});

    const parsed = JSON.parse(result.content) as readonly { name: string | null }[];
    expect(parsed).toEqual([expect.objectContaining({ name: 'general' })]);
  });

  it('lists a DM with its participant ids and a null name', async () => {
    const orgId = await newOrg('chat-list-channels-dm');
    const actor = await ownerActor(orgId);
    await channels.openDirectMessage(actor, { userIds: [BOB] });
    const subject = await ownerSubject(orgId);

    const tool = createListChannelsTool();
    const result = await tool.execute(ownerCtx(subject), {});

    const parsed = JSON.parse(result.content) as readonly {
      name: string | null;
      participantIds: readonly string[];
    }[];
    expect(parsed).toEqual([expect.objectContaining({ name: null, participantIds: [BOB] })]);
  });

  it('reports nothing for a fresh org with no channels', async () => {
    const orgId = await newOrg('chat-list-channels-empty');
    const subject = await ownerSubject(orgId);

    const tool = createListChannelsTool();
    const result = await tool.execute(ownerCtx(subject), {});

    expect(result.content).toBe('No channels are visible to you yet.');
  });
});
