import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { describeAiProviderContract } from './contract-test.js';
import { OpenAiApiError, OpenAiProvider } from './openai.js';

const ORG_ID = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001') as OrgId;

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

describeAiProviderContract('OpenAiProvider (mocked)', () => {
  stubFetch(() =>
    jsonResponse(200, {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
  );
  return new OpenAiProvider({ apiKey: 'test-key' });
});

describe('OpenAiProvider', () => {
  it('isLive is true', () => {
    expect(new OpenAiProvider({ apiKey: 'test-key' }).isLive).toBe(true);
  });

  /* See `AnthropicProvider`'s identical test — `timeout.ts`'s own header has
     the full story: a stalled connection with no timeout left the assistant
     page's buttons disabled forever, with no error to recover from. */
  it('bounds the request with a timeout signal, so a stalled connection rejects instead of hanging forever', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    const provider = new OpenAiProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(capturedInit?.signal?.aborted).toBe(false);
  });

  it('sends a bearer token and keeps the system message inside messages', async () => {
    let capturedInit: RequestInit | undefined;
    stubFetch((_input, init) => {
      capturedInit = init;
      return jsonResponse(200, {
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      });
    });

    const provider = new OpenAiProvider({ apiKey: 'sk-test' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
    });

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk-test');

    const body = JSON.parse(capturedInit?.body as string) as {
      messages: readonly { role: string; content: string }[];
    };
    // Unlike Anthropic, OpenAI's system role lives INSIDE the array.
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hi' },
    ]);
  });

  it('maps tool_calls to AiToolCall entries, parsing the JSON arguments', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"query":"sprint 14"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 15 },
      }),
    );

    const provider = new OpenAiProvider({ apiKey: 'test-key' });
    const result = await provider.complete({
      orgId: ORG_ID,
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Find sprint 14.' }],
      tools: [{ name: 'search', description: 'Search cards.', inputSchema: { type: 'object' } }],
    });

    expect(result.content).toBe('');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'search', input: { query: 'sprint 14' } },
    ]);
  });

  it('throws OpenAiApiError, carrying the HTTP status, on a non-OK response', async () => {
    stubFetch(() => jsonResponse(429, { error: { message: 'Slow down.' } }));

    const provider = new OpenAiProvider({ apiKey: 'test-key' });
    await expect(
      provider.complete({
        orgId: ORG_ID,
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ status: 429, message: 'Slow down.' });
  });

  it('throws on malformed tool-call arguments rather than handing bad JSON downstream', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"query": "unterminated' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAiProvider({ apiKey: 'test-key' });
    await expect(
      provider.complete({
        orgId: ORG_ID,
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(OpenAiApiError);
  });

  it('replays a prior tool call as a tool_calls message, paired with a tool-role result', async () => {
    let capturedBody: { messages: unknown[] } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as { messages: unknown[] };
      return jsonResponse(200, {
        choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 5 },
      });
    });

    const provider = new OpenAiProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'Find sprint 14.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'search', input: { query: 'sprint 14' } }],
        },
        { role: 'tool_result', toolCallId: 'call_1', content: '[{"title":"WEB-1"}]' },
      ],
    });

    expect(capturedBody?.messages).toEqual([
      { role: 'user', content: 'Find sprint 14.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"query":"sprint 14"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '[{"title":"WEB-1"}]' },
    ]);
  });

  it('prefixes a failed tool result with "Error:" — OpenAI has no is_error field', async () => {
    let capturedBody: { messages: unknown[] } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as { messages: unknown[] };
      return jsonResponse(200, {
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      });
    });

    const provider = new OpenAiProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'gpt-4o',
      messages: [
        { role: 'tool_result', toolCallId: 'call_1', content: 'permission denied', isError: true },
      ],
    });

    expect(capturedBody?.messages).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'Error: permission denied' },
    ]);
  });
});
