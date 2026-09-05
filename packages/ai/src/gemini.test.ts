import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { describeAiProviderContract } from './contract-test.js';
import { GeminiApiError, GeminiProvider } from './gemini.js';

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

describeAiProviderContract('GeminiProvider (mocked)', () => {
  stubFetch(() =>
    jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    }),
  );
  return new GeminiProvider({ apiKey: 'test-key' });
});

describe('GeminiProvider', () => {
  it('isLive is true', () => {
    expect(new GeminiProvider({ apiKey: 'test-key' }).isLive).toBe(true);
  });

  it('sends the API key as a header, never a query parameter, and pulls the system message into systemInstruction', async () => {
    let capturedUrl: string | URL | undefined;
    let capturedInit: RequestInit | undefined;
    stubFetch((input, init) => {
      capturedUrl = input;
      capturedInit = init;
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      });
    });

    const provider = new GeminiProvider({ apiKey: 'goog-test' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'gemini-1.5-pro',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Hi' },
      ],
    });

    expect(String(capturedUrl)).not.toContain('goog-test');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('goog-test');

    const body = JSON.parse(capturedInit?.body as string) as {
      systemInstruction?: { parts: readonly { text: string }[] };
      contents: readonly { role: string; parts: readonly { text: string }[] }[];
    };
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }]);
  });

  it('maps a functionCall part to an AiToolCall, and reports tool_use even when finishReason is STOP', async () => {
    stubFetch(() =>
      jsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Let me check.' },
                { functionCall: { name: 'search', args: { query: 'sprint 14' } } },
              ],
            },
            // Gemini often reports STOP even when it also asked for a tool.
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
      }),
    );

    const provider = new GeminiProvider({ apiKey: 'test-key' });
    const result = await provider.complete({
      orgId: ORG_ID,
      model: 'gemini-1.5-pro',
      messages: [{ role: 'user', content: 'Find sprint 14.' }],
      tools: [{ name: 'search', description: 'Search cards.', inputSchema: { type: 'object' } }],
    });

    expect(result.content).toBe('Let me check.');
    expect(result.stopReason).toBe('tool_use');
    // Index 1, not 0 — `encodeCallId` numbers by position in the full PARTS
    // array (the text part occupies index 0), not by position among
    // functionCall parts alone.
    expect(result.toolCalls).toEqual([
      { id: 'search::1', name: 'search', input: { query: 'sprint 14' } },
    ]);
  });

  it('throws GeminiApiError, carrying the HTTP status, on a non-OK response', async () => {
    stubFetch(() => jsonResponse(429, { error: { message: 'Slow down.' } }));

    const provider = new GeminiProvider({ apiKey: 'test-key' });
    await expect(
      provider.complete({
        orgId: ORG_ID,
        model: 'gemini-1.5-pro',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ status: 429, message: 'Slow down.' });
  });

  it('replays a prior functionCall as a model turn, paired with a functionResponse decoded back to its name', async () => {
    let capturedBody: { contents: unknown[] } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as { contents: unknown[] };
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 },
      });
    });

    const provider = new GeminiProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'gemini-1.5-pro',
      messages: [
        { role: 'user', content: 'Find sprint 14.' },
        {
          role: 'assistant',
          content: 'Let me check.',
          // The id a real response would have produced for the first
          // functionCall part of that turn — see `encodeCallId`.
          toolCalls: [{ id: 'search::0', name: 'search', input: { query: 'sprint 14' } }],
        },
        { role: 'tool_result', toolCallId: 'search::0', content: '[{"title":"WEB-1"}]' },
      ],
    });

    expect(capturedBody?.contents).toEqual([
      { role: 'user', parts: [{ text: 'Find sprint 14.' }] },
      {
        role: 'model',
        parts: [
          { text: 'Let me check.' },
          { functionCall: { name: 'search', args: { query: 'sprint 14' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'search', response: { result: '[{"title":"WEB-1"}]' } } },
        ],
      },
    ]);
  });

  it('marks a failed tool result as an error response, decoded back to its name', async () => {
    let capturedBody: { contents: unknown[] } | undefined;
    stubFetch((_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as { contents: unknown[] };
      return jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      });
    });

    const provider = new GeminiProvider({ apiKey: 'test-key' });
    await provider.complete({
      orgId: ORG_ID,
      model: 'gemini-1.5-pro',
      messages: [
        {
          role: 'tool_result',
          toolCallId: 'search::0',
          content: 'permission denied',
          isError: true,
        },
      ],
    });

    expect(capturedBody?.contents).toEqual([
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'search', response: { error: 'permission denied' } } }],
      },
    ]);
  });

  it('GeminiApiError is a real Error, not a plain object masquerading as one', () => {
    const error = new GeminiApiError('boom', 500);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('GeminiApiError');
    expect(error.status).toBe(500);
  });
});
