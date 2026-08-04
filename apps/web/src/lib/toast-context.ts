import { createContext, useContext } from 'react';

/**
 * The toast context, separated from the provider that fills it.
 *
 * Split for `react-refresh/only-export-components`: a module exporting both a
 * component and a hook remounts wholesale on every save, so an open card panel
 * and any in-flight drag state are lost each time the file is touched. The rule
 * is a warning rather than an error precisely because the fix is this trivial.
 *
 * See components/toast.tsx for why toasts exist at all — briefly, an optimistic
 * rollback with no message is indistinguishable from a bug.
 */

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastApi {
  readonly show: (title: string, options?: { description?: string; tone?: ToastTone }) => void;
  /**
   * Reports a failed mutation.
   *
   * Takes the error rather than a string so a caller cannot accidentally surface
   * an internal message: the provider runs it through `messageFor`, which
   * returns the server's safe-to-display text (§8.7) or a generic fallback,
   * never a stack or a driver error.
   */
  readonly failure: (title: string, error: unknown) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

/**
 * The toast API.
 *
 * Throws when there is no provider rather than returning a no-op. A silent
 * no-op would make every rollback message vanish the moment something rendered
 * outside the provider, and the symptom — failures that produce no feedback — is
 * exactly what toasts exist to prevent.
 */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}
