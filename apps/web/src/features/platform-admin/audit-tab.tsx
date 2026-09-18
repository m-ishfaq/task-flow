import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  CreditCard,
  FileText,
  Globe,
  Radio,
  Search,
  Settings,
  Shield,
  Users,
  Zap,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { Pagination, StatCard, StepUpGate, TableSearch } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Audit Log — operator action accountability record
 *
 * Every platform-admin call is recorded in a global hash chain.
 * This tab shows the chain with enhanced visual treatment.
 * -------------------------------------------------------------------------- */

/**
 * Action categories — color-coded badges for visual scanning.
 * Unknown actions degrade to a neutral style.
 */
const ACTION_META: Record<
  string,
  { readonly label: string; readonly icon: ComponentType<LucideProps>; readonly color: string }
> = {
  'broadcast.send': { label: 'Broadcast', icon: Radio, color: 'text-sky-600 bg-sky-500/10' },
  'broadcast.resend': { label: 'Broadcast', icon: Radio, color: 'text-sky-600 bg-sky-500/10' },
  'orgs.detail': { label: 'Org detail', icon: Globe, color: 'text-amber-600 bg-amber-500/10' },
  'orgs.list': { label: 'Orgs', icon: Globe, color: 'text-amber-600 bg-amber-500/10' },
  'orgs.suspend': {
    label: 'Org suspend',
    icon: Settings,
    color: 'text-red-600 bg-red-500/10',
  },
  'orgs.reactivate': {
    label: 'Org reactivate',
    icon: Settings,
    color: 'text-emerald-600 bg-emerald-500/10',
  },
  'orgs.delete': { label: 'Org delete', icon: Settings, color: 'text-red-600 bg-red-500/10' },
  'users.list': { label: 'Users', icon: Users, color: 'text-violet-600 bg-violet-500/10' },
  'users.detail': {
    label: 'User detail',
    icon: Users,
    color: 'text-violet-600 bg-violet-500/10',
  },
  'billing.list': { label: 'Billing', icon: CreditCard, color: 'text-rose-600 bg-rose-500/10' },
  'billing.detail': {
    label: 'Billing detail',
    icon: CreditCard,
    color: 'text-rose-600 bg-rose-500/10',
  },
  'ai.providers.list': {
    label: 'AI providers',
    icon: Zap,
    color: 'text-purple-600 bg-purple-500/10',
  },
  'ai.providers.create': {
    label: 'AI provider',
    icon: Zap,
    color: 'text-purple-600 bg-purple-500/10',
  },
  'ai.providers.rotate_key': {
    label: 'AI key rotate',
    icon: Zap,
    color: 'text-purple-600 bg-purple-500/10',
  },
  'ai.providers.delete': {
    label: 'AI provider',
    icon: Zap,
    color: 'text-purple-600 bg-purple-500/10',
  },
  'ai.spend_report': {
    label: 'AI spend',
    icon: Zap,
    color: 'text-purple-600 bg-purple-500/10',
  },
  'audit.list': { label: 'Audit', icon: Shield, color: 'text-ink-faint bg-surface-hover' },
  'flags.list': { label: 'Flags', icon: FileText, color: 'text-cyan-600 bg-cyan-500/10' },
  'flags.set': { label: 'Flag set', icon: FileText, color: 'text-cyan-600 bg-cyan-500/10' },
};

function actionMeta(action: string) {
  return (
    ACTION_META[action] ?? {
      label: action,
      icon: Shield,
      color: 'text-ink-faint bg-surface-hover',
    }
  );
}

function TargetBlock({ target }: { readonly target: unknown }) {
  const [expanded, setExpanded] = useState(false);

  if (target === null || target === undefined) {
    return <span className="text-ink-faint">—</span>;
  }

  const json = JSON.stringify(target, null, expanded ? 2 : 0);
  const isComplex = typeof target === 'object' && Object.keys(target).length > 2;
  const preview = JSON.stringify(target);

  return (
    <div className="group flex items-start gap-1.5">
      <code
        className={cn(
          'min-w-0 flex-1 whitespace-nowrap font-mono text-[11px] leading-relaxed text-ink-muted',
          expanded && 'whitespace-pre-wrap break-all',
        )}
        title={preview}
      >
        {expanded ? json : preview.length > 60 ? preview.slice(0, 57) + '...' : preview}
      </code>
      {isComplex && (
        <button
          type="button"
          onClick={() => {
            setExpanded((p) => !p);
          }}
          className="mt-0.5 shrink-0 rounded p-0.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink opacity-0 group-hover:opacity-100"
          aria-label={expanded ? 'Collapse target' : 'Expand target'}
        >
          {expanded ? (
            <ChevronUp className="size-3" strokeWidth={2} />
          ) : (
            <ChevronDown className="size-3" strokeWidth={2} />
          )}
        </button>
      )}
    </div>
  );
}

export function AuditTab({ onStepUp }: { readonly onStepUp: () => void }) {
  const [before, setBefore] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const entries = useQuery({
    queryKey: keys.platformAudit(before),
    queryFn: async () => wire(await api.platformAdmin.audit.list.query({ limit: 50, before })),
  });

  if (errorCodeOf(entries.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredEntries = entries.data?.entries.filter((entry) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      entry.action.toLowerCase().includes(q) ||
      entry.operatorEmail.toLowerCase().includes(q) ||
      (entry.target !== null && JSON.stringify(entry.target).toLowerCase().includes(q))
    );
  });

  const totalEntries = entries.data?.entries.length ?? 0;
  const uniqueOperators =
    entries.data !== undefined ? new Set(entries.data.entries.map((e) => e.operatorEmail)).size : 0;

  return (
    <section aria-label="Operator audit" className="flex flex-col gap-5">
      {/* ---- header ---- */}
      <div>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          The accountability record of every operator action. Every call — including reads — is
          recorded in a hash-chained log. An operator cannot erase or reorder their own history.
        </p>
      </div>

      {/* ---- summary stats ---- */}
      {entries.data !== undefined && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard icon={FileText} label="Entries loaded" value={totalEntries} />
          <StatCard icon={Users} label="Unique operators" value={uniqueOperators} />
          <StatCard
            icon={Shield}
            label="Chain integrity"
            accent
            value={totalEntries > 0 ? 'Valid' : 'Empty'}
          />
        </div>
      )}

      {/* ---- search ---- */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by action, operator, or target…"
        />
      </div>

      {/* ---- table ---- */}
      {entries.isPending && <SkeletonRows rows={5} className="*:h-12" />}
      {entries.isError && (
        <ErrorView error={entries.error} title="Could not load the operator audit" />
      )}

      {entries.data !== undefined &&
        (entries.data.entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface-raised py-12">
            <span className="flex size-12 items-center justify-center rounded-xl bg-surface-hover text-ink-faint">
              <Shield className="size-6" strokeWidth={1.5} />
            </span>
            <div className="text-center">
              <p className="text-sm font-medium text-ink">Nothing recorded yet</p>
              <p className="mt-1 max-w-xs text-xs text-ink-faint">
                Operator actions will appear here once they are taken. Every call — including reads
                — is recorded in the hash chain.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-line bg-surface-raised">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-sunken/60">
                    <th className="w-14 px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Seq
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      When
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Action
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Target
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Operator
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {(filteredEntries ?? []).map((entry) => {
                    const meta = actionMeta(entry.action);
                    const Icon = meta.icon;
                    return (
                      <tr
                        key={entry.seq}
                        className="border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                      >
                        {/* Chain rail — a continuous line down the Seq column,
                            one dot per entry, the same "linked record" shape
                            a commit graph or block explorer uses. */}
                        <td className="relative px-3 py-2.5 font-mono text-xs text-ink-faint">
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 left-3.75 w-px bg-line"
                          />
                          <span className="relative z-10 flex items-center gap-2">
                            <span className="size-1.5 shrink-0 rounded-full bg-accent ring-2 ring-surface" />
                            {entry.seq}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-ink-muted">
                          {formatDateTime(entry.occurredAt)}
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-xs font-medium',
                              meta.color,
                            )}
                          >
                            <Icon aria-hidden="true" className="size-3" strokeWidth={2} />
                            {entry.action}
                          </span>
                        </td>
                        <td className="max-w-50 px-3 py-2.5 overflow-x-auto">
                          <TargetBlock target={entry.target} />
                        </td>
                        <td className="px-3 py-2.5">
                          <span
                            className="inline-flex items-center gap-1.5 text-xs text-ink-muted"
                            title={entry.operatorId}
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-hover text-[10px] font-medium text-ink-faint">
                              {entry.operatorEmail.charAt(0).toUpperCase()}
                            </span>
                            <span className="truncate">{entry.operatorEmail}</span>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {(filteredEntries ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-12 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                          <p className="text-sm text-ink-faint">No entries match your search.</p>
                          <p className="text-xs text-ink-faint">
                            Try a different action, operator email, or target.
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-3">
              <Pagination
                hasMore={before !== null || entries.data.entries.length >= 50}
                countLabel={`${String(totalEntries)} entries loaded`}
                onNewest={() => {
                  setBefore(null);
                }}
                onOlder={() => {
                  setBefore(entries.data.entries[entries.data.entries.length - 1]?.seq ?? null);
                }}
              />
            </div>
          </>
        ))}
    </section>
  );
}
