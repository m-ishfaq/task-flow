import { describe, expect, it } from 'vitest';
import type { AiCompletionResult } from '@taskflow/contracts';
import { headlineFor, linesFromCompletion } from './narrate.js';
import type { StandupMember, StandupResult } from './standup.service.js';

/**
 * `linesFromCompletion` — the pure parse/merge half of `narrate.ts` — with
 * no network or database dependency. `router.test.ts` proves the real
 * wiring (real Postgres, a stubbed `fetch`); this file proves the shapes
 * a real provider response can take, fast.
 */

function member(userId: string, overrides: Partial<StandupMember> = {}): StandupMember {
  return {
    userId,
    name: userId,
    recentlyDone: [],
    stillOpen: [],
    overdue: [],
    ...overrides,
  };
}

function toolUseResult(input: unknown): AiCompletionResult {
  return {
    content: '',
    toolCalls: [
      { id: 'toolu_1', name: 'emit_standup_lines', input: input as Record<string, unknown> },
    ],
    usage: { inputTokens: 10, outputTokens: 10 },
    stopReason: 'tool_use',
  };
}

describe('linesFromCompletion', () => {
  it('maps each returned line to its member, in the members array order', () => {
    const members = [member('u1'), member('u2')];
    const result = toolUseResult({
      lines: [
        { userId: 'u2', line: 'Wrapped up onboarding docs.' },
        { userId: 'u1', line: 'Two cards still open.' },
      ],
    });

    expect(linesFromCompletion(result, members)).toEqual([
      { userId: 'u1', line: 'Two cards still open.' },
      { userId: 'u2', line: 'Wrapped up onboarding docs.' },
    ]);
  });

  it('falls back to a deterministic line for a member the model omitted — never drops them', () => {
    const members = [
      member('u1', { overdue: [card('WEB-1'), card('WEB-2')], stillOpen: [card('WEB-3')] }),
    ];
    const result = toolUseResult({ lines: [] });

    expect(linesFromCompletion(result, members)).toEqual([
      { userId: 'u1', line: '2 overdue, 1 still open.' },
    ]);
  });

  it('a duplicate userId in the response resolves to the LAST one named', () => {
    const members = [member('u1')];
    const result = toolUseResult({
      lines: [
        { userId: 'u1', line: 'First guess.' },
        { userId: 'u1', line: 'Second, corrected guess.' },
      ],
    });

    expect(linesFromCompletion(result, members)).toEqual([
      { userId: 'u1', line: 'Second, corrected guess.' },
    ]);
  });

  it('throws when the model answered with plain text instead of calling the tool', () => {
    const result: AiCompletionResult = {
      content: 'Everyone is doing fine this week.',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: 'end_turn',
    };

    expect(() => linesFromCompletion(result, [member('u1')])).toThrow(
      /did not return a structured standup summary/,
    );
  });

  it('throws when the tool call input does not match the expected shape', () => {
    const result = toolUseResult({ lines: [{ userId: 'u1' }] }); // missing `line`

    expect(() => linesFromCompletion(result, [member('u1')])).toThrow(/malformed standup summary/);
  });
});

function card(reference: string): StandupMember['overdue'][number] {
  return { cardId: reference, reference, title: 'A card', priority: null, dueDate: null };
}

describe('headlineFor', () => {
  function standup(members: readonly StandupMember[], urgentCount = 0): StandupResult {
    return {
      sprint: null,
      urgentSprintCards: Array.from({ length: urgentCount }, (_, i) => card(`URG-${String(i)}`)),
      members,
    };
  }

  it('is a real, non-empty sentence for a project with nobody at all', () => {
    expect(headlineFor(standup([]))).toBe('Nobody has open, done, or overdue work in this window.');
  });

  it('counts overdue people, done cards, and urgent sprint cards independently', () => {
    const result = headlineFor(
      standup(
        [
          member('u1', { overdue: [card('A-1'), card('A-2')] }),
          member('u2', { recentlyDone: [card('B-1')] }),
          member('u3'),
        ],
        3,
      ),
    );

    expect(result).toBe(
      '3 people · 1 person with overdue work · 1 card done recently · 3 urgent sprint cards open',
    );
  });

  it('omits the urgent-sprint-cards clause entirely when there are none', () => {
    const result = headlineFor(standup([member('u1')], 0));
    expect(result).toBe('1 person · nobody overdue · 0 cards done recently');
  });
});
