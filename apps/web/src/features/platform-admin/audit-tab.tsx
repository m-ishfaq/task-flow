import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link2, Search, Shield } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { Pagination, SectionHeader, StepUpGate, TableSearch } from './shared.js';

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

  return (
    <section aria-label="Operator audit">
      <SectionHeader
        icon={Shield}
        title="Operator audit"
        subtitle="global, hash-chained — reads logged too"
      />
      <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
        Every platform-admin call lands in a global hash chain — the accountability record of this
        tier itself. Reading it is recorded too.
      </p>

      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by action, operator, or target…"
        />
      </div>

      {entries.isPending && (
        <div className="mt-3">
          <SkeletonRows rows={5} className="*:h-12" />
        </div>
      )}
      {entries.isError && (
        <ErrorView error={entries.error} title="Could not load the operator audit" />
      )}

      {entries.data !== undefined &&
        (entries.data.entries.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 py-8">
            <Shield className="size-8 text-ink-faint" strokeWidth={1.5} />
            <p className="text-sm font-medium text-ink">Nothing recorded yet</p>
            <p className="max-w-xs text-center text-xs text-ink-faint">
              Operator actions will appear here once they are taken. Every call — including reads —
              is recorded in the hash chain.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-sunken/60">
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
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
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Chain
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {(filteredEntries ?? []).map((entry) => (
                    <tr
                      key={entry.seq}
                      className="border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                    >
                      <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">{entry.seq}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="px-3 py-2.5">
                        <ActionBadge action={entry.action} />
                      </td>
                      <td className="max-w-50 px-3 py-2.5 font-mono text-[11px] text-ink-muted overflow-x-auto">
                        {entry.target === null ? '—' : JSON.stringify(entry.target)}
                      </td>
                      <td className="px-3 py-2.5 text-ink-muted">
                        <span className="truncate" title={entry.operatorId}>
                          {entry.operatorEmail}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {/* Not a link — there is no verifier page for this to
                            open. The glyph is a visual reminder that this row
                            is cryptographically chained to the one before
                            it (the trigger's own `prev_hash`/`hash`
                            columns), not a control. */}
                        <span
                          className="inline-flex items-center gap-1 font-mono text-[11px] text-ink-faint"
                          title={entry.hash}
                        >
                          <Link2 aria-hidden="true" className="size-3" strokeWidth={2} />
                          {entry.hash.slice(0, 4)}…{entry.hash.slice(-3)}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {(filteredEntries ?? []).length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-12 text-center">
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

/**
 * Colors an action by what it DOES, not by a hardcoded map of every action
 * string this log can ever contain — the registry of action names lives in
 * every route that calls `recordOperatorAction`, and a hardcoded switch here
 * would silently fall back to "neutral" for the next one added, forever.
 * Three verb classes cover the real blast radius a reader actually cares
 * about at a glance: `.suspend`/`.remove`/`.delete` (danger — takes access
 * away or destroys something), `.set`/`.grant`/`.create`/`.update`/
 * `.reactivate` (accent — grants or changes something), and everything else,
 * including every `.list`/`.get` read, as a plain neutral chip.
 */
function ActionBadge({ action }: { readonly action: string }) {
  const isDanger = /\.(suspend|remove|delete)/.test(action);
  const isChange = /\.(set|grant|create|update|reactivate)/.test(action);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs font-medium',
        isDanger
          ? 'bg-danger/10 text-danger'
          : isChange
            ? 'bg-accent/10 text-accent'
            : 'bg-surface-hover text-ink-muted',
      )}
    >
      {action}
    </span>
  );
}
