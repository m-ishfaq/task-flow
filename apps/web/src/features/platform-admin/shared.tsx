import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { MoreHorizontal, Search, ShieldAlert, type LucideProps } from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { Badge, Button, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { featureDescription, featureLabel } from '../../lib/feature-labels.js';

/**
 * Shared primitives, formatters, and the two cross-tab dialogs for the
 * platform administration console. Split out of platform-admin-page.tsx
 * (mechanical extraction, no behavior changes) so each tab file only needs
 * to import what it uses instead of scrolling one 4,900-line file.
 */

/**
 * Stat card shown in the summary overview at the top of the page.
 * An icon, a label, and a value — the same metric-widget shape every
 * SaaS admin console uses for at-a-glance numbers.
 */
export function StatCard({
  icon: Icon,
  label,
  value,
  accent = false,
}: {
  readonly icon: React.ComponentType<LucideProps>;
  readonly label: string;
  readonly value: string | number;
  readonly accent?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border px-4 py-3',
        accent ? 'border-accent/30 bg-accent/5' : 'border-line bg-surface-raised',
      )}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          accent ? 'bg-accent/15 text-accent' : 'bg-surface-hover text-ink-muted',
        )}
      >
        <Icon aria-hidden="true" className="size-4.5" strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">{label}</p>
        <p className="truncate text-lg font-semibold tracking-tight text-ink">{value}</p>
      </div>
    </div>
  );
}

/**
 * A small search input with an icon, used above tables to filter rows
 * client-side. Not debounced — the filter is client-side against already-
 * loaded data, so every keystroke is instant.
 */
export function TableSearch({
  value,
  onChange,
  placeholder = 'Search…',
  className,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
        strokeWidth={2}
      />
      <input
        type="text"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder={placeholder}
        className="h-8 w-full rounded-lg border border-line bg-surface-sunken pl-8 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:ring-2 focus:ring-accent/25 focus:outline-none"
      />
    </div>
  );
}

/**
 * Improved pagination controls with count display.
 * Replaces the bare "Newest / Older" buttons with a more informative bar.
 */
export function Pagination({
  hasMore,
  onNewest,
  onOlder,
  countLabel,
}: {
  readonly hasMore: boolean;
  readonly onNewest: () => void;
  readonly onOlder: () => void;
  readonly countLabel?: string | undefined;
}) {
  return (
    <div className="flex items-center justify-between">
      {countLabel !== undefined && <p className="text-xs text-ink-faint">{countLabel}</p>}
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" disabled={!hasMore} onClick={onNewest}>
          ← Newest
        </Button>
        <Button size="sm" variant="ghost" disabled={!hasMore} onClick={onOlder}>
          Older →
        </Button>
      </div>
    </div>
  );
}

/**
 * Relative time string — "in 12 days", "3 days ago", etc.
 * Used to give renewal dates immediate context.
 */
export function relativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const absDiff = Math.abs(diffMs);
  const minutes = Math.round(absDiff / 60_000);
  const hours = Math.round(absDiff / 3_600_000);
  const days = Math.round(absDiff / 86_400_000);
  const future = diffMs > 0;

  if (minutes < 60) return future ? `in ${String(minutes)}m` : `${String(minutes)}m ago`;
  if (hours < 24) return future ? `in ${String(hours)}h` : `${String(hours)}h ago`;
  if (days < 30) return future ? `in ${String(days)}d` : `${String(days)}d ago`;
  const months = Math.round(days / 30);
  return future ? `in ${String(months)}mo` : `${String(months)}mo ago`;
}

/**
 * A tiny inline bar showing how many seats an org uses relative to a cap.
 * Gives immediate context to the member count number.
 */
export function MemberBar({ count, cap = 50 }: { readonly count: number; readonly cap?: number }) {
  const pct = Math.min((count / cap) * 100, 100);
  return (
    <div className="flex items-center gap-2">
      <span className="tabular-nums text-ink-muted">{count}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            pct > 80 ? 'bg-danger' : pct > 50 ? 'bg-warning' : 'bg-accent',
          )}
          style={{ width: `${String(pct)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Dropdown menu for destructive row actions (Delete). Keeps them visually
 * separated from safe actions (Plan, Suspend/Reactivate) so an operator
 * does not misclick a destructive action.
 */
export function RowActionsMenu({ children }: { readonly children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="More actions"
        onClick={() => {
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className="flex size-7 items-center justify-center rounded-lg border border-line text-ink-faint transition-colors hover:border-accent/30 hover:bg-surface-hover hover:text-ink"
      >
        <MoreHorizontal className="size-3.5" strokeWidth={2} />
      </button>
      {open && (
        <>
          <div
            role="presentation"
            className="fixed inset-0 z-20"
            onClick={() => {
              setOpen(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="absolute right-0 z-30 mt-1 min-w-[140px] rounded-xl border border-line bg-surface-raised p-1 shadow-lg">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A `role="tablist"` bar — the shell this console needed twice (the
 * top-level section switcher in platform-admin-page.tsx, and
 * `OperationsTab`'s kind filter) and had, until now, copied verbatim both
 * times, right down to the `bg-surface-raised text-ink shadow-sm`
 * active-state classes. Generic over the value type so a nullable "All"
 * filter and a plain non-null string union share one implementation instead
 * of one being a near-copy of the other with a `?? 'all'` key fallback
 * bolted on.
 */
export function TabBar<T extends string | null>({
  items,
  value,
  onChange,
  ariaLabel,
  size = 'sm',
  className,
}: {
  readonly items: readonly (readonly [T, string])[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly ariaLabel: string;
  readonly size?: 'sm' | 'xs';
  readonly className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex gap-0.5 rounded-xl border border-line bg-surface-sunken/80 p-1',
        className,
      )}
    >
      {items.map(([itemValue, label]) => (
        <button
          key={itemValue ?? 'null'}
          type="button"
          role="tab"
          aria-selected={value === itemValue}
          onClick={() => {
            onChange(itemValue);
          }}
          className={cn(
            'relative rounded-lg px-3 py-1.5 font-medium transition-all duration-150',
            size === 'sm' ? 'text-sm' : 'text-xs',
            value === itemValue
              ? 'bg-accent/10 text-accent shadow-sm ring-1 ring-accent/20'
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The read gate every tab renders when its query hits STEP_UP_REQUIRED.
 *
 * Separate from `useStepUp`'s mutation flow because a query cannot be replayed
 * as a thunk — the tab's content only exists once the data does.
 */
export function StepUpGate({ onStepUp }: { readonly onStepUp: () => void }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-warning/30 bg-warning/5 p-5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
        <ShieldAlert className="size-5" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">Re-authentication required</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          This console re-checks your password every five minutes from the last time you entered it
          — not from when you opened this page.
        </p>
      </div>
      <Button variant="primary" onClick={onStepUp}>
        Re-authenticate
      </Button>
    </div>
  );
}

/** Cents to a display string. Integer arithmetic only — see §3.8. */
export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** `null` is unlimited, `0` is none-at-all, and they must not read alike. */
export function ceiling(value: number | null, unit: string): string {
  if (value === null) return 'unlimited';
  if (value === 0) return `no ${unit}`;
  return `${String(value)} ${unit}`;
}

/**
 * Trigger a browser download of a CSV file.
 * No library needed — a Blob with the right MIME type and a temporary
 * anchor click is the standard approach.
 */
export function downloadCsv(filename: string, rows: readonly (readonly string[])[]): void {
  const quote = (cell: string): string => {
    if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
      return '"' + cell.replaceAll('"', '""') + '"';
    }
    return cell;
  };
  const csvContent = rows.map((row) => row.map(quote).join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function DetailRow({
  label,
  value,
  mono,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
}) {
  return (
    <>
      <dt className="text-ink-faint">{label}</dt>
      <dd className={cn('truncate text-ink', mono === true && 'font-mono text-[11px]')}>{value}</dd>
    </>
  );
}

/**
 * An organization's full detail panel — billing, entitlements, members,
 * invoices, operator history. Shared between OrgsTab and BillingTab, both of
 * which open it from a row action.
 */
export function OrgDetailDialog({
  orgId,
  onClose,
}: {
  readonly orgId: string;
  readonly onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: keys.platformOrgDetail(orgId),
    queryFn: async () => wire(await api.platformAdmin.orgs.detail.query({ orgId })),
  });

  const history = useQuery({
    queryKey: keys.platformOrgHistory(orgId),
    queryFn: async () => wire(await api.platformAdmin.orgs.history.query({ orgId, limit: 15 })),
  });

  const data = detail.data;

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent size="lg" className="max-h-[85vh] overflow-y-auto p-5">
        <ModalTitle>{data?.name ?? 'Organization'}</ModalTitle>
        <ModalDescription>
          {data === undefined ? 'Loading…' : `${data.slug} · created ${formatDate(data.createdAt)}`}
        </ModalDescription>

        {detail.isPending && <SkeletonRows rows={6} className="mt-4 *:h-10" />}
        {detail.isError && (
          <ErrorView error={detail.error} title="Could not load this organization" />
        )}

        {data !== undefined && (
          <div className="mt-4 flex flex-col gap-5">
            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">Billing</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <DetailRow label="Plan" value={data.planName ?? data.planId ?? 'none'} />
                <DetailRow label="Billing status" value={data.billingStatus} />
                <DetailRow label="Operator status" value={data.status} />
                <DetailRow
                  label="Trial ends"
                  value={data.trialEndsAt === null ? '—' : formatDate(data.trialEndsAt)}
                />
                <DetailRow
                  label="Grace ends"
                  value={
                    data.billingGraceEndsAt === null ? '—' : formatDate(data.billingGraceEndsAt)
                  }
                />
                <DetailRow
                  label="Telephony spend (30d)"
                  value={
                    /* COALESCE(actual, estimated) — the same number the spend
                       gate enforces against, never SUM(actual), which would
                       read lower than reality while calls are in flight. */
                    `${money(data.telephonySpendCents, 'usd')}${
                      data.limits.telephonyCapCents === null
                        ? ' of unlimited'
                        : ` of ${money(data.limits.telephonyCapCents, 'usd')}`
                    }`
                  }
                />
                <DetailRow label="Stripe customer" value={data.stripeCustomerId ?? '—'} mono />
                <DetailRow
                  label="Stripe subscription"
                  value={data.stripeSubscriptionId ?? '—'}
                  mono
                />
              </dl>
            </section>

            {data.override !== null && (
              <section className="rounded-lg border border-warning/40 bg-warning/5 p-2">
                <h3 className="mb-1 text-[13px] font-semibold text-ink">
                  Operator override — outranks the plan
                </h3>
                <p className="mt-0.5 text-xs text-ink-muted">{data.override.reason}</p>
                <p className="mt-0.5 text-[11px] text-ink-faint">
                  set {formatDate(data.override.setAt)}
                  {data.override.expiresAt === null
                    ? ' · no expiry'
                    : ` · expires ${formatDate(data.override.expiresAt)}`}
                  {data.override.featuresAdd.length > 0 &&
                    ` · adds ${data.override.featuresAdd.join(', ')}`}
                  {data.override.featuresRemove.length > 0 &&
                    ` · removes ${data.override.featuresRemove.join(', ')}`}
                </p>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">Entitlements</h3>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {data.features.map((feature) => (
                  <li
                    key={feature.flagName}
                    className="flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-surface-hover/30"
                  >
                    <span className={feature.enabled ? 'text-success' : 'text-ink-faint'}>
                      {feature.enabled ? '✓' : '✗'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink">{featureLabel(feature.flagName)}</span>
                      <span className="block text-[11px] text-ink-faint">
                        {featureDescription(feature.flagName) ?? feature.description}
                      </span>
                    </span>
                    {/* WHERE the answer came from — see this component's own
                        header on why an override is only tolerable with it. */}
                    <span className="shrink-0 text-[11px] text-ink-faint">
                      {feature.source === 'default' ? 'registry default' : `from ${feature.source}`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">
                Members ({data.memberCount} active of {data.members.length})
              </h3>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {data.members.map((member) => (
                  <li
                    key={member.userId}
                    className="flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-surface-hover/30"
                  >
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {member.name ?? member.email}
                      {member.name !== null && (
                        <span className="ml-1 text-[11px] text-ink-faint">{member.email}</span>
                      )}
                    </span>
                    <Badge>{member.role}</Badge>
                    {member.status !== 'active' && (
                      <span className="text-[11px] text-ink-faint">{member.status}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {/* Rendered only when there is something to show — a "no invoices"
                panel on every trialing org is noise about a normal state. */}
            {data.invoices.length > 0 && (
              <section>
                {' '}
                <h3 className="mb-2 text-[13px] font-semibold text-ink">Invoices</h3>
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {data.invoices.map((invoice) => (
                    <li
                      key={invoice.providerInvoiceId}
                      className="flex items-center gap-2 px-3 py-2 text-xs transition-colors hover:bg-surface-hover/30"
                    >
                      <span className="w-20 shrink-0 text-ink-muted">
                        {formatDate(invoice.issuedAt)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink">
                        {invoice.number ?? invoice.providerInvoiceId}
                      </span>
                      <Badge>{invoice.status}</Badge>
                      <span className="w-16 shrink-0 text-right text-ink">
                        {money(invoice.amountDueCents, invoice.currency)}
                      </span>
                      {invoice.hostedInvoiceUrl !== null && (
                        <a
                          href={invoice.hostedInvoiceUrl}
                          target="_blank"
                          /* noreferrer alongside noopener: the target is the
                             processor's own page, and the referrer would leak
                             this deployment's admin path to it. */
                          rel="noopener noreferrer"
                          className="shrink-0 text-accent underline decoration-dotted"
                        >
                          View
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">Operator history</h3>
              {history.isPending && <SkeletonRows rows={3} className="mt-1 *:h-6" />}
              {history.data !== undefined &&
                (history.data.length === 0 ? (
                  <p className="mt-1 text-xs text-ink-faint">
                    No operator has acted on this organization.
                  </p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-ink-muted">
                    {history.data.map((entry, index) => (
                      <li key={`${entry.action}-${String(index)}`}>
                        {formatDateTime(entry.at)} · {entry.action} · {entry.by}
                      </li>
                    ))}
                  </ul>
                ))}
            </section>

            <div className="flex justify-end">
              <Button onClick={onClose}>Close</Button>
            </div>
          </div>
        )}
      </ModalContent>
    </ModalRoot>
  );
}
