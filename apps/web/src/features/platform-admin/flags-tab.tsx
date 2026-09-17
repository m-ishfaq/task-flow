import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { StatCard, StepUpGate, TableSearch } from './shared.js';
import {
  ArrowDownAZ,
  Flag,
  Layers,
  Puzzle,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';

/* -------------------------------------------------------------------------- *
 * Feature flags — premium operator view
 *
 * Groups flags by phase, shows summary stats, search, override status,
 * and per-flag toggle with enhanced visual treatment.
 * -------------------------------------------------------------------------- */

/**
 * Phase metadata — color and label for visual grouping.
 * Phase numbers are stable (§13 roadmap); unknown phases degrade to neutral.
 */
const PHASE_META: Record<number, { readonly label: string; readonly color: string }> = {
  5: { label: 'Phase 5', color: 'text-sky-600 bg-sky-500/10 border-sky-500/20' },
  6: { label: 'Phase 6', color: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20' },
  7: { label: 'Phase 7', color: 'text-amber-600 bg-amber-500/10 border-amber-500/20' },
  8: { label: 'Phase 8', color: 'text-violet-600 bg-violet-500/10 border-violet-500/20' },
  10: { label: 'Phase 10', color: 'text-rose-600 bg-rose-500/10 border-rose-500/20' },
  11: { label: 'Phase 11', color: 'text-indigo-600 bg-indigo-500/10 border-indigo-500/20' },
  12: { label: 'Phase 12', color: 'text-teal-600 bg-teal-500/10 border-teal-500/20' },
  13: { label: 'Phase 13', color: 'text-orange-600 bg-orange-500/10 border-orange-500/20' },
  15: { label: 'Phase 15', color: 'text-fuchsia-600 bg-fuchsia-500/10 border-fuchsia-500/20' },
};

function phaseMeta(phase: number) {
  return PHASE_META[phase] ?? { label: `Phase ${String(phase)}`, color: 'text-ink-faint bg-surface-hover border-line' };
}

interface FlagData {
  readonly flagName: string;
  readonly description: string;
  readonly phase: number;
  readonly perOrg: boolean;
  readonly source: string;
  readonly defaultValue: boolean;
  readonly value: boolean;
  readonly overrideSetAt: string | null;
}

/** Group flags by phase, sorted ascending. */
function groupByPhase(
  flags: readonly FlagData[],
) {
  const map = new Map<number, FlagData[]>();
  for (const flag of flags) {
    const existing = map.get(flag.phase);
    if (existing !== undefined) {
      existing.push(flag);
    } else {
      map.set(flag.phase, [flag]);
    }
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([phase, items]) => ({ phase, items }));
}

export function FlagsTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [expandedPhase, setExpandedPhase] = useState<number | null>(null);

  const flags = useQuery({
    queryKey: keys.platformFlags(),
    queryFn: async () => wire(await api.platformAdmin.flags.list.query(undefined)),
  });

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

  const allFlags = flags.data ?? [];

  /* Summary stats */
  const totalCount = allFlags.length;
  const activeCount = allFlags.filter((f) => f.value).length;
  const overrideCount = allFlags.filter((f) => f.source === 'override').length;
  const perOrgCount = allFlags.filter((f) => f.perOrg).length;

  /* Search filter */
  const query = search.trim().toLowerCase();
  const filtered =
    query === ''
      ? allFlags
      : allFlags.filter(
          (f) =>
            f.flagName.toLowerCase().includes(query) ||
            f.description.toLowerCase().includes(query),
        );

  const groups = groupByPhase(filtered);

  /* Toggle all expanded/collapsed when there are groups */
  const allExpanded = expandedPhase !== null && groups.every((g) => g.phase === expandedPhase);
  const toggleAll = () => {
    if (allExpanded) {
      setExpandedPhase(null);
    } else if (groups.length === 1) {
      setExpandedPhase(groups[0]?.phase ?? null);
    } else {
      /* Can't expand all at once, collapse to first */
      setExpandedPhase(groups[0]?.phase ?? null);
    }
  };

  return (
    <section aria-label="Feature flags" className="flex flex-col gap-5">
      {/* Summary stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Flag} label="Total flags" value={totalCount} />
        <StatCard
          icon={Layers}
          label="Active"
          value={activeCount}
          accent={activeCount === totalCount && totalCount > 0}
        />
        <StatCard
          icon={SlidersHorizontal}
          label="Org overrides"
          value={overrideCount}
          accent={overrideCount > 0}
        />
        <StatCard icon={Puzzle} label="Org-toggleable" value={perOrgCount} />
      </div>

      {/* Override banner */}
      {overrideCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl bg-amber-500/[0.06] px-4 py-3">
          <RefreshCw className="size-4 shrink-0 text-amber-500" strokeWidth={2} />
          <p className="text-[13px] text-amber-600">
            {overrideCount} flag{overrideCount === 1 ? ' has' : 's have'} operator overrides — these
            differ from their registry defaults.
          </p>
        </div>
      )}

      {/* Search + expand toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Search flags…"
          className="sm:w-56"
        />
        {groups.length > 1 && (
          <button
            type="button"
            onClick={toggleAll}
            className="flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
          >
            <ArrowDownAZ
              className={cn(
                'size-3.5 transition-transform',
                allExpanded && 'rotate-180',
              )}
              strokeWidth={2}
            />
            {allExpanded ? 'Collapse all' : 'Expand all'}
          </button>
        )}
      </div>

      {flags.isPending && <SkeletonRows rows={5} className="*:h-16" />}
      {flags.isError && <ErrorView error={flags.error} title="Could not load flags" />}

      {flags.data !== undefined &&
        (flags.data.length === 0 ? (
          <Empty
            title="No flags registered"
            description="Feature flags appear here once they are registered in the codebase."
          />
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12">
            <Search className="size-8 text-ink-faint" strokeWidth={1.5} />
            <p className="text-sm font-medium text-ink">No flags match your search.</p>
            <p className="text-xs text-ink-faint">Try a different name or description.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((group) => {
              const meta = phaseMeta(group.phase);
              const isExpanded = expandedPhase === null || expandedPhase === group.phase;
              const groupActive = group.items.filter((f) => f.value).length;
              const groupOverridden = group.items.filter((f) => f.source === 'override').length;

              return (
                <div key={group.phase} className="flex flex-col">
                  {/* Phase header */}
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedPhase(isExpanded && expandedPhase !== null ? null : group.phase);
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-t-xl border border-b-0 px-4 py-2.5 transition-colors',
                      meta.color,
                      isExpanded ? 'rounded-b-none' : 'rounded-b-xl',
                    )}
                  >
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        meta.color.split(' ')[0],
                      )}
                    />
                    <span className="text-xs font-semibold">{meta.label}</span>
                    <span className="text-[11px] opacity-60">
                      {group.items.length} flag{group.items.length === 1 ? '' : 's'}
                    </span>
                    {groupActive > 0 && groupActive < group.items.length && (
                      <span className="ml-auto text-[11px] opacity-60">
                        {groupActive} on
                      </span>
                    )}
                    {groupOverridden > 0 && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                        {groupOverridden} override{groupOverridden === 1 ? '' : 's'}
                      </span>
                    )}
                  </button>

                  {/* Flag rows */}
                  {isExpanded && (
                    <div className="divide-y divide-line/50 rounded-b-xl border border-t-0 border-line">
                      {group.items.map((flag) => (
                        <FlagRow key={flag.flagName} flag={flag} setPending={set.isPending} onToggle={(value) => {
                          set.mutate({ flagName: flag.flagName, value });
                        }} onReset={() => {
                          set.mutate({ flagName: flag.flagName, value: null });
                        }} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

      {set.isError && <ErrorView error={set.error} title="Could not change the flag" />}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * FlagRow — a single flag with toggle, override status, and reset
 * -------------------------------------------------------------------------- */

function FlagRow({
  flag,
  setPending,
  onToggle,
  onReset,
}: {
  readonly flag: FlagData;
  readonly setPending: boolean;
  readonly onToggle: (value: boolean) => void;
  readonly onReset: () => void;
}) {
  const isOverridden = flag.source === 'override';

  return (
    <div
      className={cn(
        'flex items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-hover/30',
        isOverridden && 'bg-amber-500/[0.02]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-sm font-medium text-ink">{flag.flagName}</p>
          {flag.perOrg && (
            <span className="rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              org-toggleable
            </span>
          )}
          {isOverridden && (
            <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
              overridden
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-ink-muted">{flag.description}</p>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          {isOverridden ? (
            <>
              default was <span className="font-medium text-ink-muted">{String(flag.defaultValue)}</span>
              {flag.overrideSetAt !== null && (
                <> · set {formatDate(flag.overrideSetAt)}</>
              )}
            </>
          ) : (
            <>default: <span className="font-medium text-ink-muted">{String(flag.defaultValue)}</span></>
          )}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {isOverridden && (
          <button
            type="button"
            disabled={setPending}
            onClick={onReset}
            className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-amber-500/30 hover:bg-amber-500/[0.06] hover:text-amber-600"
          >
            Reset
          </button>
        )}
        <ToggleSwitch
          checked={flag.value}
          disabled={setPending}
          onChange={onToggle}
          label={flag.flagName}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * ToggleSwitch — enhanced toggle with confirmed-state ring
 * -------------------------------------------------------------------------- */

function ToggleSwitch({
  checked,
  disabled,
  onChange,
  label,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label} ${checked ? 'on' : 'off'}`}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className={cn(
        'group relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        checked ? 'bg-accent' : 'bg-surface-hover',
        disabled && 'opacity-50',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-out',
          'group-hover:scale-105',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}
