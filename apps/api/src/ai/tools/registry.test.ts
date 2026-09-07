import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { unsafeAsId } from '@taskflow/contracts';
import type { Subject } from '@taskflow/policy';
import { defineTool, toAiToolDefinition } from './registry.js';

/**
 * `defineTool` (§4.1) — the wrapper every real tool goes through.
 *
 * No database here: this file proves the wrapper's OWN contract (input
 * validation, error containment) against a trivial in-memory tool, the
 * same reason `contract-test.ts` in `packages/ai` asserts properties
 * rather than trusting a real model's output. `search.ts`'s own behaviour
 * against real data is proven by the assistant-loop integration test,
 * which needs real Postgres anyway.
 */

const SUBJECT: Subject = {
  orgId: unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001'),
  userId: unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-000000000002'),
  role: 'member',
  tuples: [],
};
const REQUEST_ID = unsafeAsId<'RequestId'>('018f4d1e-7c3a-7b2e-8f1a-000000000003');
const TOOL_CTX = { subject: SUBJECT, requestId: REQUEST_ID };

describe('defineTool', () => {
  it('rejects input that fails the Zod schema before the executor ever runs', async () => {
    let executed = false;
    const tool = defineTool({
      name: 'echo',
      description: 'test',
      jsonSchema: { type: 'object' },
      requiresConfirmation: false,
      inputSchema: z.object({ value: z.string() }).strict(),
      execute: (_ctx, input) => {
        executed = true;
        return Promise.resolve({ content: input.value });
      },
    });

    const result = await tool.execute(TOOL_CTX, { value: 42 });

    expect(result.isError).toBe(true);
    expect(executed).toBe(false);
  });

  it('runs the executor and returns its result for valid input', async () => {
    const tool = defineTool({
      name: 'echo',
      description: 'test',
      jsonSchema: { type: 'object' },
      requiresConfirmation: false,
      inputSchema: z.object({ value: z.string() }).strict(),
      execute: (_ctx, input) => Promise.resolve({ content: `echo: ${input.value}` }),
    });

    const result = await tool.execute(TOOL_CTX, { value: 'hi' });

    expect(result).toEqual({ content: 'echo: hi' });
  });

  it('applies a Zod default when the model omits an optional field', async () => {
    const tool = defineTool({
      name: 'limited',
      description: 'test',
      jsonSchema: { type: 'object' },
      requiresConfirmation: false,
      inputSchema: z.object({ limit: z.number().int().default(5) }).strict(),
      execute: (_ctx, input) => Promise.resolve({ content: String(input.limit) }),
    });

    const result = await tool.execute(TOOL_CTX, {});

    expect(result).toEqual({ content: '5' });
  });

  it('turns a thrown error (e.g. a can() refusal) into an error ToolResult, never a rejection', async () => {
    const tool = defineTool({
      name: 'guarded',
      description: 'test',
      jsonSchema: { type: 'object' },
      requiresConfirmation: false,
      inputSchema: z.object({}).strict(),
      execute: () => {
        throw new Error('FORBIDDEN: you do not have permission to do that');
      },
    });

    const result = await tool.execute(TOOL_CTX, {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain('FORBIDDEN');
  });

  it('never rejects, even when the executor throws a non-Error value', async () => {
    const tool = defineTool({
      name: 'weird',
      description: 'test',
      jsonSchema: { type: 'object' },
      requiresConfirmation: false,
      inputSchema: z.object({}).strict(),
      execute: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately proving the wrapper survives a caller that violates this rule elsewhere (e.g. a third-party dependency).
        throw { notAnError: true };
      },
    });

    const result = await tool.execute(TOOL_CTX, {});
    expect(result).toEqual({
      content: 'Tool "weird" failed: The tool failed for an unknown reason.',
      isError: true,
    });
  });

  it(
    "surfaces a DrizzleQueryError's real cause, never the raw SQL and parameter dump its own " +
      '.message carries — found from a real transcript where card_link_pr/list_card_prs both ' +
      'failed with an unhelpful "Failed query: insert into ... params: <uuid>,<uuid>,..." result',
    async () => {
      const causeErr = new Error('relation "work.card_pull_requests" does not exist');
      (causeErr as unknown as { code: string }).code = '42P01';
      const queryError = new Error(
        'Failed query: insert into "work"."card_pull_requests" (...)\nparams: a,b,c',
      );
      (queryError as unknown as { cause: Error }).cause = causeErr;

      const tool = defineTool({
        name: 'card_link_pr',
        description: 'test',
        jsonSchema: { type: 'object' },
        requiresConfirmation: true,
        inputSchema: z.object({}).strict(),
        execute: () => {
          throw queryError;
        },
      });

      const result = await tool.execute(TOOL_CTX, {});

      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('Failed query');
      expect(result.content).not.toContain('params:');
      expect(result.content).toContain('migration has not been applied');
    },
  );

  it("falls back to a cause error's own message when its SQLSTATE is not one of the named ones", async () => {
    const causeErr = new Error('duplicate key value violates unique constraint "some_other_idx"');
    (causeErr as unknown as { code: string }).code = '99999';
    const queryError = new Error('Failed query: select 1\nparams:');
    (queryError as unknown as { cause: Error }).cause = causeErr;

    const tool = defineTool({
      name: 'some_tool',
      description: 'test',
      jsonSchema: { type: 'object' },
      requiresConfirmation: false,
      inputSchema: z.object({}).strict(),
      execute: () => {
        throw queryError;
      },
    });

    const result = await tool.execute(TOOL_CTX, {});

    expect(result.content).toBe(
      'Tool "some_tool" failed: duplicate key value violates unique constraint "some_other_idx"',
    );
  });

  it(
    'prefixes a thrown error with the tool name, so a bare message like errors.notFound()' +
      '\'s default ("Not found.") still tells the model — and the transcript — which call failed',
    async () => {
      const tool = defineTool({
        name: 'card_add_labels',
        description: 'test',
        jsonSchema: { type: 'object' },
        requiresConfirmation: true,
        inputSchema: z.object({}).strict(),
        execute: () => {
          throw new Error('Not found.');
        },
      });

      const result = await tool.execute(TOOL_CTX, {});

      expect(result).toEqual({
        content: 'Tool "card_add_labels" failed: Not found.',
        isError: true,
      });
    },
  );
});

describe('toAiToolDefinition', () => {
  it('carries the name, description, and JSON schema through unchanged', () => {
    const tool = defineTool({
      name: 'search',
      description: 'Search things.',
      jsonSchema: { type: 'object', properties: { query: { type: 'string' } } },
      requiresConfirmation: false,
      inputSchema: z.object({ query: z.string() }).strict(),
      execute: () => Promise.resolve({ content: '' }),
    });

    expect(toAiToolDefinition(tool)).toEqual({
      name: 'search',
      description: 'Search things.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    });
  });
});
