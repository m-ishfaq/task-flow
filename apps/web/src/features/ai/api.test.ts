import { describe, expect, it } from 'vitest';
import { windowForRequest, type ChatMessageWire } from './api.js';

/**
 * `windowForRequest`'s own header explains WHY it exists: `ai.chat.send`
 * refuses more than 40 messages, and `assistant-page.tsx` used to resend the
 * whole ever-growing transcript verbatim — a real conversation crossed 40
 * and got stuck on a hard `BAD_REQUEST` with no way to continue. These tests
 * cover the two properties that make trimming SAFE rather than merely
 * short: never splitting an `assistant`+`tool_result` unit apart, and
 * preferring a window that opens on a `user` turn whenever one fits.
 */

function user(content: string): ChatMessageWire {
  return { role: 'user', content };
}

function assistantWithTools(id: string): ChatMessageWire {
  return { role: 'assistant', content: '', toolCalls: [{ id, name: 'search', input: {} }] };
}

function toolResult(id: string): ChatMessageWire {
  return { role: 'tool_result', toolCallId: id, content: '[]' };
}

function assistantText(content: string): ChatMessageWire {
  return { role: 'assistant', content };
}

describe('windowForRequest', () => {
  it('returns the array unchanged when already under the cap', () => {
    const messages = [user('hi'), assistantText('hello')];
    expect(windowForRequest(messages, 40)).toBe(messages);
  });

  it('drops whole leading turns from the front, keeping the most recent ones', () => {
    const messages: ChatMessageWire[] = [];
    for (let i = 0; i < 20; i += 1) {
      messages.push(user(`turn ${String(i)}`), assistantText(`reply ${String(i)}`));
    }
    // 40 messages total; cap at 10 should keep the last 5 whole turns.
    const window = windowForRequest(messages, 10);
    expect(window).toHaveLength(10);
    expect(window[0]).toEqual(user('turn 15'));
    expect(window.at(-1)).toEqual(assistantText('reply 19'));
  });

  it('never splits an assistant tool-call turn from its tool_result turns', () => {
    const messages: ChatMessageWire[] = [
      user('old'),
      assistantText('old reply'),
      user('do the thing'),
      assistantWithTools('call-1'),
      toolResult('call-1'),
      toolResult('call-1-b'),
    ];
    // A cap tight enough that a naive per-message trim would cut the
    // assistant/tool_result unit in half — the real window has to include
    // the whole unit, plus the user turn that started it, or drop both.
    const window = windowForRequest(messages, 4);
    expect(window).toEqual([
      user('do the thing'),
      assistantWithTools('call-1'),
      toolResult('call-1'),
      toolResult('call-1-b'),
    ]);
  });

  it('walks back past a full trailing unit to the nearest user turn that still fits', () => {
    const messages: ChatMessageWire[] = [
      user('turn0'),
      assistantText('reply0'),
      user('turn1'),
      assistantWithTools('call-1'),
      toolResult('call-1'),
      toolResult('call-1-b'),
      toolResult('call-1-c'),
      assistantText('final1'),
    ];
    // The trailing assistant/tool_result unit (4 messages) plus the final
    // reply (1) alone would fit under a cap of 6 but would open on an
    // `assistant` turn — the function must include the preceding `user`
    // turn instead, dropping the earlier turn entirely rather than opening
    // mid-conversation on an assistant message.
    const window = windowForRequest(messages, 6);
    expect(window[0]).toEqual(user('turn1'));
    expect(window).toHaveLength(6);
  });

  it('keeps a trailing pending tool-call turn (no tool_result yet) as its own unit', () => {
    const messages: ChatMessageWire[] = [
      user('old'),
      assistantText('old reply'),
      user('create a card'),
      assistantWithTools('call-3'),
    ];
    const window = windowForRequest(messages, 2);
    expect(window).toEqual([user('create a card'), assistantWithTools('call-3')]);
  });

  it('falls back to a size-based window when no user-starting suffix fits at all', () => {
    const messages: ChatMessageWire[] = [
      user('turn0'),
      user('turn1'),
      assistantWithTools('call-1'),
      toolResult('call-1'),
      toolResult('call-1-b'),
    ];
    // No cap this small can ever include a `user` turn alongside the trailing
    // 3-message unit — the fallback still keeps the unit whole rather than
    // splitting it, even though the result opens on `assistant`.
    const window = windowForRequest(messages, 3);
    expect(window).toEqual([
      assistantWithTools('call-1'),
      toolResult('call-1'),
      toolResult('call-1-b'),
    ]);
  });
});
