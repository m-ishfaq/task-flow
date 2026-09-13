import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Zap } from 'lucide-react';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { Pagination, StatusPill, StepUpGate, TabBar, TableSearch } from './shared.js';

/* -------------------------------------------------------------------------- *
 * Operations dashboard — "did a system action succeed or fail" (mail
 * delivery, a billing webhook, the billing sweep's heartbeat), the different
 * question from the operator audit tab, which answers "what did a
 * human operator do". Read-only in this wave — no retry action yet.
 * -------------------------------------------------------------------------- */

type OperationalEventKind = 'mail' | 'billing_webhook' | 'billing_sweep' | 'push';

const OPERATIONAL_EVENT_KINDS: readonly (readonly [OperationalEventKind | null, string])[] = [
  [null, 'All'],
  ['mail', 'Mail'],
  ['billing_webhook', 'Billing webhook'],
  ['billing_sweep', 'Billing sweep'],
  ['push', 'Push'],
];

export function OperationsTab({ onStepUp }: { readonly onStepUp: () => void }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [kind, setKind] = useState<OperationalEventKind | null>(null);
  const [search, setSearch] = useState('');

  const events = useQuery({
    queryKey: keys.platformOperations(cursor, kind),
    queryFn: async () =>
      wire(await api.platformAdmin.operations.list.query({ cursor, limit: 25, kind })),
  });

  if (errorCodeOf(events.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredEvents = events.data?.events.filter((event) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      event.kind.toLowerCase().includes(q) ||
      event.outcome.toLowerCase().includes(q) ||
      event.target?.toLowerCase().includes(q) === true
    );
  });

  return (
    <section aria-label="Operations">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          System-action outcomes across every process, newest first. For the raw container output —
          every request, not only what this table records — see{' '}
          <a
            href="/logs"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent underline underline-offset-2"
          >
            live logs
          </a>
          , gated by its own infrastructure credential, separate from this console's.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TabBar
          ariaLabel="Filter by kind"
          size="xs"
          value={kind}
          onChange={(value) => {
            setKind(value);
            setCursor(null);
          }}
          items={OPERATIONAL_EVENT_KINDS}
        />
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter events…"
          className="sm:w-48"
        />
      </div>

      {events.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {events.isError && <ErrorView error={events.error} title="Could not load operations" />}

      {events.data !== undefined &&
        (events.data.events.length === 0 ? (
          <div className="mt-6 flex flex-col items-center gap-2 py-8">
            <Zap className="size-8 text-ink-faint" strokeWidth={1.5} />
            <p className="text-sm font-medium text-ink">Nothing recorded yet</p>
            <p className="max-w-xs text-center text-xs text-ink-faint">
              Operational events will appear here as system actions occur — mail delivery, billing
              webhooks, and sweep heartbeats.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-sunken/60">
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                      When
                    </th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                      Kind
                    </th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                      Outcome
                    </th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                      Target
                    </th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-ink-faint">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {(filteredEvents ?? []).map((event) => (
                    <tr
                      key={event.id}
                      className="border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                    >
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                        {formatDateTime(event.occurredAt)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 text-xs font-medium text-ink">
                          {event.kind}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <OutcomeBadge outcome={event.outcome} />
                      </td>
                      <td className="max-w-50 px-3 py-2.5 font-mono text-xs text-ink-muted overflow-x-auto">
                        {event.target ?? '—'}
                      </td>
                      <td className="max-w-50 px-3 py-2.5 font-mono text-xs text-ink-muted overflow-x-auto">
                        {event.detail === null || event.detail === undefined
                          ? '—'
                          : JSON.stringify(event.detail)}
                      </td>
                    </tr>
                  ))}
                  {(filteredEvents ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-12 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                          <p className="text-sm text-ink-faint">No events match your search.</p>
                          <p className="text-xs text-ink-faint">
                            Try a different kind, outcome, or target.
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
                hasMore={cursor !== null || (events.data.nextCursor ?? null) !== null}
                onNewest={() => {
                  setCursor(null);
                }}
                onOlder={() => {
                  setCursor(events.data.nextCursor);
                }}
              />
            </div>
          </>
        ))}
    </section>
  );
}

function OutcomeBadge({ outcome }: { readonly outcome: string }) {
  if (outcome === 'success') {
    return <StatusPill tone="success" label="success" />;
  }
  return <StatusPill tone="danger" label="failure" />;
}
