import { useState } from 'react';
import { Button } from './primitives.js';

/**
 * The one-time secret reveal, with a copy button.
 *
 * Used by the webhook and API-token creation flows — both mint a secret that
 * is shown exactly once and is never readable again. The dismissal is a
 * deliberate click rather than a timeout: a secret that vanished while
 * someone was still reading it is a recreated resource.
 */
export function SecretReveal({
  name,
  secret,
  onDismiss,
}: {
  readonly name: string;
  readonly secret: string;
  readonly onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 space-y-1.5 rounded-lg border border-warning/40 bg-warning/5 p-3">
      <p className="text-xs text-ink">
        Secret for “{name}” — <span className="font-medium">shown once, never again.</span> Copy it
        into whatever will use it, then click done.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-ink">
          {secret}
        </code>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
          onClick={() => {
            void navigator.clipboard.writeText(secret).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Done with the secret"
          className="text-xs text-ink-faint transition-colors duration-[var(--motion-fast)] hover:text-ink"
        >
          Done
        </button>
      </div>
    </div>
  );
}
