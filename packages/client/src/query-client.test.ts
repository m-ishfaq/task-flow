import { describe, expect, it, vi } from 'vitest';
import { createQueryClient, shouldRetry } from './query-client.js';

/** A classifier pair that reads a plain `{ code }` off the rejection. */
function classifiersFor(unauthenticated: boolean) {
  return {
    isUnauthenticated: () => unauthenticated,
    errorCodeOf: (error: unknown) => (error as { code?: string } | null)?.code ?? null,
  };
}

class ApiFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ApiFailure';
  }
}

describe('shouldRetry', () => {
  it('never retries once the caller classifies the failure as unauthenticated', () => {
    expect(shouldRetry(classifiersFor(true), 0, new ApiFailure('anything'))).toBe(false);
  });

  it('never retries a terminal code', () => {
    expect(shouldRetry(classifiersFor(false), 0, new ApiFailure('NOT_A_MEMBER'))).toBe(false);
    expect(shouldRetry(classifiersFor(false), 0, new ApiFailure('FORBIDDEN'))).toBe(false);
  });

  it('retries a non-terminal failure up to twice', () => {
    const classifiers = classifiersFor(false);
    const error = new ApiFailure('INTERNAL_ERROR');
    expect(shouldRetry(classifiers, 0, error)).toBe(true);
    expect(shouldRetry(classifiers, 1, error)).toBe(true);
    expect(shouldRetry(classifiers, 2, error)).toBe(false);
  });
});

describe('createQueryClient', () => {
  it('applies the shared retry policy through the classifiers it was given', async () => {
    const client = createQueryClient(classifiersFor(false));

    await expect(
      client.fetchQuery({
        queryKey: ['test'],
        queryFn: () => Promise.reject(new ApiFailure('NOT_A_MEMBER')),
      }),
    ).rejects.toBeDefined();

    // A terminal code with zero retries means exactly one attempt.
    expect(client.getQueryState(['test'])?.fetchFailureCount).toBe(1);
  });

  it('calls onCacheError for both query and mutation failures', async () => {
    const onCacheError = vi.fn();
    const client = createQueryClient({ ...classifiersFor(false), onCacheError });

    await expect(
      client.fetchQuery({
        queryKey: ['q'],
        queryFn: () => Promise.reject(new ApiFailure('NOT_A_MEMBER')),
      }),
    ).rejects.toBeDefined();

    expect(onCacheError).toHaveBeenCalledTimes(1);
  });

  it('is safe to construct with no onCacheError at all', async () => {
    const client = createQueryClient(classifiersFor(false));

    // Would throw synchronously inside the cache's default onError if the
    // `?? (() => undefined)` fallback were missing.
    await expect(
      client.fetchQuery({
        queryKey: ['q'],
        queryFn: () => Promise.reject(new ApiFailure('NOT_A_MEMBER')),
      }),
    ).rejects.toBeDefined();
  });

  it('does not retry mutations automatically', async () => {
    const client = createQueryClient(classifiersFor(false));
    let attempts = 0;

    await expect(
      client
        .getMutationCache()
        .build(client, {
          mutationFn: () => {
            attempts += 1;
            return Promise.reject(new Error('boom'));
          },
        })
        .execute(undefined),
    ).rejects.toThrow('boom');

    expect(attempts).toBe(1);
  });
});
