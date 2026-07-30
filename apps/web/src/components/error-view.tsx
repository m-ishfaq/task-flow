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
}

export function ErrorView({ error, className, title }: ErrorViewProps) {
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

      {api !== null && (
        <p className="mt-1 font-mono text-[11px] text-ink-faint">Reference {api.error.requestId}</p>
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
