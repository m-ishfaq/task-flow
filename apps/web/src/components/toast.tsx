import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import * as RadixToast from '@radix-ui/react-toast';
import { messageFor } from '../lib/error-message.js';
import { apiErrorOf } from '../lib/trpc.js';
import { ToastContext, type ToastApi, type ToastTone } from '../lib/toast-context.js';
import { cn } from '../lib/cn.js';

/**
 * Transient feedback (PLAN.md §10.5).
 *
 * ## Why this exists at all
 *
 * §10.5 requires every user-visible interaction to be optimistic: patch the
 * cache, then reconcile. That makes the SUCCESS path silent, which is the point
 * — but it also makes the FAILURE path silent, because a rollback restores the
 * previous value and nothing on screen says why. A card that snaps back to its
 * old column with no explanation reads as a bug in the drag, and the user's next
 * move is to try again against a server that will refuse again.
 *
 * So a toast is not decoration here; it is the other half of optimism. Nothing
 * should roll back without one.
 *
 * ## Why Radix rather than a div
 *
 * The `role="status"` live region, focus management and swipe-to-dismiss are the
 * whole job, and the live region is the part that is easy to get wrong and
 * invisible when you do. A toast a screen reader never announces is a failure
 * the user never learns about — the exact case where the toast was the only
 * notification.
 *
 * The hook lives in lib/toast-context.ts; see the note there on why.
 */

interface ToastRecord {
  readonly id: number;
  readonly title: string;
  readonly description?: string | undefined;
  readonly tone: ToastTone;
}

/**
 * How long a toast stays up.
 *
 * Longer for failures. A success confirms something the user just watched
 * happen and does not need reading; a failure is the only account of why the
 * screen changed back, and four seconds is not enough to read a sentence and
 * decide what to do about it.
 */
const DURATIONS: Readonly<Record<ToastTone, number>> = {
  neutral: 4000,
  success: 4000,
  danger: 9000,
};

const TONES: Readonly<Record<ToastTone, string>> = {
  neutral: 'border-line bg-surface-raised',
  success: 'border-success/40 bg-success/10',
  danger: 'border-danger/40 bg-danger/10',
};

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);

  /* A ref rather than a module or closure variable. React Compiler rejects
     reassigning a captured `let` after render, and it is right to: a counter
     that lives in a closure created during render is reset by every re-render
     that recreates it, so two toasts would eventually share a key and React
     would reuse one's DOM node for the other. `Math.random()` is banned
     repo-wide (CLAUDE.md rule 5) and a CSPRNG for a list key would be absurd. */
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const api = useMemo<ToastApi>(() => {
    const push = (record: Omit<ToastRecord, 'id'>) => {
      nextId.current += 1;
      const id = nextId.current;
      setToasts((current) => [...current, { ...record, id }]);
    };

    return {
      show: (title, options) => {
        push({
          title,
          tone: options?.tone ?? 'neutral',
          ...(options?.description === undefined ? {} : { description: options.description }),
        });
      },

      failure: (title, error) => {
        /* The request id when the server gave one. It is the only thread between
           what the user saw and the log line for the same request, and a toast
           that drops it makes a bug report unactionable — the same reason
           `ErrorView` always renders it. */
        const requestId = apiErrorOf(error)?.error.requestId;
        const message = messageFor(error);

        push({
          title,
          tone: 'danger',
          description: requestId === undefined ? message : `${message} (ref ${requestId})`,
        });
      },
    };
  }, []);

  return (
    <ToastContext.Provider value={api}>
      <RadixToast.Provider swipeDirection="right">
        {children}

        {toasts.map((toast) => (
          <RadixToast.Root
            key={toast.id}
            duration={DURATIONS[toast.tone]}
            onOpenChange={(open) => {
              if (!open) dismiss(toast.id);
            }}
            className={cn('relative rounded border px-3 py-2 pr-7 shadow-lg', TONES[toast.tone])}
          >
            <RadixToast.Title className="text-sm font-medium text-ink">
              {toast.title}
            </RadixToast.Title>
            {toast.description !== undefined && (
              <RadixToast.Description className="mt-0.5 text-xs text-ink-muted">
                {toast.description}
              </RadixToast.Description>
            )}
            <RadixToast.Close
              aria-label="Dismiss"
              className="absolute right-1.5 top-1.5 rounded px-1 text-xs text-ink-faint hover:text-ink"
            >
              ✕
            </RadixToast.Close>
          </RadixToast.Root>
        ))}

        <RadixToast.Viewport className="fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
