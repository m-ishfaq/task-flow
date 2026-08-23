import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useOptimistic } from './optimistic.js';

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useOptimistic', () => {
  it('patches immediately, rolls back on failure, and reports through onFailure', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(['card', 1], { title: 'before' });
    const onFailure = vi.fn();

    // A deferred mutationFn, resolved by hand below — an instantly-rejecting
    // one leaves no real window in which to observe the patch BEFORE the
    // rollback, since both would already have run by the first `waitFor`
    // poll and the assertion would pass for the wrong reason.
    let rejectMutation: (error: Error) => void = () => undefined;
    const mutationFn = () =>
      new Promise<never>((_resolve, reject) => {
        rejectMutation = reject;
      });

    const { result } = renderHook(
      () => {
        const optimistic = useOptimistic(onFailure);
        return useMutation({
          mutationFn,
          ...optimistic({
            keys: [['card', 1]],
            patch: (c) => c.setQueryData(['card', 1], { title: 'after' }),
            failureTitle: 'Could not save',
          }),
        });
      },
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate(undefined);
    });

    // The patch is synchronous inside onMutate, so it is visible immediately —
    // well before the still-pending mutationFn resolves at all.
    await waitFor(() => {
      expect(client.getQueryData(['card', 1])).toEqual({ title: 'after' });
    });

    act(() => {
      rejectMutation(new Error('server said no'));
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(client.getQueryData(['card', 1])).toEqual({ title: 'before' });
    expect(onFailure).toHaveBeenCalledWith('Could not save', expect.any(Error));
  });

  it('removes a key that did not exist before the patch, rather than leaving it undefined', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    // No prior data at this key — the created-then-rolled-back case.

    const { result } = renderHook(
      () => {
        const optimistic = useOptimistic(() => undefined);
        return useMutation({
          mutationFn: () => Promise.reject(new Error('nope')),
          ...optimistic({
            keys: [['new-card']],
            patch: (c) => c.setQueryData(['new-card'], { title: 'guess' }),
            failureTitle: 'Could not create',
          }),
        });
      },
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate(undefined);
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    // Not `undefined` as a VALUE — genuinely absent, or a later read treats
    // the rolled-back entry as real cached data.
    expect(client.getQueryState(['new-card'])).toBeUndefined();
  });

  it('invalidates every affected key on settle, success or failure alike', async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(['card', 1], { title: 'before' });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

    const { result } = renderHook(
      () => {
        const optimistic = useOptimistic(() => undefined);
        return useMutation({
          mutationFn: () => Promise.resolve({ title: 'server truth' }),
          ...optimistic({
            keys: [['card', 1]],
            patch: (c) => c.setQueryData(['card', 1], { title: 'guess' }),
            failureTitle: 'Could not save',
          }),
        });
      },
      { wrapper: wrapperFor(client) },
    );

    act(() => {
      result.current.mutate(undefined);
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['card', 1] });
  });
});
