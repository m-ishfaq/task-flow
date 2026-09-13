import { apiErrorOf } from '../lib/trpc.js';
import { fieldErrors } from '../lib/field-errors.js';
import { messageFor } from '../lib/error-message.js';
import { cn } from '../lib/cn.js';

/**
 * How a failure is SHOWN. The wording itself lives in lib/error-message.ts.
 *
 * The REQUEST ID is always rendered when there is one. It is the only thing
 * connecting what the user sees to the server log line and the audit entry for
 * the same request, and asking someone to reproduce a failure they have already
 * had is how a bug report dies.
 */

export interface ErrorViewProps {
  readonly error: unknown;
  readonly className?: string;
  /** Shown above the message, e.g. "Could not save the card". */
  readonly title?: string;
  /**
   * Design Bible §17's own "Error · Retryable" state names the property
   * this adds: a failed query — not a failed form submit — usually means
   * "the request never reached the server," which a click can fix with no
   * new input needed. Deliberately optional and additive rather than a
   * redesign of this component's own layout: `ErrorView` renders at over a
   * hundred call sites across this app, most of them a compact inline
   * banner (a form's own validation error, a small dialog) where the
   * mockup's larger, centered "state card" treatment would be actively
   * wrong. A caller that HAS something to retry — almost always a React
   * Query `refetch` — passes it; everyone else is unchanged, byte for byte.
   */
  readonly onRetry?: () => void;
}

export function ErrorView({ error, className, title, onRetry }: ErrorViewProps) {
  const api = apiErrorOf(error);
  const message = messageFor(error);
  const fields = fieldErrors(error);

  return (
    <div
      role="alert"
      className={cn(
        'rounded border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink',
        className,
      )}
    >
      {title !== undefined && <p className="font-medium">{title}</p>}
      <p>{message}</p>

      {fields.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
          {fields.map(([field, reason]) => (
            <li key={field}>
              <span className="font-medium">{field === '_' ? 'request' : field}</span>: {reason}
            </li>
          ))}
        </ul>
      )}

      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1.5 rounded-md border border-danger/30 bg-surface px-2.5 py-1 text-xs font-medium text-ink transition-colors duration-(--motion-fast) hover:bg-surface-hover"
        >
          Try again
        </button>
      )}

      {api !== null && (
        <p className="mt-1 font-mono text-xs text-ink-faint">Reference {api.error.requestId}</p>
      )}
    </div>
  );
}

/** The same thing inline, for a form field or a row. */
export function ErrorText({ error }: { readonly error: unknown }) {
  const message = messageFor(error);
  const fields = fieldErrors(error);

  return (
    <p role="alert" className="text-xs text-danger">
      {fields.length > 0
        ? fields.map(([field, reason]) => `${field}: ${reason}`).join('; ')
        : message}
    </p>
  );
}
