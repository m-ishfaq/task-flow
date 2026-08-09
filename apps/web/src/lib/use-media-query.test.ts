import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from './use-media-query.js';

/**
 * A minimal, controllable `MediaQueryList` stand-in — real enough to drive
 * `useSyncExternalStore`'s subscribe/snapshot contract without needing a
 * real layout engine. `matches` is mutable and `fire()` simulates the
 * browser flipping it, which is the one thing `apps/web/src/testing/setup.ts`'s
 * always-true global mock can't do (it never changes).
 */
function fakeMediaQueryList(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<() => void>();
  return {
    get matches() {
      return matches;
    },
    addEventListener: (_event: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: () => void) => {
      listeners.delete(listener);
    },
    fire(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('useMediaQuery', () => {
  const originalMatchMedia = window.matchMedia.bind(window);

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('reads the initial match synchronously, before any effect could run', () => {
    const mql = fakeMediaQueryList(true);
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));

    /* No `act(() => {})` wrapping the render, no waiting — if this needed an
       effect to settle, the first render would still show the wrong value
       here. `useSyncExternalStore`'s whole point is that it doesn't. */
    expect(result.current).toBe(true);
  });

  it('updates when the underlying media query changes', () => {
    const mql = fakeMediaQueryList(false);
    window.matchMedia = vi.fn().mockReturnValue(mql);

    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);

    act(() => {
      mql.fire(true);
    });

    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const mql = fakeMediaQueryList(true);
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ ...mql, removeEventListener });

    const { unmount } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    unmount();

    expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
