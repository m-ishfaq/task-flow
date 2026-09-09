import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { describeAiProviderContract } from './contract-test.js';
import { AnthropicApiError, AnthropicProvider } from './anthropic.js';

const ORG_ID = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001') as OrgId;

/**
 * `fetch` is stubbed globally rather than injected, matching this file's
 * one job: proving `AnthropicProvider` builds the right request and reads
 * the right response, never proving the real API is reachable — the same
 * "real carrier only, never a mock of one" line `twilio.test.ts`'s own
 * absence of a live-network suite draws for telephony. Nothing here talks
 * to a real Anthropic endpoint.
 */
function stubFetch(handler: (input: string | URL, init?: RequestInit) => Response): void {
  vi.stubGlobal('fetch', vi.fn(handler));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describeAiProviderContract('AnthropicProvider (mocked)', () => {
  stubFetch(() =>
    jsonResponse(200, {
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  );
  return new AnthropicProvider({ apiKey: 'test-key' });
});

describe('AnthropicProvider', () => {
  it('isLive is true — this is the real provider, unlike the fake', () => {
    expect(new AnthropicProvider({ apiKey: 'test-key' }).isLive).toBe(true);
  });

  /* Found from a real report: a stalled connection to Anthropic (nothing
     exotic — a TLS hang, a connection accepted and never answered) left
     `complete`'s promise pending forever, which meant every button on the
     assistant page gated on that one mutation's `isPending` (Approve,
     Decline, send) stayed disabled with no error and no way to recover
     short of a reload. A `signal` on the request is what turns a wedged
     fetch into an ordinary rejection the caller can actually handle —
     `timeout.ts`'s own header has the full story. */
  it('bounds the request with a timeout signal, so a stalled connection rejects instead of hanging forever', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, {
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'claude-test',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedInit?.signal?.aborted).toBe(false);
  });

  it('sends the API key, version header, and pulls system messages out of the array', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, {
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    });

    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
    });

    expect(capturedInit).toBeDefined();
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(capturedInit?.body as string) as {
      system?: string;
      messages: readonly { role: string; content: string }[];
    };
    expect(body.system).toBe('Be terse.');
    // The system message must not ALSO appear in the messages array — a
    // provider that left it in both places would send it to the model
    // twice, and a caller counting on `AiMessage`'s three-role union to
    // match Anthropic's own two-role message shape would never notice.
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('maps tool_use content blocks to AiToolCall entries', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'sprint 14' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 15 },
      }),
    );

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    const result = await provider.complete({
      orgId: ORG_ID,
      model: 'claude-test',
      messages: [{ role: 'user', content: 'Find sprint 14.' }],
      tools: [{ name: 'search', description: 'Search cards.', inputSchema: { type: 'object' } }],
    });

    expect(result.content).toBe('Let me check.');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'search', input: { query: 'sprint 14' } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 15 });
  });

  it('throws AnthropicApiError, carrying the HTTP status, on a non-OK response', async () => {
    stubFetch(() =>
      jsonResponse(429, { error: { type: 'rate_limit_error', message: 'Slow down.' } }),
    );

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await expect(
      provider.complete({
        orgId: ORG_ID,
        model: 'claude-test',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ status: 429, message: 'Slow down.' });
  });

  it('AnthropicApiError is a real Error, not a plain object masquerading as one', () => {
    const error = new AnthropicApiError('boom', 500);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AnthropicApiError');
    expect(error.status).toBe(500);
  });

  it('replays a prior tool_use as content blocks, paired with its tool_result', async () => {
    /* The property this test exists for: Anthropic's real API 400s a
       conversation where a tool_use block has no matching tool_result in
       the very next turn. A provider that flattened either into plain text
       would pass every other test here and still break the first time a
       real multi-turn tool-calling conversation continued past turn one. */
    let capturedBody: { messages: unknown[] } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as { messages: unknown[] };
      return jsonResponse(200, {
        content: [{ type: 'text', text: 'Done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 30, output_tokens: 5 },
      });
    });

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'claude-test',
      messages: [
        { role: 'user', content: 'Find sprint 14.' },
        {
          role: 'assistant',
          content: 'Let me check.',
          toolCalls: [{ id: 'toolu_1', name: 'search', input: { query: 'sprint 14' } }],
        },
        { role: 'tool_result', toolCallId: 'toolu_1', content: '[{"title":"WEB-1"}]' },
      ],
    });

    expect(capturedBody?.messages).toEqual([
      { role: 'user', content: 'Find sprint 14.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'sprint 14' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[{"title":"WEB-1"}]' }],
      },
    ]);
  });

  it('marks a failed tool result with is_error, and omits an empty text block', async () => {
    let capturedBody: { messages: unknown[] } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as { messages: unknown[] };
      return jsonResponse(200, {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 },
      });
    });

    const provider = new AnthropicProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'claude-test',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_2', name: 'search', input: {} }],
        },
        {
          role: 'tool_result',
          toolCallId: 'toolu_2',
          content: 'permission denied',
          isError: true,
        },
      ],
    });

    expect(capturedBody?.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'search', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'permission denied',
            is_error: true,
          },
        ],
      },
    ]);
  });
});
