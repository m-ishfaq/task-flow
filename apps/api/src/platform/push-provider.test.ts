import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpoPushProvider } from './push-provider.js';

/**
 * `ExpoPushProvider` — the response-parsing half is worth testing directly
 * (Expo's array-request/array-response shape is easy to get subtly wrong,
 * and a wrong mapping either silently drops real devices as "gone" or
 * retries a dead token forever). `WebPushProvider` alongside it in this
 * file has no test of its own — it calls `fetch` the identical un-injected
 * way — so this uses `vi.stubGlobal('fetch', ...)` rather than adding
 * dependency injection neither provider currently has, matching this
 * file's own existing shape instead of deviating from it for one class.
 */

function stubFetch(response: {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => unknown;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.resolve(response)),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExpoPushProvider', () => {
  it('reports "sent" for an ok ticket', async () => {
    stubFetch({ ok: true, status: 200, json: () => ({ data: [{ status: 'ok', id: 'abc' }] }) });
    const provider = new ExpoPushProvider();

    const outcome = await provider.send({
      expoPushToken: 'ExponentPushToken[abc]',
      title: 'Hello',
      body: null,
      path: null,
    });

    expect(outcome).toBe('sent');
  });

  it('reports "gone" for a DeviceNotRegistered error ticket', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: () => ({
        data: [{ status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }],
      }),
    });
    const provider = new ExpoPushProvider();

    const outcome = await provider.send({
      expoPushToken: 'ExponentPushToken[abc]',
      title: 'Hello',
      body: null,
      path: null,
    });

    expect(outcome).toBe('gone');
  });

  it('reports "failed" for any other error ticket', async () => {
    stubFetch({
      ok: true,
      status: 200,
      json: () => ({
        data: [{ status: 'error', message: 'x', details: { error: 'MessageTooBig' } }],
      }),
    });
    const provider = new ExpoPushProvider();

    const outcome = await provider.send({
      expoPushToken: 'ExponentPushToken[abc]',
      title: 'Hello',
      body: null,
      path: null,
    });

    expect(outcome).toBe('failed');
  });

  it('throws (transient) on a non-2xx response, never returning "failed"', async () => {
    stubFetch({ ok: false, status: 500, json: () => ({}) });
    const provider = new ExpoPushProvider();

    await expect(
      provider.send({
        expoPushToken: 'ExponentPushToken[abc]',
        title: 'Hello',
        body: null,
        path: null,
      }),
    ).rejects.toThrow();
  });

  it('throws on a response with no recognizable ticket shape', async () => {
    stubFetch({ ok: true, status: 200, json: () => ({ unexpected: true }) });
    const provider = new ExpoPushProvider();

    await expect(
      provider.send({
        expoPushToken: 'ExponentPushToken[abc]',
        title: 'Hello',
        body: null,
        path: null,
      }),
    ).rejects.toThrow();
  });

  it('sends the access token as a bearer header when configured', async () => {
    let capturedHeaders: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { readonly headers?: unknown }) => {
        capturedHeaders = init?.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({ data: [{ status: 'ok' }] }),
        });
      }),
    );
    const provider = new ExpoPushProvider({ accessToken: 'secret-token' });

    await provider.send({
      expoPushToken: 'ExponentPushToken[abc]',
      title: 'Hello',
      body: null,
      path: null,
    });

    expect(capturedHeaders).toMatchObject({ Authorization: 'Bearer secret-token' });
  });

  it('omits the Authorization header entirely when no access token is configured', async () => {
    let capturedHeaders: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: { readonly headers?: unknown }) => {
        capturedHeaders = init?.headers;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => ({ data: [{ status: 'ok' }] }),
        });
      }),
    );
    const provider = new ExpoPushProvider();

    await provider.send({
      expoPushToken: 'ExponentPushToken[abc]',
      title: 'Hello',
      body: null,
      path: null,
    });

    expect(capturedHeaders).not.toHaveProperty('Authorization');
  });
});
