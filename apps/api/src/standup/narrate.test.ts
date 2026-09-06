import { describe, expect, it } from 'vitest';
import type { AiCompletionResult } from '@taskflow/contracts';
import { calloutFromCompletion } from './narrate.js';

/**
 * `calloutFromCompletion` — the pure parse half of `narrate.ts` — with no
 * network or database dependency. `router.test.ts` proves the real wiring
 * (real Postgres, a stubbed `fetch`); this file proves the shapes a real
 * provider response can take, fast. `standup.service.test.ts` covers
 * `headlineFor` and the Yesterday/Today/Overdue/Urgent bucketing, both of
 * which moved into `standup.service.ts` when this file stopped producing
 * per-member content — see this file's own header.
 */

function toolUseResult(input: unknown): AiCompletionResult {
  return {
    content: '',
    toolCalls: [
      { id: 'toolu_1', name: 'emit_team_callout', input: input as Record<string, unknown> },
    ],
    usage: { inputTokens: 10, outputTokens: 10 },
    stopReason: 'tool_use',
  };
}

describe('calloutFromCompletion', () => {
  it('returns the callout string from a well-formed tool call', () => {
    const result = toolUseResult({ callout: 'Three people are blocked on the same API change.' });
    expect(calloutFromCompletion(result)).toBe('Three people are blocked on the same API change.');
  });

  it('throws when the model answered with plain text instead of calling the tool', () => {
    const result: AiCompletionResult = {
      content: 'Everyone is doing fine this week.',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'end_turn',
    };

    expect(() => calloutFromCompletion(result)).toThrow(/did not return a team callout/);
  });

  it('throws when the tool call input does not match the expected shape', () => {
    const result = toolUseResult({}); // missing `callout`
    expect(() => calloutFromCompletion(result)).toThrow(/malformed team callout/);
  });

  it('throws when a different tool name is present but not the expected one', () => {
    const result: AiCompletionResult = {
      content: '',
      toolCalls: [{ id: 'toolu_1', name: 'some_other_tool', input: { callout: 'x' } }],
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'tool_use',
    };

    expect(() => calloutFromCompletion(result)).toThrow(/did not return a team callout/);
  });
});
