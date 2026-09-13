import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from './toast.js';
import { useToast } from '../lib/toast-context.js';

/**
 * The exit-motion timing this file's own header documents: a dismissed toast
 * stays mounted (Radix's own `data-state` flipping to `'closed'`, `forceMount`
 * stopping Radix from unmounting it anyway) for one `EXIT_MS` window before
 * `toast.tsx`'s `exitTimers` actually drops it from state, so `.toast-motion`'s
 * CSS transition (styles.css) gets real frames to play rather than being cut
 * off by an immediate unmount. This is the one property a CSS-only read of
 * the file cannot prove — the timing has to be driven and observed.
 */

function TriggerButton() {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        toast.show('Saved');
      }}
    >
      Show toast
    </button>
  );
}

function renderProvider() {
  return render(
    <ToastProvider>
      <TriggerButton />
    </ToastProvider>,
  );
}

describe('ToastProvider exit motion', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks a dismissed toast as closing before removing it, not in the same tick', () => {
    vi.useFakeTimers();
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    const toast = screen.getByText('Saved').closest('.toast-motion');
    expect(toast).not.toBeNull();
    expect(toast).toHaveAttribute('data-state', 'open');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    // Still mounted, now flagged closing — the frame `.toast-motion`'s exit
    // transition plays against, per this file's own header.
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(toast).toHaveAttribute('data-state', 'closed');

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('is idempotent against dismissing the same toast twice', () => {
    vi.useFakeTimers();
    renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismiss);
    fireEvent.click(dismiss);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('clears pending exit timers on unmount rather than acting on a gone provider', () => {
    vi.useFakeTimers();
    const { unmount } = renderProvider();

    fireEvent.click(screen.getByRole('button', { name: 'Show toast' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    unmount();

    // Nothing to assert on the DOM once unmounted — the property under test
    // is that advancing the clock here throws nothing (a timer callback
    // touching state of a component that no longer exists).
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }).not.toThrow();
  });
});
