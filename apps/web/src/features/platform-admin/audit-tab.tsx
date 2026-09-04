import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Shield } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { Pagination, StepUpGate, TableSearch } from './shared.js';

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
                        <span className="inline-flex items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 text-xs font-medium text-ink">
                          {entry.action}
                        </span>
                      </td>
                      <td className="max-w-50 px-3 py-2.5 font-mono text-[11px] text-ink-muted overflow-x-auto">
                        {entry.target === null ? '—' : JSON.stringify(entry.target)}
                      </td>
                      <td className="px-3 py-2.5 text-ink-muted">
                        <span className="truncate" title={entry.operatorId}>
                          {entry.operatorEmail}
                        </span>
                      </td>
                    </tr>
                  ))}
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
