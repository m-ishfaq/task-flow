import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StepUpGate } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Feature flags
 * -------------------------------------------------------------------------- */

export function FlagsTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const flags = useQuery({
    queryKey: keys.platformFlags(),
    queryFn: async () => wire(await api.platformAdmin.flags.list.query(undefined)),
  });

  /* `flagName` is typed `string` on the client (zod's `.refine()` does not
     narrow the inferred type) and re-validated against FLAG_NAMES by the
     route — the names here come from the server's own registry list, so
     passing them straight back needs no cast. */
  const set = useMutation({
    mutationFn: (input: { flagName: string; value: boolean | null }) =>
      api.platformAdmin.flags.set.mutate(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.platformFlags() });
    },
    onError: (error, input) => {
      guard(error, () => {
        set.mutate(input);
      });
    },
  });

  if (errorCodeOf(flags.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  return (
    <section aria-label="Feature flags">
      <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
        Global overrides — the table the evaluator never had. A toggle here changes what every
        organization resolves until the override is reset.
      </p>

      {flags.isPending && <SkeletonRows rows={5} className="*:h-16" />}
      {flags.isError && <ErrorView error={flags.error} title="Could not load flags" />}

      {flags.data !== undefined &&
        (flags.data.length === 0 ? (
          <Empty
            title="No flags registered"
            description="Feature flags appear here once they are registered in the codebase."
          />
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {flags.data.map((flag) => (
              <li
                key={flag.flagName}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover/30"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                    {flag.flagName}
                    <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-faint">
                      Phase {flag.phase}
                    </span>
                    {flag.perOrg && (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent">
                        org-toggleable
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">{flag.description}</p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {flag.source === 'override' ? (
                      <>
                        <span className="font-medium text-warning">overridden</span> — default was{' '}
                        {String(flag.defaultValue)}
                        {flag.overrideSetAt !== null && `, set ${formatDate(flag.overrideSetAt)}`}
                      </>
                    ) : (
                      'using the registry default'
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {flag.source === 'override' && (
                    <button
                      type="button"
                      disabled={set.isPending}
                      onClick={() => {
                        set.mutate({ flagName: flag.flagName, value: null });
                      }}
                      className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={flag.value}
                    aria-label={`${flag.flagName} ${flag.value ? 'on' : 'off'}`}
                    disabled={set.isPending}
                    onClick={() => {
                      set.mutate({ flagName: flag.flagName, value: !flag.value });
                    }}
                    className={cn(
                      'relative h-6 w-11 rounded-full transition-colors',
                      flag.value ? 'bg-accent' : 'bg-surface-hover',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute top-0.5 left-0.5 size-5 rounded-full bg-accent-ink shadow-sm transition-transform duration-200',
                        flag.value ? 'translate-x-5' : 'translate-x-0',
                      )}
                    />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}

      {set.isError && <ErrorView error={set.error} title="Could not change the flag" />}
    </section>
  );
}
