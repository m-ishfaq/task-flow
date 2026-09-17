import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { wire } from '@taskflow/client';
import { formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { Avatar, Button, Empty, PageHeader, Spinner } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';

/**
 * The audit log, and the integrity check over it (§8.6).
 *
 * ## Two different permissions, deliberately
 *
 * READING is `audit:read` — Owner and Admin. VERIFYING is `audit:export`, which
 * is Owner-only, because a verification result is a statement about the
 * integrity of the compliance record and the capability to make that statement
 * belongs with the right to take the record out of the system.
 *
 * ## What "intact" actually means here
 *
 * The log is append-only by GRANT, not by convention: `taskflow_audit` holds
 * INSERT and SELECT and no UPDATE or DELETE anywhere, and `seq`, `prev_hash` and
 * `hash` are assigned by a Postgres trigger under a per-org chain-head lock, so
 * a writer cannot choose its own position or digest.
 *
 * Verification recomputes the chain and reports every break. A green result is
 * meaningful; a red one names the exact sequence numbers, which is the only
 * thing an incident responder can act on.
 */
export function AuditPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const [before, setBefore] = useState<string | null>(null);

  const entries = useQuery({
    queryKey: [...keys.org(orgId), 'audit', before ?? 'latest'],
    queryFn: async () => wire(await api.tenancy.audit.list.query({ limit: 50, before })),
  });

  const verify = useMutation({
    mutationFn: () => api.tenancy.audit.verify.query(undefined),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 mx-auto w-full max-w-5xl px-8 pt-6 pb-4">
        <PageHeader
          title="Audit log"
          description="Append-only and hash-chained. Every state-changing action lands here."
          actions={
            <>
              <Link
                to="/settings"
                className="rounded-lg border border-line/50 px-2.5 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
              >
                Settings
              </Link>
              <Button
                variant="secondary"
                disabled={verify.isPending}
                onClick={() => {
                  verify.mutate();
                }}
              >
                {verify.isPending ? 'Verifying…' : 'Verify chain'}
              </Button>
            </>
          }
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          {verify.isError && (
            <ErrorView error={verify.error} title="Could not verify the chain" className="shrink-0" />
          )}

          {verify.data !== undefined && (
            <div
              className={cn(
                'rounded-xl border px-4 py-3 text-sm shadow-sm',
                verify.data.intact
                  ? 'border-success/40 bg-success/10 text-ink'
                  : 'border-danger/40 bg-danger/10 text-ink',
              )}
            >
              {verify.data.intact ? (
                <p>
                  Chain intact — {verify.data.verified}{' '}
                  {verify.data.verified === 1 ? 'entry' : 'entries'} recomputed and every digest
                  matched.
                </p>
              ) : (
                <>
                  <p className="font-medium">
                    Chain BROKEN across {verify.data.breaks.length}{' '}
                    {verify.data.breaks.length === 1 ? 'entry' : 'entries'}.
                  </p>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                    {verify.data.breaks.map((entry) => (
                      <li key={entry.id}>
                        seq {entry.seq}: {entry.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {entries.isPending && <Spinner />}
          {entries.isError && (
            <ErrorView error={entries.error} title="Could not load the audit log" />
          )}

          {entries.data !== undefined &&
            (entries.data.length === 0 ? (
              <Empty title="Nothing recorded yet" />
            ) : (
              <div className="overflow-hidden rounded-xl border border-line/50 bg-surface-raised shadow-sm">
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Seq</th>
                        <th>When</th>
                        <th>Action</th>
                        <th>Resource</th>
                        <th>Actor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.data.map((entry) => (
                        <tr key={entry.id}>
                          <td className="font-mono text-ink-faint">{entry.seq}</td>
                          <td className="whitespace-nowrap text-ink-muted">
                            {formatDateTime(entry.occurredAt)}
                          </td>
                          <td className="font-medium text-ink">{entry.action}</td>
                          <td className="text-ink-muted">
                            {entry.resourceType ?? '—'}
                            {entry.resourceId !== null && (
                              <span className="ml-1 font-mono text-[11px] text-ink-faint">
                                {entry.resourceId.slice(0, 8)}
                              </span>
                            )}
                          </td>
                          <td>
                            <ActorCell actorId={entry.actorId} actorEmail={entry.actorEmail} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Keyset pagination on `seq`, not an offset. The log only ever
                    grows, and an OFFSET page would shift under the reader as new
                    entries land — skipping rows silently, which is the one thing a
                    compliance record must not do. */}
                <div className="flex items-center gap-2 border-t border-line/40 px-4 py-3">
                  <Button
                    disabled={before === null}
                    onClick={() => {
                      setBefore(null);
                    }}
                  >
                    Newest
                  </Button>
                  <Button
                    disabled={entries.data.length < 50}
                    onClick={() => {
                      setBefore(entries.data[entries.data.length - 1]?.seq ?? null);
                    }}
                  >
                    Older
                  </Button>
                  <span className="ml-auto text-xs text-ink-faint">
                    Showing {entries.data.length} entries
                  </span>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Who did it.
 *
 * Three states, and collapsing any two of them loses something an investigator
 * needs:
 *
 *   - No actor at all — the SYSTEM acted. §8.6 treats this as a real value
 *     rather than a missing one, so it is labelled rather than left blank.
 *   - An actor with an address — the ordinary case.
 *   - An actor whose account no longer exists. The id is still the durable fact
 *     the entry was hashed over, so it is shown; what is missing is only the
 *     lookup. Rendering this identically to "system" would attribute a person's
 *     action to nobody.
 *
 * The id is kept alongside the address in the title rather than on screen: two
 * people can share a display name, and the id is what the entry actually
 * committed to.
 */
function ActorCell({
  actorId,
  actorEmail,
}: {
  readonly actorId: string | null;
  readonly actorEmail: string | null;
}) {
  if (actorId === null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-ink-faint">
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-surface-sunken text-[9px]"
        >
          SYS
        </span>
        <span className="text-[11px] italic">system</span>
      </span>
    );
  }

  if (actorEmail === null) {
    return (
      <span title={actorId} className="inline-flex items-center gap-1.5 text-ink-faint">
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-line text-[9px]"
        >
          ?
        </span>
        <span className="font-mono text-[10px]">{actorId.slice(0, 8)}</span>
        <span className="text-[10px] italic">deleted</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5" title={`${actorEmail} · ${actorId}`}>
      <Avatar userId={actorId} label={actorEmail} size="xs" />
      <span className="truncate text-[11px] text-ink-muted">{actorEmail}</span>
    </span>
  );
}
