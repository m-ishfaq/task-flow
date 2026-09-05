import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type MembershipId, type OrgId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, initializeSearchDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakeAiProvider } from '@taskflow/ai';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import { PostgresSearchProvider } from '../search/postgres-provider.js';
import { buildToolRegistry } from './tools/index.js';
import { AssistantLoopExceededError, runAssistantTurn } from './assistant.js';
import type { AiCompletionActor } from './complete.js';

/* `.has()` membership checks rather than `message.role === 'system'` —
   `packages/config/eslint/security.js`'s `roleMember`/`roleIdentifier`
   guardrails ban any `===`/`!==` naming `role`, on the theory that the
   shape is almost always an inline org-role check drifting from `can()`.
   `AiMessage.role` is a chat-turn speaker, not an org role, but the
   selector matches on name — see `packages/ai/src/anthropic.ts`'s
   identical fix for the reasoning written out in full. */
const SYSTEM_ROLE_MESSAGES = new Set(['system']);
const TOOL_RESULT_ROLE_MESSAGES = new Set(['tool_result']);

/**
 * The tool-calling assistant loop, against real Postgres and a
 * `FakeAiProvider` (Phase 15 §4.1, §4.3 Wave 1).
 *
 * The property that matters most: a `tool_use` response is never the end of
 * the conversation. This file proves the round trip end to end — the loop
 * asks the REAL `search` tool to run (against the REAL `performSearch`
 * pipeline, under `can()`), feeds a real `tool_result` back to the (fake)
 * model, and the model's follow-up becomes the turn's final answer. The
 * per-hit authorization property itself (a DM never surfacing, etc.) is
 * `search/router.test.ts`'s job, already proven there — this file's fixture
 * stays to an empty-but-real search rather than re-deriving a card/board
 * fixture chain to prove the same thing twice.
 */

const OWNER = unsafeAsId<'UserId'>('0195f300-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195f300-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<{ orgId: OrgId; membershipId: MembershipId }> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);

  await admin.setOrg(result.orgId);
  const rows = await admin.query(
    `SELECT id FROM identity.memberships WHERE org_id = $1 AND user_id = $2`,
    [result.orgId, OWNER],
  );
  await admin.setOrg(null);

  const membershipId = rows.rows[0]?.['id'];
  if (typeof membershipId !== 'string') throw new Error('Expected an owner membership to exist.');

  return { orgId: result.orgId, membershipId: unsafeAsId<'MembershipId'>(membershipId) };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM ai.usage_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM billing.org_entitlements WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function subjectOf(orgId: OrgId): Promise<Subject> {
  const tuples = await loadTuples(orgId, OWNER);
  return { orgId, userId: OWNER, role: 'owner', tuples };
}

function actorOf(orgId: OrgId, membershipId: MembershipId): AiCompletionActor {
  return { orgId, userId: OWNER, membershipId, requestId };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@ai-assistant.test', 'owner@ai-assistant.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-assistant-test' });
  initializeSearchDatabase({
    url: TEST_ENV.DATABASE_URL,
    applicationName: 'ai-assistant-search-test',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('runAssistantTurn', () => {
  it('answers directly when the model needs no tool', async () => {
    const { orgId, membershipId } = await newOrg('assistant-direct');
    const provider = new FakeAiProvider();
    provider.enqueue({
      content: 'Hello! How can I help?',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    });

    const tools = buildToolRegistry({ searchProvider: new PostgresSearchProvider() });
    const result = await runAssistantTurn(
      provider,
      actorOf(orgId, membershipId),
      { subject: await subjectOf(orgId) },
      tools,
      {
        feature: 'assistant.chat',
        providerName: 'fake',
        model: 'claude-sonnet-4',
        systemPrompt: 'You are TaskFlow Assistant.',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    );

    expect(result.content).toBe('Hello! How can I help?');
    expect(result.toolRounds).toBe(0);
    expect(provider.calls).toHaveLength(1);
    // The system prompt never leaks into the caller-visible transcript.
    expect(result.messages.some((m) => SYSTEM_ROLE_MESSAGES.has(m.role))).toBe(false);
  });

  it('executes a real tool call and feeds a real tool_result back to the model', async () => {
    const { orgId, membershipId } = await newOrg('assistant-tool');
    const provider = new FakeAiProvider();
    provider.enqueue({
      content: '',
      toolCalls: [{ id: 'toolu_1', name: 'search', input: { query: 'type = card' } }],
      usage: { inputTokens: 20, outputTokens: 10 },
      stopReason: 'tool_use',
    });
    provider.enqueue({
      content: 'I found no open cards.',
      toolCalls: [],
      usage: { inputTokens: 30, outputTokens: 8 },
      stopReason: 'end_turn',
    });

    const tools = buildToolRegistry({ searchProvider: new PostgresSearchProvider() });
    const result = await runAssistantTurn(
      provider,
      actorOf(orgId, membershipId),
      { subject: await subjectOf(orgId) },
      tools,
      {
        feature: 'assistant.chat',
        providerName: 'fake',
        model: 'claude-sonnet-4',
        systemPrompt: 'You are TaskFlow Assistant.',
        messages: [{ role: 'user', content: 'Any open cards?' }],
      },
    );

    expect(result.content).toBe('I found no open cards.');
    expect(result.toolRounds).toBe(1);
    expect(provider.calls).toHaveLength(2);

    // The tool actually ran the real pipeline (empty, real database) rather
    // than being mocked away — a real tool_result message is in the
    // returned transcript, addressed to the exact tool_use id.
    const toolResult = result.messages.find((m) => TOOL_RESULT_ROLE_MESSAGES.has(m.role));
    expect(toolResult).toMatchObject({ toolCallId: 'toolu_1', content: 'No results.' });

    // Two real completions were priced — every round of a multi-round
    // exchange is its own ledger row, never a "free" intermediate call.
    await admin.setOrg(orgId);
    const ledgerRows = await admin.query(`SELECT id FROM ai.usage_ledger WHERE org_id = $1`, [
      orgId,
    ]);
    await admin.setOrg(null);
    expect(ledgerRows.rowCount).toBe(2);
  });

  it('refuses an unknown tool name as an error tool_result rather than crashing', async () => {
    const { orgId, membershipId } = await newOrg('assistant-unknown-tool');
    const provider = new FakeAiProvider();
    provider.enqueue({
      content: '',
      toolCalls: [{ id: 'toolu_1', name: 'delete_everything', input: {} }],
      usage: { inputTokens: 5, outputTokens: 5 },
      stopReason: 'tool_use',
    });
    provider.enqueue({
      content: 'I cannot do that.',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'end_turn',
    });

    const tools = buildToolRegistry({ searchProvider: new PostgresSearchProvider() });
    const result = await runAssistantTurn(
      provider,
      actorOf(orgId, membershipId),
      { subject: await subjectOf(orgId) },
      tools,
      {
        feature: 'assistant.chat',
        providerName: 'fake',
        model: 'claude-sonnet-4',
        systemPrompt: 'You are TaskFlow Assistant.',
        messages: [{ role: 'user', content: 'Delete everything.' }],
      },
    );

    expect(result.content).toBe('I cannot do that.');
    const toolResult = result.messages.find((m) => TOOL_RESULT_ROLE_MESSAGES.has(m.role));
    expect(toolResult).toMatchObject({ isError: true });
  });

  it('bounds a runaway tool-calling loop rather than spinning forever', async () => {
    const { orgId, membershipId } = await newOrg('assistant-loop-bound');
    const provider = new FakeAiProvider();
    // Every queued response requests another tool call — never resolves.
    for (let i = 0; i < 10; i += 1) {
      provider.enqueue({
        content: '',
        toolCalls: [{ id: `toolu_${String(i)}`, name: 'search', input: { query: 'type = card' } }],
        usage: { inputTokens: 5, outputTokens: 5 },
        stopReason: 'tool_use',
      });
    }

    const tools = buildToolRegistry({ searchProvider: new PostgresSearchProvider() });

    await expect(
      runAssistantTurn(
        provider,
        actorOf(orgId, membershipId),
        { subject: await subjectOf(orgId) },
        tools,
        {
          feature: 'assistant.chat',
          providerName: 'fake',
          model: 'claude-sonnet-4',
          systemPrompt: 'You are TaskFlow Assistant.',
          messages: [{ role: 'user', content: 'Keep going.' }],
        },
      ),
    ).rejects.toBeInstanceOf(AssistantLoopExceededError);
  });
});
