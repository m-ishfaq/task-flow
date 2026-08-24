import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { PALETTE_IDS, type OrgId, type PaletteId } from '@taskflow/contracts';
import {
  Building2,
  CreditCard,
  Flag,
  LayoutGrid,
  Palette,
  Search,
  Shield,
  ShieldAlert,
  Users,
  Zap,
  MoreHorizontal,
  type LucideProps,
} from 'lucide-react';
import { TaskFlowLogo } from '../../components/taskflow-logo.js';
import { api, errorCodeOf } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { paletteColorsOf } from '../../lib/branding-palettes.js';
import {
  Badge,
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  PageHeader,
  SkeletonRows,
  Spinner,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { LIMIT_COPY, featureDescription, featureLabel } from '../../lib/feature-labels.js';
import { useStepUp } from '../auth/use-step-up.js';
import { StepUpDialog } from '../auth/step-up.js';

/**
 * Stat card shown in the summary overview at the top of the page.
 * An icon, a label, and a value — the same metric-widget shape every
 * SaaS admin console uses for at-a-glance numbers.
 */
function StatCard({
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
function TableSearch({
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
function Pagination({
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
 * The platform administration console (Phase 12 Wave 1, ai/phase-12-admin.md).
 *
 * Relative time string — "in 12 days", "3 days ago", etc.
 * Used to give renewal dates immediate context.
 */
function relativeTime(date: Date): string {
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
function MemberBar({ count, cap = 50 }: { readonly count: number; readonly cap?: number }) {
  const pct = Math.min((count / cap) * 100, 100);
  return (
    <div className="flex items-center gap-2">
      <span className="tabular-nums text-ink-muted">{count}</span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-hover">
        <div
          className={cn('h-full rounded-full transition-all', pct > 80 ? 'bg-danger' : pct > 50 ? 'bg-warning' : 'bg-accent')}
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
function RowActionsMenu({
  children,
}: {
  readonly children: React.ReactNode;
}) {
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
 * ## What this page is
 *
 * The ONE place in the app that is relative to no organization. Every query and
 * mutation behind it is `platformRoute` — authenticated, checked against the
 * `platform.operators` flag, and (unconditionally) step-up. It is reachable
 * with no org selected, which is why the route guard is `requireSession` and
 * why its query keys are deliberately not org-prefixed.
 *
 * ## Step-up, and why even the READS prompt for it
 *
 * `platformRoute` bakes `stepUp: true` into every call, reads included — a
 * cross-tenant read is as sensitive as a cross-tenant write, and the operator
 * tier is exactly what a stolen session is for. So a session older than the
 * five-minute proof window answers STEP_UP_REQUIRED on the first data query.
 * Mutations use the standard `useStepUp` guard/retry pair; a QUERY has no
 * thunk to replay, so each tab renders a "re-authenticate" gate instead, and
 * confirming invalidates every platform key so the queries refetch under the
 * fresh credential.
 *
 * ## A non-operator landing here
 *
 * There is no `isOperator` check on the page. The account menu hides the link
 * from everyone the server answers "no" to, and a non-operator who types the
 * URL anyway gets the honest thing: every query answers FORBIDDEN and the tab
 * renders `ErrorView`. The UI never re-derives authorization (§8.2) — the
 * server's answer is the access-denied screen.
 */
/**
 * A `role="tablist"` bar — the shell this console needed twice (the
 * top-level section switcher below, and `OperationsTab`'s kind filter
 * further down) and had, until now, copied verbatim both times, right down
 * to the `bg-surface-raised text-ink shadow-sm` active-state classes.
 * Generic over the value type so a nullable "All" filter and a plain
 * non-null string union share one implementation instead of one being a
 * near-copy of the other with a `?? 'all'` key fallback bolted on.
 */
function TabBar<T extends string | null>({
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

export function PlatformAdminPage() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [gateOpen, setGateOpen] = useState(false);
  const [tab, setTab] = useState<
    'orgs' | 'users' | 'plans' | 'billing' | 'flags' | 'branding' | 'audit' | 'operations'
  >('orgs');

  /* The query-side step-up gate (see the header comment). Confirming runs the
     same login the mutation dialog runs; invalidating every `['platform']` key
     makes the active tab's query refetch under the fresh authenticatedAt. */
  const onProof = () => {
    setGateOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['platform'] });
  };

  /* Summary stats — computed from the first page of each list. The queries
     are keyed without pagination cursors, so they return the default first
     page and are deduped with the tabs' own queries when those mount. */
  const orgs = useQuery({
    queryKey: keys.platformOrgs(null),
    queryFn: async () =>
      wire(await api.platformAdmin.orgs.list.query({ cursor: null, limit: 100 })),
  });
  const users = useQuery({
    queryKey: keys.platformUsers(null),
    queryFn: async () =>
      wire(await api.platformAdmin.users.list.query({ cursor: null, limit: 100 })),
  });
  const billing = useQuery({
    queryKey: keys.platformBilling(null),
    queryFn: async () =>
      wire(await api.platformAdmin.billing.list.query({ cursor: null, limit: 100 })),
  });

  const orgData = orgs.data;
  const totalOrgs = orgData?.orgs.length ?? 0;
  const activeOrgs = orgData?.orgs.filter((o) => o.status === 'active').length ?? 0;
  const totalMembers = orgData?.orgs.reduce((sum, o) => sum + o.memberCount, 0) ?? 0;
  const totalUsers = users.data?.users.length ?? 0;
  const mrr =
    billing.data?.orgs.reduce((sum, o) => {
      if (o.currentPriceCents !== null && o.billingStatus === 'active') {
        return sum + o.currentPriceCents;
      }
      return sum;
    }, 0) ?? 0;
  const trials = billing.data?.orgs.filter((o) => o.billingStatus === 'trialing').length ?? 0;

  const hasExportData =
    (orgs.data?.orgs.length ?? 0) > 0 ||
    (users.data?.users.length ?? 0) > 0 ||
    (billing.data?.orgs.length ?? 0) > 0;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-8">
      <PageHeader
        title="Platform administration"
        description="Every organization, user, and release flag. There is no organization selected here on purpose — this console spans them all."
        actions={
          hasExportData ? (
            <Button
              variant="secondary"
              onClick={() => {
                const date = new Date().toISOString().slice(0, 10);
                const orgRows = orgs.data?.orgs;
                const userRows = users.data?.users;
                const billingRows = billing.data?.orgs;

                if (orgRows !== undefined && orgRows.length > 0) {
                  downloadCsv(`orgs-export-${date}.csv`, [
                    [
                      'Organization',
                      'Slug',
                      'Owner name',
                      'Owner email',
                      'Plan',
                      'Billing status',
                      'Trial ends',
                      'Grace ends',
                      'Renews',
                      'Last invoice status',
                      'Last invoice amount',
                      'Last invoice date',
                      'Status',
                      'Members',
                      'Created',
                    ],
                    ...orgRows.map((org) => [
                      org.name,
                      org.slug,
                      org.ownerName ?? '',
                      org.ownerEmail ?? '',
                      org.planId ?? '',
                      org.billingStatus,
                      org.trialEndsAt !== null ? formatDate(org.trialEndsAt) : '',
                      org.billingGraceEndsAt !== null ? formatDate(org.billingGraceEndsAt) : '',
                      org.currentPeriodEnd !== null ? formatDate(org.currentPeriodEnd) : '',
                      org.lastInvoice?.status ?? '',
                      org.lastInvoice !== null
                        ? money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)
                        : '',
                      org.lastInvoice !== null ? formatDate(org.lastInvoice.issuedAt) : '',
                      org.status,
                      String(org.memberCount),
                      formatDate(org.createdAt),
                    ]),
                  ]);
                }

                if (userRows !== undefined && userRows.length > 0) {
                  downloadCsv(`users-export-${date}.csv`, [
                    ['User id', 'Name', 'Email', 'Email verified', 'Organizations', 'Created'],
                    ...userRows.map((user) => [
                      user.userId,
                      user.name ?? '',
                      user.email,
                      user.emailVerifiedAt !== null ? formatDate(user.emailVerifiedAt) : 'no',
                      String(user.orgCount),
                      formatDate(user.createdAt),
                    ]),
                  ]);
                }

                if (billingRows !== undefined && billingRows.length > 0) {
                  downloadCsv(`billing-export-${date}.csv`, [
                    [
                      'Organization',
                      'Slug',
                      'Billing status',
                      'Plan',
                      'Plan name',
                      'Current price',
                      'Interval',
                      'Renews',
                      'Last invoice status',
                      'Last invoice amount',
                      'Last invoice date',
                      'Trial ends',
                      'Grace ends',
                      'Pending plan',
                      'Stripe customer',
                    ],
                    ...billingRows.map((org) => [
                      org.name,
                      org.slug,
                      org.billingStatus,
                      org.planId ?? '',
                      org.planName ?? '',
                      org.currentPriceCents !== null ? money(org.currentPriceCents, 'usd') : '',
                      org.currentPriceInterval ?? '',
                      org.currentPeriodEnd !== null ? formatDate(org.currentPeriodEnd) : '',
                      org.lastInvoice?.status ?? '',
                      org.lastInvoice !== null
                        ? money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)
                        : '',
                      org.lastInvoice !== null ? formatDate(org.lastInvoice.issuedAt) : '',
                      org.trialEndsAt !== null ? formatDate(org.trialEndsAt) : '',
                      org.billingGraceEndsAt !== null ? formatDate(org.billingGraceEndsAt) : '',
                      org.pendingPlanId ?? '',
                      org.stripeCustomerId ?? '',
                    ]),
                  ]);
                }
              }}
            >
              Export all CSVs
            </Button>
          ) : undefined
        }
      />

      {/* Summary stat cards — the at-a-glance dashboard every admin console leads with. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard icon={Building2} label="Orgs" value={totalOrgs} accent={tab === 'orgs'} />
        <StatCard icon={Users} label="Users" value={totalUsers} accent={tab === 'users'} />
        <StatCard icon={Building2} label="Active" value={activeOrgs} />
        <StatCard icon={Users} label="Members" value={totalMembers} />
        <StatCard
          icon={CreditCard}
          label="MRR"
          value={`$${String(mrr / 100)}`}
          accent={tab === 'billing'}
        />
        <StatCard icon={Zap} label="Trials" value={trials} />
      </div>

      {/* Tabs, not routes: the console is one surface with four views, and a
          child route per tab would mount a fresh component tree on every
          switch for no benefit — the queries are already keyed per page. */}
      <div
        role="tablist"
        aria-label="Platform administration sections"
        className="sticky top-0 z-10 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface-sunken/80 p-1 shadow-sm"
      >
        {(
          [
            ['orgs', 'Organizations', Building2],
            ['users', 'Users', Users],
            ['plans', 'Plans', LayoutGrid],
            ['billing', 'Billing', CreditCard],
            ['flags', 'Feature flags', Flag],
            ['branding', 'Branding', Palette],
            ['audit', 'Operator audit', Shield],
            ['operations', 'Operations', Zap],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => {
              setTab(value);
            }}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-150',
              tab === value
                ? 'bg-accent/10 text-accent shadow-sm ring-1 ring-accent/20'
                : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            <Icon aria-hidden="true" className="size-4" strokeWidth={2} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'orgs' && (
        <OrgsTab
          guard={guard}
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'users' && (
        <UsersTab
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'plans' && (
        <PlansTab
          guard={guard}
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'billing' && (
        <BillingTab
          guard={guard}
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'flags' && (
        <FlagsTab
          guard={guard}
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'branding' && (
        <BrandingTab
          guard={guard}
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'audit' && (
        <AuditTab
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}
      {tab === 'operations' && (
        <OperationsTab
          onStepUp={() => {
            setGateOpen(true);
          }}
        />
      )}

      {/* The mutation dialog (useStepUp) and the query gate dialog. Only one is
          ever open — the other renders nothing when closed. */}
      {dialog}
      {gateOpen && (
        <StepUpDialog
          open
          onClose={() => {
            setGateOpen(false);
          }}
          onConfirmed={onProof}
        />
      )}
    </div>
  );
}

/**
 * The read gate every tab renders when its query hits STEP_UP_REQUIRED.
 *
 * Separate from `useStepUp`'s mutation flow because a query cannot be replayed
 * as a thunk — the tab's content only exists once the data does.
 */
function StepUpGate({ onStepUp }: { readonly onStepUp: () => void }) {
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

/* -------------------------------------------------------------------------- *
 * Organizations
 * -------------------------------------------------------------------------- */

function OrgsTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const orgs = useQuery({
    queryKey: keys.platformOrgs(cursor),
    queryFn: async () => wire(await api.platformAdmin.orgs.list.query({ cursor, limit: 25 })),
  });

  const suspend = useMutation({
    mutationFn: (orgId: OrgId) => api.platformAdmin.orgs.suspend.mutate({ orgId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'orgs'] });
    },
    onError: (error, orgId) => {
      guard(error, () => {
        suspend.mutate(orgId);
      });
    },
  });

  const reactivate = useMutation({
    mutationFn: (orgId: OrgId) => api.platformAdmin.orgs.reactivate.mutate({ orgId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['platform', 'orgs'] });
    },
    onError: (error, orgId) => {
      guard(error, () => {
        reactivate.mutate(orgId);
      });
    },
  });

  /* §3.5 (Phase 12 Wave 2) — org deletion, the one action with no undo. The
     row's Delete button only opens the modal for a SUSPENDED org (the server
     enforces the gate too); the modal's confirm button stays disabled until
     the operator types the org's exact slug, and the server re-checks both. */
  const [deleteTarget, setDeleteTarget] = useState<{
    orgId: string;
    name: string;
    slug: string;
  } | null>(null);
  const [confirmSlug, setConfirmSlug] = useState('');

  /* Moving an org between plans. Its own dialog rather than an inline select,
     because the route requires a REASON — moving a tenant off what they signed
     up for is a support decision, and a decision with no recorded reason is one
     nobody can review later. */
  const [planTarget, setPlanTarget] = useState<{
    orgId: string;
    name: string;
    planId: string | null;
  } | null>(null);

  /** The drill-down panel's subject, or null when it is closed. */
  const [detailOrgId, setDetailOrgId] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: (input: { orgId: OrgId; confirmSlug: string }) =>
      api.platformAdmin.orgs.delete.mutate(input),
    onSuccess: async () => {
      setDeleteTarget(null);
      setConfirmSlug('');
      await queryClient.invalidateQueries({ queryKey: ['platform', 'orgs'] });
    },
    onError: (error, input) => {
      guard(error, () => {
        remove.mutate(input);
      });
    },
  });

  if (errorCodeOf(orgs.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredOrgs = orgs.data?.orgs.filter((org) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      org.name.toLowerCase().includes(q) ||
      org.slug.toLowerCase().includes(q) ||
      org.ownerEmail?.toLowerCase().includes(q) === true ||
      org.ownerName?.toLowerCase().includes(q) === true
    );
  });

  return (
    <section aria-label="Organizations">
      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter orgs by name, slug, or owner…"
        />
        {orgs.data !== undefined && orgs.data.orgs.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const header = [
                'Organization',
                'Slug',
                'Owner name',
                'Owner email',
                'Plan',
                'Billing status',
                'Trial ends',
                'Grace ends',
                'Renews',
                'Last invoice status',
                'Last invoice amount',
                'Last invoice date',
                'Status',
                'Members',
                'Created',
              ];
              const rows = [
                header,
                ...orgs.data.orgs.map((org) => [
                  org.name,
                  org.slug,
                  org.ownerName ?? '',
                  org.ownerEmail ?? '',
                  org.planId ?? '',
                  org.billingStatus,
                  org.trialEndsAt !== null ? formatDate(org.trialEndsAt) : '',
                  org.billingGraceEndsAt !== null ? formatDate(org.billingGraceEndsAt) : '',
                  org.currentPeriodEnd !== null ? formatDate(org.currentPeriodEnd) : '',
                  org.lastInvoice?.status ?? '',
                  org.lastInvoice !== null
                    ? money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)
                    : '',
                  org.lastInvoice !== null ? formatDate(org.lastInvoice.issuedAt) : '',
                  org.status,
                  String(org.memberCount),
                  formatDate(org.createdAt),
                ]),
              ];
              downloadCsv(`orgs-export-${new Date().toISOString().slice(0, 10)}.csv`, rows);
            }}
          >
            Export CSV
          </Button>
        )}
      </div>

      {orgs.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {orgs.isError && <ErrorView error={orgs.error} title="Could not load organizations" />}

      {orgs.data !== undefined && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Organization
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Owner
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Plan
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Renews
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Last invoice
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Status
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Members
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Created
                </th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {(filteredOrgs ?? []).map((org) => (
                <tr
                  key={org.orgId}
                  className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                  onClick={() => {
                    setDetailOrgId(org.orgId);
                  }}
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-ink transition-colors group-hover:text-accent">{org.name}</p>
                    <p className="font-mono text-[11px] text-ink-faint">{org.slug}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    {org.ownerEmail === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <>
                        {org.ownerName !== null && <p className="text-ink">{org.ownerName}</p>}
                        <p className="text-[11px] text-ink-muted">{org.ownerEmail}</p>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="text-ink">
                      {org.planId ?? <span className="text-ink-faint">no plan</span>}
                    </p>
                    <p className="text-[11px] text-ink-faint">
                      {org.billingStatus}
                      {org.billingStatus === 'trialing' &&
                        org.trialEndsAt !== null &&
                        ` — ends ${formatDate(org.trialEndsAt)}`}
                      {org.billingStatus === 'past_due' &&
                        org.billingGraceEndsAt !== null &&
                        ` — grace ends ${formatDate(org.billingGraceEndsAt)}`}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {org.currentPeriodEnd === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <span>
                        {formatDate(org.currentPeriodEnd)}
                        <span className="ml-1.5 text-[10px] text-ink-faint">
                          {relativeTime(new Date(org.currentPeriodEnd))}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {org.lastInvoice === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <>
                        <p
                          className={
                            org.lastInvoice.status === 'paid' ? 'text-success' : 'text-danger'
                          }
                        >
                          {org.lastInvoice.status}{' '}
                          {money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)}
                        </p>
                        <p className="text-[11px] text-ink-faint">
                          {formatDate(org.lastInvoice.issuedAt)}
                        </p>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={org.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <MemberBar count={org.memberCount} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {formatDate(org.createdAt)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => {
                          setPlanTarget({
                            orgId: org.orgId,
                            name: org.name,
                            planId: org.planId,
                          });
                        }}
                      >
                        Plan
                      </Button>
                      {org.status === 'suspended' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={reactivate.isPending}
                          onClick={() => {
                            reactivate.mutate(org.orgId as OrgId);
                          }}
                        >
                          Reactivate
                        </Button>
                      ) : (
                        <ConfirmButton
                          size="sm"
                          label="Suspend"
                          confirmLabel={`Suspend ${org.name}?`}
                          disabled={suspend.isPending}
                          onConfirm={() => {
                            suspend.mutate(org.orgId as OrgId);
                          }}
                        />
                      )}
                      {org.status === 'suspended' && (
                        <RowActionsMenu>
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-danger transition-colors hover:bg-danger/10"
                            disabled={remove.isPending}
                            onClick={() => {
                              setConfirmSlug('');
                              setDeleteTarget({ orgId: org.orgId, name: org.name, slug: org.slug });
                            }}
                          >
                            <ShieldAlert className="size-3" strokeWidth={2.5} />
                            Delete org
                          </button>
                        </RowActionsMenu>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {(filteredOrgs ?? []).length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-12 text-center">
                    {search.trim() !== '' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm text-ink-faint">No organizations match your search.</p>
                        <p className="text-xs text-ink-faint">Try a different name, slug, or owner email.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Building2 className="size-8 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm font-medium text-ink">No organizations yet</p>
                        <p className="max-w-xs text-xs text-ink-faint">
                          Organizations are created when users sign up. Once the first user joins, their org will appear here.
                        </p>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(suspend.isError || reactivate.isError || remove.isError) && (
        <ErrorView
          error={suspend.error ?? reactivate.error ?? remove.error}
          title="Could not change the status"
        />
      )}

      {detailOrgId !== null && (
        <OrgDetailDialog
          orgId={detailOrgId}
          onClose={() => {
            setDetailOrgId(null);
          }}
        />
      )}

      {planTarget !== null && (
        <ChangeOrgPlanDialog
          guard={guard}
          org={planTarget}
          onClose={() => {
            setPlanTarget(null);
          }}
          onChanged={() => {
            setPlanTarget(null);
            void queryClient.invalidateQueries({ queryKey: ['platform'] });
          }}
        />
      )}

      {/* §3.5's type-the-slug confirmation — a single confirm-button click is
          too cheap an action to gate the one operation in this system with no
          undo. The button is disabled until the typed slug matches exactly;
          the server re-checks the slug AND the suspended status. */}
      {deleteTarget !== null && (
        <ModalRoot
          open
          onOpenChange={(next) => {
            if (!next) setDeleteTarget(null);
          }}
        >
          <ModalContent size="sm" className="p-4">
            <ModalTitle>Delete {deleteTarget.name}?</ModalTitle>
            <ModalDescription>
              This permanently deletes the organization and everything it owns — projects, channels,
              documents, memberships, and its audit history. There is no undo. Type{' '}
              <code className="rounded bg-surface-sunken px-1 font-mono text-[11px]">
                {deleteTarget.slug}
              </code>{' '}
              to confirm.
            </ModalDescription>

            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (confirmSlug === deleteTarget.slug) {
                  remove.mutate({
                    orgId: deleteTarget.orgId as OrgId,
                    confirmSlug,
                  });
                }
              }}
            >
              <Field label="Type the organization slug" htmlFor="delete-org-slug">
                <Input
                  id="delete-org-slug"
                  value={confirmSlug}
                  autoComplete="off"
                  placeholder={deleteTarget.slug}
                  onChange={(event) => {
                    setConfirmSlug(event.target.value);
                  }}
                />
              </Field>

              {remove.isError && <ErrorView error={remove.error} />}

              <div className="flex gap-2">
                <Button
                  type="submit"
                  variant="danger"
                  disabled={remove.isPending || confirmSlug !== deleteTarget.slug}
                >
                  {remove.isPending ? 'Deleting…' : 'Delete forever'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDeleteTarget(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </ModalContent>
        </ModalRoot>
      )}

      {/* Keyset pagination on created_at — a directory read while orgs are
          being created must not shift under the reader. */}
      <div className="mt-3">
        <Pagination
          hasMore={cursor !== null || (orgs.data?.nextCursor ?? null) !== null}
          onNewest={() => {
            setCursor(null);
          }}
          onOlder={() => {
            setCursor(orgs.data?.nextCursor ?? null);
          }}
          {...(filteredOrgs !== undefined
            ? {
                countLabel: `${String(filteredOrgs.length)} organization${filteredOrgs.length === 1 ? '' : 's'}`,
              }
            : {})}
        />
      </div>
    </section>
  );
}

/** The one column in the org directory that has meaning beyond itself. */
function StatusBadge({ status }: { readonly status: string }) {
  if (status === 'suspended') {
    return (
      <span className="inline-flex min-w-[88px] items-center justify-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        <ShieldAlert className="size-3" strokeWidth={2.5} />
        suspended
      </span>
    );
  }
  if (status === 'deleted') {
    return (
      <span className="inline-flex min-w-[88px] items-center justify-center gap-1 rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-faint">
        deleted
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-[88px] items-center justify-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
      <span className="size-1.5 rounded-full bg-success" />
      active
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Users
 * -------------------------------------------------------------------------- */

function UsersTab({ onStepUp }: { readonly onStepUp: () => void }) {
  /** The drill-down panel's subject, or null when closed. */
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const users = useQuery({
    queryKey: keys.platformUsers(cursor),
    queryFn: async () => wire(await api.platformAdmin.users.list.query({ cursor, limit: 25 })),
  });

  if (errorCodeOf(users.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredUsers = users.data?.users.filter((user) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return user.email.toLowerCase().includes(q) || user.name?.toLowerCase().includes(q) === true;
  });

  return (
    <section aria-label="Users">
      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter users by name or email…"
        />
        {users.data !== undefined && users.data.users.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const header = [
                'User id',
                'Name',
                'Email',
                'Email verified',
                'Organizations',
                'Created',
              ];
              const rows = [
                header,
                ...users.data.users.map((user) => [
                  user.userId,
                  user.name ?? '',
                  user.email,
                  user.emailVerifiedAt !== null ? formatDate(user.emailVerifiedAt) : 'no',
                  String(user.orgCount),
                  formatDate(user.createdAt),
                ]),
              ];
              downloadCsv(`users-export-${new Date().toISOString().slice(0, 10)}.csv`, rows);
            }}
          >
            Export CSV
          </Button>
        )}
      </div>

      {users.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {users.isError && <ErrorView error={users.error} title="Could not load users" />}

      {users.data !== undefined && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  User
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Email verified
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Orgs
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/50">
              {(filteredUsers ?? []).map((user) => (
                <tr
                  key={user.userId}
                  className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                  onClick={() => {
                    setDetailUserId(user.userId);
                  }}
                >
                  <td className="px-3 py-2.5">
                    <p className="max-w-full truncate font-medium text-ink transition-colors group-hover:text-accent">{user.name ?? user.email}</p>
                    {user.name !== null && <p className="truncate text-ink-muted">{user.email}</p>}
                    <p className="font-mono text-[11px] text-ink-faint">
                      {user.userId.slice(0, 8)}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">
                    {user.emailVerifiedAt === null ? (
                      <span className="text-ink-faint">no</span>
                    ) : (
                      <span className="text-success">{formatDate(user.emailVerifiedAt)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-ink-muted">{user.orgCount}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {formatDate(user.createdAt)}
                  </td>
                </tr>
              ))}
              {(filteredUsers ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-12 text-center">
                    {search.trim() !== '' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm text-ink-faint">No users match your search.</p>
                        <p className="text-xs text-ink-faint">Try a different name or email.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Users className="size-8 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm font-medium text-ink">No users yet</p>
                        <p className="max-w-xs text-xs text-ink-faint">
                          Users appear here once they create an account and verify their email.
                        </p>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3">
        <Pagination
          hasMore={cursor !== null || (users.data?.nextCursor ?? null) !== null}
          onNewest={() => {
            setCursor(null);
          }}
          onOlder={() => {
            setCursor(users.data?.nextCursor ?? null);
          }}
          {...(filteredUsers !== undefined
            ? { countLabel: `${String(filteredUsers.length)} users` }
            : {})}
        />
      </div>

      {detailUserId !== null && (
        <UserDetailDialog
          userId={detailUserId}
          onClose={() => {
            setDetailUserId(null);
          }}
        />
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Feature flags
 * -------------------------------------------------------------------------- */

function FlagsTab({
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
                        'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200',
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

/* -------------------------------------------------------------------------- *
 * Branding
 * -------------------------------------------------------------------------- */

/**
 * Platform-wide branding (migration 0073) — product name, an accent palette
 * chosen from a curated set (never a free color picker; see
 * `apps/api/src/platform-admin/branding.service.ts`'s own header on why),
 * and a logo/favicon upload.
 *
 * The logo/favicon flow is the same three steps `AttachmentSection` uses —
 * presign, PUT directly to storage, confirm — and the same rule applies:
 * never treat a successful PUT as done. The verdict comes from `confirm`,
 * which is also the only place the row actually changes; a rejected or
 * infected upload leaves whatever was there before untouched.
 */

/**
 * Only the fields this hook actually reads — `expiresAt` is deliberately
 * absent rather than typed `Date`, which is what the tRPC client infers
 * from the route's `z.date()` output but not what actually arrives (see
 * `apps/web/src/lib/wire.ts`); this hook never calls `wire()` on the
 * mutation result, so declaring a field it does not use avoids that trap
 * entirely rather than getting it wrong.
 */
interface PresignedAsset {
  readonly storageKey: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

interface ConfirmedAsset {
  readonly status: 'clean' | 'infected' | 'rejected';
  readonly reason?: string;
}

/**
 * The presign → PUT → confirm flow, shared by the logo and favicon uploads
 * below — they differ only in which two routes they call. One copy, not
 * two, for the same reason `branding.service.ts`'s `presignAsset`/
 * `confirmAsset` are shared server-side: a future fix (a retry, a progress
 * percentage) applied to one copy and not the other is a silent drift.
 */
function useAssetUpload({
  presign,
  confirm,
  guard,
  setProgress,
  inputRef,
  onSettled,
}: {
  readonly presign: (input: { contentType: string; sizeBytes: number }) => Promise<PresignedAsset>;
  readonly confirm: (input: { storageKey: string }) => Promise<ConfirmedAsset>;
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly setProgress: (value: string | null) => void;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly onSettled: () => void | Promise<void>;
}) {
  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress('Requesting an upload URL…');
      const presigned = await presign({ contentType: file.type, sizeBytes: file.size });

      setProgress('Uploading…');
      const response = await fetch(presigned.url, {
        method: 'PUT',
        headers: presigned.headers,
        body: file,
      });
      if (!response.ok) {
        throw new Error(`Storage refused the upload (${String(response.status)}).`);
      }

      setProgress('Scanning…');
      return confirm({ storageKey: presigned.storageKey });
    },
    onSettled: async () => {
      setProgress(null);
      if (inputRef.current !== null) inputRef.current.value = '';
      await onSettled();
    },
    onError: (error, file) => {
      guard(error, () => {
        upload.mutate(file);
      });
    },
  });

  return upload;
}

function BrandingTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [nameDirty, setNameDirty] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);
  const [logoProgress, setLogoProgress] = useState<string | null>(null);
  const [faviconProgress, setFaviconProgress] = useState<string | null>(null);
  /* Pending palette selection for the live preview — tracks what the user has
     chosen but not yet saved, so the preview updates instantly. */
  const [previewPalette, setPreviewPalette] = useState<string | null>(null);

  const brandingQuery = useQuery({
    queryKey: keys.platformBranding(),
    queryFn: async () => wire(await api.platformAdmin.branding.get.query(undefined)),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.platformBranding() });

  const setBranding = useMutation({
    mutationFn: (input: { productName?: string; paletteId?: PaletteId }) =>
      api.platformAdmin.branding.set.mutate(input),
    onSuccess: async () => {
      setNameDirty(false);
      setPreviewPalette(null);
      await refresh();
    },
    onError: (error, input) => {
      guard(error, () => {
        setBranding.mutate(input);
      });
    },
  });

  const uploadLogo = useAssetUpload({
    presign: (input) => api.platformAdmin.branding.presignLogo.mutate(input),
    confirm: (input) => api.platformAdmin.branding.confirmLogo.mutate(input),
    guard,
    setProgress: setLogoProgress,
    inputRef: logoInputRef,
    onSettled: refresh,
  });

  const uploadFavicon = useAssetUpload({
    presign: (input) => api.platformAdmin.branding.presignFavicon.mutate(input),
    confirm: (input) => api.platformAdmin.branding.confirmFavicon.mutate(input),
    guard,
    setProgress: setFaviconProgress,
    inputRef: faviconInputRef,
    onSettled: refresh,
  });

  if (errorCodeOf(brandingQuery.error) === 'STEP_UP_REQUIRED') {
    return <StepUpGate onStepUp={onStepUp} />;
  }

  const data = brandingQuery.data;
  const displayName = nameDirty ? name : (data?.productName ?? '');

  return (
    <section aria-label="Branding" className="flex flex-col gap-4">
      <p className="text-xs text-ink-muted">
        One brand for this whole deployment — every organization sees the same name, logo, and
        accent color. There is no per-org override.
      </p>

      {brandingQuery.isPending && <SkeletonRows rows={4} className="*:h-12" />}
      {brandingQuery.isError && (
        <ErrorView error={brandingQuery.error} title="Could not load branding" />
      )}

      {data !== undefined && (
        <>
          <div className="flex flex-col gap-4 rounded-xl border border-line p-5">
            <Field label="Product name" htmlFor="branding-name">
              <div className="flex gap-2">
                <Input
                  id="branding-name"
                  value={displayName}
                  maxLength={80}
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameDirty(true);
                  }}
                />
                <Button
                  disabled={setBranding.isPending || !nameDirty || displayName.trim() === ''}
                  onClick={() => {
                    setBranding.mutate({ productName: displayName.trim() });
                  }}
                >
                  Save
                </Button>
                {nameDirty && (
                  <Button
                    variant="ghost"
                    disabled={setBranding.isPending}
                    onClick={() => {
                      setName('');
                      setNameDirty(false);
                    }}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </Field>

            <div>
              <div className="mb-1.5 flex items-center gap-2">
                <p className="text-xs font-medium text-ink">Accent palette</p>
                {previewPalette !== null && previewPalette !== data.paletteId && (
                  <button
                    type="button"
                    disabled={setBranding.isPending}
                    onClick={() => {
                      setPreviewPalette(null);
                    }}
                    className="text-[11px] text-accent underline underline-offset-2 hover:text-accent/80"
                  >
                    Reset to {data.paletteId}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {PALETTE_IDS.map((paletteId) => (
                  <button
                    key={paletteId}
                    type="button"
                    title={paletteId}
                    aria-label={`Use the ${paletteId} palette`}
                    aria-pressed={(previewPalette ?? data.paletteId) === paletteId}
                    disabled={setBranding.isPending}
                    onClick={() => {
                      setPreviewPalette(paletteId);
                      setBranding.mutate({ paletteId });
                    }}
                    className={cn(
                      'size-8 rounded-full border-2 transition-transform',
                      (previewPalette ?? data.paletteId) === paletteId
                        ? 'scale-110 border-ink ring-2 ring-accent/30'
                        : 'border-transparent hover:scale-105',
                    )}
                    style={{ backgroundColor: paletteColorsOf(paletteId).base }}
                  />
                ))}
              </div>
            </div>

            {setBranding.isError && (
              <ErrorView error={setBranding.error} title="Could not save branding" />
            )}
          </div>

          <BrandingPreview
            productName={displayName}
            paletteId={previewPalette ?? data.paletteId}
            logoUrl={data.logoUrl}
            faviconUrl={data.faviconUrl}
          />

          <BrandingAssetUpload
            label="Logo"
            description="Shown in the sidebar. PNG only, 2 MB max."
            currentUrl={data.logoUrl}
            inputRef={logoInputRef}
            progress={logoProgress}
            error={uploadLogo.isError ? uploadLogo.error : null}
            onSelect={(file) => {
              uploadLogo.mutate(file);
            }}
          />

          <BrandingAssetUpload
            label="Favicon"
            description="Shown in the browser tab. PNG only, 2 MB max."
            currentUrl={data.faviconUrl}
            inputRef={faviconInputRef}
            progress={faviconProgress}
            error={uploadFavicon.isError ? uploadFavicon.error : null}
            onSelect={(file) => {
              uploadFavicon.mutate(file);
            }}
          />
        </>
      )}
    </section>
  );
}

function BrandingAssetUpload({
  label,
  description,
  currentUrl,
  inputRef,
  progress,
  error,
  onSelect,
}: {
  readonly label: string;
  readonly description: string;
  readonly currentUrl: string | null;
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly progress: string | null;
  readonly error: unknown;
  readonly onSelect: (file: File) => void;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-line p-4 transition-colors hover:bg-surface-hover/20">
      <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-sunken">
        {currentUrl !== null ? (
          <img src={currentUrl} alt="" className="max-h-full max-w-full rounded object-contain" />
        ) : label === 'Logo' ? (
          <TaskFlowLogo size={28} className="text-accent" />
        ) : (
          <TaskFlowLogo size={20} className="text-accent" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="text-[11px] text-ink-faint">{description}</p>
        {error !== null && (
          <ErrorView error={error} title={`Could not save the ${label.toLowerCase()}`} />
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) onSelect(file);
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={progress !== null}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        {progress ?? 'Upload'}
      </Button>
    </div>
  );
}

/**
 * A live preview of the branding changes — shows how the sidebar, a page
 * header, and a sample card will look with the current name, palette, and
 * logo applied. Updates instantly as the operator edits.
 */
function BrandingPreview({
  productName,
  paletteId,
  logoUrl,
  faviconUrl,
}: {
  readonly productName: string;
  readonly paletteId: string;
  readonly logoUrl: string | null;
  readonly faviconUrl: string | null;
}) {
  const colors = paletteColorsOf(paletteId);

  return (
    <div className="rounded-xl border border-line bg-surface-sunken/40 p-4">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
        Live preview
      </p>

      {/* Browser tab preview */}
      <div className="mb-3 overflow-hidden rounded-lg border border-line bg-surface-raised">
        <div className="flex items-center gap-2 border-b border-line bg-surface-sunken/60 px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 rounded-md bg-surface px-2.5 py-1">
            {faviconUrl !== null ? (
              <img src={faviconUrl} alt="" className="size-3 shrink-0 rounded-sm object-contain" />
            ) : (
              <TaskFlowLogo size={12} className="shrink-0 text-accent" />
            )}
            <span className="max-w-30 truncate text-[10px] text-ink">
              {productName || 'TaskFlow'}
            </span>
            <span className="ml-0.5 text-ink-faint">×</span>
          </div>
          <div className="flex items-center gap-1 rounded bg-surface-sunken px-2 py-0.5">
            <span className="text-[9px] text-ink-faint">🔒</span>
            <span className="max-w-25 truncate text-[9px] text-ink-muted">
              app.{(productName || 'taskflow').toLowerCase().replace(/\s+/g, '-')}.io/home
            </span>
          </div>
        </div>
        <div className="flex h-10 items-center px-3">
          <span className="text-[10px] text-ink-faint">Page content…</span>
        </div>
      </div>

      <div className="flex gap-3">
        {/* Mini sidebar */}
        <div className="flex w-40 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface-raised">
          <div className="flex h-9 items-center gap-1.5 border-b border-line px-2.5">
            {logoUrl !== null ? (
              <img src={logoUrl} alt="" className="size-4 shrink-0 rounded object-contain" />
            ) : (
              <TaskFlowLogo size={16} className="shrink-0 text-accent" />
            )}
            <span className="truncate text-[11px] font-semibold text-ink">
              {productName || 'TaskFlow'}
            </span>
          </div>
          <nav className="flex flex-col gap-0.5 p-1.5">
            {['My tasks', 'Chat', 'Docs', 'People'].map((item, index) => (
              <span
                key={item}
                className={cn(
                  'flex items-center gap-1.5 rounded px-2 py-1 text-[10px]',
                  index === 0 ? 'bg-accent/10 font-medium text-accent' : 'text-ink-muted',
                )}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: index === 0 ? colors.base : 'transparent' }}
                />
                {item}
              </span>
            ))}
          </nav>
        </div>

        {/* Mini page content */}
        <div className="min-w-0 flex-1 space-y-2.5">
          {/* Mini header */}
          <div className="flex items-center justify-between rounded-lg border border-line bg-surface-raised px-3 py-2">
            <span className="text-[11px] font-semibold text-ink">Projects</span>
            <span
              className="rounded-md px-2 py-0.5 text-[10px] font-medium text-white"
              style={{ backgroundColor: colors.base }}
            >
              New project
            </span>
          </div>

          {/* Mini card */}
          <div className="rounded-lg border border-line bg-surface-raised p-2.5">
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: colors.base }} />
              <span className="text-[10px] font-medium text-ink">Sample card</span>
            </div>
            <p className="text-[10px] text-ink-muted">
              This is how cards will look with your brand accent.
            </p>
            <div className="mt-1.5 flex gap-1">
              <span
                className="rounded px-1 py-0.5 text-[9px] font-medium"
                style={{ backgroundColor: `${colors.base}20`, color: colors.base }}
              >
                In progress
              </span>
              <span className="rounded bg-surface-hover px-1 py-0.5 text-[9px] text-ink-faint">
                Design
              </span>
            </div>
          </div>

          {/* Color swatches */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-ink-faint">Accent:</span>
            <span className="size-3 rounded-full" style={{ backgroundColor: colors.base }} />
            <span className="size-3 rounded-full" style={{ backgroundColor: colors.hover }} />
            <span className="text-[10px] text-ink-faint">• {paletteId}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Everything the console knows about one account.
 *
 * The Users tab could say a person belongs to N orgs and never WHICH, or with
 * what role — which made that count the least useful number on the page. An
 * operator handling "why can't this person see anything" needs the membership
 * row and the ORG's own state: a perfectly valid membership in a suspended or
 * lapsed org looks identical to a revoked one from the user's side.
 */
function UserDetailDialog({
  userId,
  onClose,
}: {
  readonly userId: string;
  readonly onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: keys.platformUserDetail(userId),
    queryFn: async () => wire(await api.platformAdmin.users.detail.query({ userId })),
  });

  const data = detail.data;

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="max-h-[85vh] overflow-y-auto p-5">
        <ModalTitle>{data?.name ?? data?.email ?? 'Account'}</ModalTitle>
        <ModalDescription>
          {data === undefined ? 'Loading…' : `${data.email} · joined ${formatDate(data.createdAt)}`}
        </ModalDescription>

        {detail.isPending && <SkeletonRows rows={4} className="mt-4 *:h-10" />}
        {detail.isError && <ErrorView error={detail.error} title="Could not load this account" />}

        {data !== undefined && (
          <div className="mt-4 flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <DetailRow label="Account status" value={data.status} />
              <DetailRow
                label="Email verified"
                value={data.emailVerifiedAt === null ? 'no' : formatDate(data.emailVerifiedAt)}
              />
              <DetailRow label="User id" value={data.userId} mono />
            </dl>

            <section>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">
                Organizations ({data.memberships.length})
              </h3>

              {data.memberships.length === 0 ? (
                <p className="rounded-lg border border-dashed border-line bg-surface-sunken/40 p-4 text-center text-xs text-ink-faint">
                  This account belongs to no organization. They can sign in and will land on the org
                  picker with nothing to choose.
                </p>
              ) : (
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {data.memberships.map((membership) => (
                    <li
                      key={membership.orgId}
                      className="px-3 py-2.5 text-xs transition-colors hover:bg-surface-hover/30"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium text-ink">
                          {membership.orgName}
                        </span>
                        <Badge>{membership.role}</Badge>
                        {membership.status !== 'active' && (
                          <span className="text-[11px] text-ink-faint">{membership.status}</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {membership.orgSlug} · org {membership.orgStatus} ·{' '}
                        {membership.orgBillingStatus} · since {formatDate(membership.joinedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
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

/**
 * Everything the console knows about one org.
 *
 * The answer to "I clicked the name and want to know what's going on with
 * this customer": which plan, are they paying, when does it run out, who do I
 * email, what are they actually entitled to and WHY, what have they spent,
 * and what have operators done to them.
 *
 * The feature list renders its SOURCE next to every row. That is not
 * decoration — a tier-1 override outranks the plan, so "Docs: on" with no
 * provenance makes "why does this Free org have Docs?" unanswerable, and an
 * override guarantees somebody eventually asks.
 */
function OrgDetailDialog({
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

function DetailRow({
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
 * Moves one org onto a plan.
 *
 * Two things this dialog has to say out loud, because both are behaviours an
 * operator will otherwise assume wrongly in one direction or the other:
 *
 * - **It does not change what they are charged.** The route writes `plan_id`
 *   and nothing else — not `billing_status`, not the subscription. Moving a
 *   paying org to a cheaper plan here grants the cheaper plan's entitlements
 *   and leaves their next invoice exactly as it was. That is the honest
 *   behaviour for an operator override ("give this customer Business while we
 *   sort out their contract"), and anything that silently repriced a live
 *   subscription from a console dropdown would be worse.
 * - **A reason is required.** Not decoration: it lands in the hash-chained
 *   operator audit log, and it is the only thing that makes the change
 *   reviewable later.
 */
function ChangeOrgPlanDialog({
  guard,
  org,
  onClose,
  onChanged,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly org: { readonly orgId: string; readonly name: string; readonly planId: string | null };
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const [planId, setPlanId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const plans = useQuery({
    queryKey: keys.platformPlans(),
    queryFn: async () => wire(await api.platformAdmin.plans.list.query(undefined)),
  });

  const change = useMutation({
    mutationFn: (input: { orgId: OrgId; planId: string; reason: string }) =>
      api.platformAdmin.plans.setOrgPlan.mutate(input),
    onSuccess: onChanged,
    onError: (error, input) => {
      guard(error, () => {
        change.mutate(input);
      });
    },
  });

  /* Retired plans are omitted: an org already on one keeps it, but moving a
     NEW org onto a tier that is no longer sold or priced is how a plan nobody
     can renew acquires customers. The server refuses it too. */
  const selectable = (plans.data ?? []).filter((plan) => plan.isActive);
  const chosen = planId ?? org.planId;

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent size="sm" className="p-4">
        <ModalTitle>{org.name} plan</ModalTitle>
        <ModalDescription>
          Currently <strong>{org.planId ?? 'no plan'}</strong>. This changes what the org is
          entitled to — it does <strong>not</strong> change their subscription or what they are
          charged.
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          {plans.isPending && <SkeletonRows rows={3} className="*:h-8" />}
          {plans.isError && <ErrorView error={plans.error} title="Could not load plans" />}

          {plans.data !== undefined && (
            <ul className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/50">
              {selectable.map((plan) => (
                <li key={plan.id} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    <input
                      type="radio"
                      id={`org-plan-${plan.id}`}
                      name="org-plan"
                      className="mt-0.5"
                      checked={chosen === plan.id}
                      onChange={() => {
                        setPlanId(plan.id);
                      }}
                    />
                    <label
                      htmlFor={`org-plan-${plan.id}`}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block text-sm text-ink">
                        {plan.name}
                        {plan.isDefault && <Badge>default</Badge>}
                      </span>
                      <span className="block text-xs text-ink-muted">
                        {plan.features.length === 0 ? 'core only' : plan.features.join(', ')}
                      </span>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Field label="Reason" htmlFor="org-plan-reason">
            <Input
              id="org-plan-reason"
              value={reason}
              placeholder="Contract negotiated — Business until renewal"
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
            <p className="mt-0.5 text-[11px] text-ink-faint">
              Recorded in the operator audit chain. Required.
            </p>
          </Field>

          {change.isError && <ErrorView error={change.error} title="Could not change the plan" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                change.isPending || reason.trim() === '' || chosen === null || chosen === org.planId
              }
              onClick={() => {
                if (chosen === null) return;
                change.mutate({
                  orgId: org.orgId as OrgId,
                  planId: chosen,
                  reason: reason.trim(),
                });
              }}
            >
              {change.isPending ? <Spinner /> : 'Change plan'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/* -------------------------------------------------------------------------- *
 * Plans — the catalog (Phase 12 Wave 4, ai/phase-12-wave4-plans.md §5)
 * -------------------------------------------------------------------------- */

/** Cents to a display string. Integer arithmetic only — see §3.8. */
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/** `null` is unlimited, `0` is none-at-all, and they must not read alike. */
function ceiling(value: number | null, unit: string): string {
  if (value === null) return 'unlimited';
  if (value === 0) return `no ${unit}`;
  return `${String(value)} ${unit}`;
}

/**
 * Trigger a browser download of a CSV file.
 * No library needed — a Blob with the right MIME type and a temporary
 * anchor click is the standard approach.
 */
function downloadCsv(filename: string, rows: readonly (readonly string[])[]): void {
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

/**
 * The plan catalog.
 *
 * The tab that replaces opening the Stripe dashboard. Two things here are
 * deliberate rather than incidental:
 *
 * - **Repricing states its consequence before it happens.** Stripe Prices are
 *   immutable, so changing an amount archives the old Price and creates a new
 *   one, and every existing subscriber stays on what they are paying. A console
 *   that hides which button charges real customers is a console that will
 *   eventually charge them by accident, so the form says how many orgs are on
 *   the plan and that they will not move.
 * - **Retired plans are shown, not filtered.** A tier that is no longer sold
 *   still has tenants on it. Hiding it would make "why is this org on a plan I
 *   cannot see" the first question this page cannot answer.
 */
function PlansTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  const queryClient = useQueryClient();
  const [pricing, setPricing] = useState<string | null>(null);
  const [editingFeatures, setEditingFeatures] = useState<string | null>(null);
  const [editingLimits, setEditingLimits] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [retireTarget, setRetireTarget] = useState<{
    planId: string;
    name: string;
    orgCount: number;
    features: readonly string[];
  } | null>(null);

  const plans = useQuery({
    queryKey: keys.platformPlans(),
    queryFn: async () => wire(await api.platformAdmin.plans.list.query(undefined)),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.platformPlans() });
  };

  const archive = useMutation({
    mutationFn: (input: { planId: string }) => api.platformAdmin.plans.archive.mutate(input),
    onSuccess: invalidate,
    onError: (error, input) => {
      guard(error, () => {
        archive.mutate(input);
      });
    },
  });

  const setDefault = useMutation({
    mutationFn: (input: { planId: string }) => api.platformAdmin.plans.setDefault.mutate(input),
    onSuccess: invalidate,
    onError: (error, input) => {
      guard(error, () => {
        setDefault.mutate(input);
      });
    },
  });

  if (errorCodeOf(plans.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredPlans = plans.data?.filter((plan) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      plan.name.toLowerCase().includes(q) ||
      plan.id.toLowerCase().includes(q) ||
      plan.description?.toLowerCase().includes(q) === true ||
      plan.features.some((feature) => feature.toLowerCase().includes(q))
    );
  });

  return (
    <section aria-label="Plans">
      <div className="flex items-start justify-between gap-3">
        <p className="max-w-2xl text-xs text-ink-muted">
          What tenants may buy. Creating or repricing a plan writes to the payment processor
          directly — the processor&apos;s own dashboard is never needed. Prices are immutable there,
          so changing an amount retires the old price and creates a new one; everyone already
          subscribed keeps paying what they signed up for.
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          New plan
        </Button>
      </div>

      {plans.data !== undefined && plans.data.length > 0 && (
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by name, id, or feature…"
        />
      )}

      {plans.isPending && <SkeletonRows rows={3} className="mt-3 *:h-24" />}
      {plans.isError && <ErrorView error={plans.error} title="Could not load plans" />}

      {plans.data !== undefined &&
        (plans.data.length === 0 ? (
          <Empty
            title="No plans yet"
            description="Create your first plan to start defining what tenants can buy."
          />
        ) : (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line">
            {(filteredPlans ?? []).map((plan) => (
              <li
                key={plan.id}
                className="flex flex-col gap-2 px-4 py-4 transition-colors hover:bg-surface-hover/30"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                      {plan.name}
                      <span className="font-mono text-[11px] text-ink-faint">{plan.id}</span>
                      {plan.isDefault && <Badge>default</Badge>}
                      {!plan.isActive && <Badge>retired</Badge>}
                      {plan.stripeProductId === null && <Badge>no processor product</Badge>}
                    </p>
                    {plan.description !== null && (
                      <p className="truncate text-xs text-ink-muted">{plan.description}</p>
                    )}

                    <p className="mt-1 text-xs text-ink">
                      {plan.currentPrices.length === 0 ? (
                        <span className="text-ink-faint">no price configured</span>
                      ) : (
                        plan.currentPrices
                          .map(
                            (price) =>
                              `${money(price.amountCents, price.currency)}/${price.interval}`,
                          )
                          .join(' · ')
                      )}
                    </p>

                    <p className="mt-1 text-[11px] text-ink-faint">
                      {plan.orgCount} org{plan.orgCount === 1 ? '' : 's'} · telephony{' '}
                      {ceiling(plan.telephonyCapCents, 'cents')} · automation{' '}
                      {ceiling(plan.automationRunsPerHour, 'runs/hr')} · TURN{' '}
                      {ceiling(plan.turnIssuancePerDay, 'issues/day')}
                      {plan.telephonyIncludedCents > 0 &&
                        ` · includes ${money(plan.telephonyIncludedCents, 'usd')} usage`}
                      {plan.telephonyMarkupPct > 0 &&
                        ` · +${String(plan.telephonyMarkupPct)}% markup`}
                    </p>

                    <p className="mt-1 text-[11px] text-ink-faint">
                      {plan.features.length === 0
                        ? 'core only — no flagged modules'
                        : plan.features.join(', ')}
                    </p>

                    {/* The processor ids, with a link where there is a console
                        to link to. A stored id is a CLAIM that the object was
                        created; it is not evidence the object is still there,
                        or that it belongs to the Stripe account this
                        deployment currently points at. Only looking settles
                        that, so the console makes looking one click. */}
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-ink-faint">
                      {plan.stripeProductId === null ? (
                        <span>not yet at the processor — created on first price</span>
                      ) : (
                        <ProcessorRef
                          label="product"
                          id={plan.stripeProductId}
                          url={plan.stripeProductUrl}
                        />
                      )}
                      {plan.currentPrices.map((price) =>
                        price.stripePriceId === null ? null : (
                          <ProcessorRef
                            key={price.id}
                            label={price.interval}
                            id={price.stripePriceId}
                            url={price.stripePriceUrl}
                          />
                        ),
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Button
                      onClick={() => {
                        setEditingFeatures(plan.id);
                      }}
                    >
                      Features
                    </Button>
                    <Button
                      onClick={() => {
                        setEditingLimits(plan.id);
                      }}
                    >
                      Limits
                    </Button>
                    {/* Shown for ANY active plan, including one with no
                        processor product yet. `setPrice` creates the product
                        on demand — hiding this button for a product-less plan
                        was a dead end: migration 0063 seeds `free` and `pro`
                        without one (a migration cannot call Stripe), so on a
                        fresh database neither seeded plan could ever be given
                        a price and no org could ever upgrade. */}
                    {plan.isActive && (
                      <Button
                        onClick={() => {
                          setPricing(plan.id);
                        }}
                      >
                        Set price
                      </Button>
                    )}
                    {!plan.isDefault && plan.isActive && (
                      <Button
                        disabled={setDefault.isPending}
                        onClick={() => {
                          setDefault.mutate({ planId: plan.id });
                        }}
                      >
                        Make default
                      </Button>
                    )}
                    {plan.isActive && !plan.isDefault && (
                      <Button
                        variant="danger"
                        disabled={archive.isPending}
                        onClick={() => {
                          setRetireTarget({
                            planId: plan.id,
                            name: plan.name,
                            orgCount: plan.orgCount,
                            features: plan.features,
                          });
                        }}
                      >
                        Retire
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
            {(filteredPlans ?? []).length === 0 && search.trim() !== '' && (
              <li className="px-4 py-8 text-center text-sm text-ink-faint">
                No plans match your search.
              </li>
            )}
          </ul>
        ))}

      {archive.isError && <ErrorView error={archive.error} title="Could not retire the plan" />}
      {setDefault.isError && (
        <ErrorView error={setDefault.error} title="Could not change the default plan" />
      )}

      {creating && (
        <CreatePlanDialog
          guard={guard}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={() => {
            setCreating(false);
            void invalidate();
          }}
        />
      )}

      {pricing !== null && (
        <SetPriceDialog
          guard={guard}
          plan={plans.data?.find((plan) => plan.id === pricing)}
          onClose={() => {
            setPricing(null);
          }}
          onPriced={() => {
            setPricing(null);
            void invalidate();
          }}
        />
      )}

      {editingFeatures !== null && (
        <EditFeaturesDialog
          guard={guard}
          plan={plans.data?.find((plan) => plan.id === editingFeatures)}
          onClose={() => {
            setEditingFeatures(null);
          }}
          onSaved={() => {
            setEditingFeatures(null);
            void invalidate();
          }}
        />
      )}

      {editingLimits !== null && (
        <EditLimitsDialog
          guard={guard}
          plan={plans.data?.find((plan) => plan.id === editingLimits)}
          onClose={() => {
            setEditingLimits(null);
          }}
          onSaved={() => {
            setEditingLimits(null);
            void invalidate();
          }}
        />
      )}

      {retireTarget !== null && (
        <RetirePlanDialog
          plan={retireTarget}
          disabled={archive.isPending}
          onClose={() => {
            setRetireTarget(null);
          }}
          onConfirm={() => {
            archive.mutate({ planId: retireTarget.planId });
            setRetireTarget(null);
          }}
        />
      )}
    </section>
  );
}

/**
 * Confirmation dialog before retiring a plan.
 *
 * Retiring a plan does NOT eject its tenants — they keep the plan and keep
 * working. But it means no new org can subscribe to it, and the dialog
 * states both facts so the operator understands the blast radius.
 */
function RetirePlanDialog({
  plan,
  disabled,
  onClose,
  onConfirm,
}: {
  readonly plan: {
    readonly planId: string;
    readonly name: string;
    readonly orgCount: number;
    readonly features: readonly string[];
  };
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <ModalRoot
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <ModalContent size="sm" className="p-5">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-danger/15 text-danger">
            <ShieldAlert className="size-5" strokeWidth={2} />
          </span>
          <div>
            <ModalTitle>Retire {plan.name}?</ModalTitle>
            <ModalDescription>
              This plan has {String(plan.orgCount)} active organization
              {plan.orgCount === 1 ? '' : 's'}.
            </ModalDescription>
          </div>
        </div>

        <div className="space-y-3 text-sm text-ink">
          <p>
            Retiring a plan means <strong>no new organization can subscribe to it</strong>, but
            existing tenants <strong>keep the plan and keep working</strong>. They are not ejected
            or downgraded.
          </p>

          {plan.orgCount > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
              <p className="text-xs font-medium text-warning">
                {String(plan.orgCount)} organization{plan.orgCount === 1 ? '' : 's'} currently on
                this plan
              </p>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                They will continue to have access to all features until their plan is manually
                changed or they cancel.
              </p>
            </div>
          )}

          {plan.features.length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink-muted">Features on this plan:</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {plan.features.map((feature) => (
                  <Badge key={feature}>{feature}</Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={disabled} onClick={onConfirm}>
            {disabled ? <Spinner /> : `Retire ${plan.name}`}
          </Button>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * The ceilings and usage-billing numbers.
 *
 * Every ceiling is a THREE-state field, and the form has to make all three
 * reachable or the schema's own vocabulary is unusable from the console:
 *
 *   - empty  -> `null`, unlimited
 *   - `0`    -> none at all (telephony refused outright)
 *   - `n`    -> that many
 *
 * "Unlimited" and "none" are opposite answers that a single numeric input
 * cannot distinguish, which is why the empty string is given a meaning here
 * rather than being treated as "unchanged".
 *
 * A ceiling is NOT the value an org gets — it is the most an org on this plan
 * may be raised to. The org's own `comms.spend_policy` row holds what it is
 * actually set to, and an Owner may raise that up to this number and no
 * further. That is the bound a compromised Owner credential cannot move.
 */
function EditLimitsDialog({
  guard,
  plan,
  onClose,
  onSaved,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly plan:
    | {
        readonly id: string;
        readonly name: string;
        readonly telephonyCapCents: number | null;
        readonly automationRunsPerHour: number | null;
        readonly turnIssuancePerDay: number | null;
        readonly telephonyIncludedCents: number;
        readonly telephonyMarkupPct: number;
        readonly stripeProductId: string | null;
      }
    | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  /* Held as strings, because the empty string is a MEANING here (unlimited)
     and a numeric state would have to represent it as null anyway — one
     conversion at submit is simpler than two in both directions. */
  const [cap, setCap] = useState<string | null>(null);
  const [runs, setRuns] = useState<string | null>(null);
  const [turn, setTurn] = useState<string | null>(null);
  const [included, setIncluded] = useState<string | null>(null);
  const [markup, setMarkup] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (input: {
      planId: string;
      telephonyCapCents: number | null;
      automationRunsPerHour: number | null;
      turnIssuancePerDay: number | null;
      telephonyIncludedCents: number;
      telephonyMarkupPct: number;
    }) => api.platformAdmin.plans.update.mutate(input),
    onSuccess: onSaved,
    onError: (error, input) => {
      guard(error, () => {
        save.mutate(input);
      });
    },
  });

  if (plan === undefined) return null;

  const asText = (value: number | null): string => (value === null ? '' : String(value));
  const capText = cap ?? asText(plan.telephonyCapCents);
  const runsText = runs ?? asText(plan.automationRunsPerHour);
  const turnText = turn ?? asText(plan.turnIssuancePerDay);
  const includedText = included ?? String(plan.telephonyIncludedCents);
  const markupText = markup ?? String(plan.telephonyMarkupPct);

  /** Empty means unlimited; anything else must be a non-negative integer. */
  const nullableInt = (text: string): number | null | 'invalid' => {
    if (text.trim() === '') return null;
    const value = Number(text);
    return Number.isInteger(value) && value >= 0 ? value : 'invalid';
  };
  const requiredInt = (text: string): number | 'invalid' => {
    const value = Number(text);
    return text.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : 'invalid';
  };

  const parsed = {
    telephonyCapCents: nullableInt(capText),
    automationRunsPerHour: nullableInt(runsText),
    turnIssuancePerDay: nullableInt(turnText),
    telephonyIncludedCents: requiredInt(includedText),
    telephonyMarkupPct: requiredInt(markupText),
  };
  const valid = !Object.values(parsed).includes('invalid');
  /* The migration refuses an allowance on a plan with no processor product —
     there is no subscription to attach an overage invoice item to. Said here
     too, so the operator learns it before the round trip. */
  const allowanceNeedsProduct =
    plan.stripeProductId === null &&
    parsed.telephonyIncludedCents !== 'invalid' &&
    parsed.telephonyIncludedCents > 0;

  /* `field` is the LIMIT_COPY key: the explanation for a number lives in one
     place, and a missing key renders no hint rather than throwing. */
  const limitField = (
    id: string,
    label: string,
    field: string,
    value: string,
    onChange: (next: string) => void,
  ) => (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        value={value}
        inputMode="numeric"
        placeholder="unlimited"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p className="mt-0.5 text-[11px] text-ink-faint">{LIMIT_COPY[field] ?? ''}</p>
    </Field>
  );

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalTitle>{plan.name} limits</ModalTitle>
        <ModalDescription>
          These are <strong>ceilings, not values</strong> — the most an org on this plan may be
          raised to. Leave a field empty for unlimited; enter 0 for none at all.
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          {limitField(
            'plan-cap',
            'Telephony spend cap (cents / 30 days)',
            'telephonyCapCents',
            capText,
            setCap,
          )}
          {limitField(
            'plan-runs',
            'Automation runs per hour',
            'automationRunsPerHour',
            runsText,
            setRuns,
          )}
          {limitField(
            'plan-turn',
            'TURN credentials per day',
            'turnIssuancePerDay',
            turnText,
            setTurn,
          )}
          {limitField(
            'plan-included',
            'Included telephony usage (cents / period)',
            'telephonyIncludedCents',
            includedText,
            setIncluded,
          )}
          {limitField(
            'plan-markup',
            'Usage markup (%)',
            'telephonyMarkupPct',
            markupText,
            setMarkup,
          )}

          {allowanceNeedsProduct && (
            <p className="text-xs text-danger">
              This plan is not at the processor yet, so there is no subscription to bill an overage
              against. Set a price first — that creates the product — then come back.
            </p>
          )}

          {save.isError && <ErrorView error={save.error} title="Could not save the limits" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {(cap !== null ||
              runs !== null ||
              turn !== null ||
              included !== null ||
              markup !== null) && (
              <Button
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setCap(null);
                  setRuns(null);
                  setTurn(null);
                  setIncluded(null);
                  setMarkup(null);
                }}
              >
                Reset all
              </Button>
            )}
            <Button
              variant="primary"
              disabled={save.isPending || !valid || allowanceNeedsProduct}
              onClick={() => {
                if (!valid) return;
                save.mutate({
                  planId: plan.id,
                  telephonyCapCents: parsed.telephonyCapCents as number | null,
                  automationRunsPerHour: parsed.automationRunsPerHour as number | null,
                  turnIssuancePerDay: parsed.turnIssuancePerDay as number | null,
                  telephonyIncludedCents: parsed.telephonyIncludedCents as number,
                  telephonyMarkupPct: parsed.telephonyMarkupPct as number,
                });
              }}
            >
              {save.isPending ? <Spinner /> : 'Save limits'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * One processor object, linked where the processor has a console.
 *
 * `url === null` means the configured provider has no dashboard — the fake, on
 * a deployment with no Stripe account. The id still renders, because "there is
 * nowhere to look" and "there is nothing here" are different facts and only
 * one of them is a problem.
 */
function ProcessorRef({
  label,
  id,
  url,
}: {
  readonly label: string;
  readonly id: string;
  readonly url: string | null;
}) {
  const body = (
    <>
      {label}:{id.length > 18 ? `${id.slice(0, 18)}…` : id}
    </>
  );

  if (url === null) return <span title={id}>{body}</span>;

  return (
    <a
      href={url}
      target="_blank"
      /* noreferrer alongside noopener: the target is an external console, and
         the referrer would leak this deployment's own admin path to it. */
      rel="noopener noreferrer"
      title={`${id} — open in the payment processor's console`}
      className="underline decoration-dotted hover:text-ink"
    >
      {body} ↗
    </a>
  );
}

/**
 * The per-plan feature editor.
 *
 * This is what makes "which modules does this tier include" a decision an
 * operator makes, rather than a constant compiled into a migration. The list
 * comes from the server's own flag registry — never a hardcoded copy here,
 * which would drift the day a module ships and silently offer a feature the
 * service then refuses.
 *
 * Flags with `perOrg: false` are excluded rather than shown-and-disabled:
 * `telephonyLiveCredentials` is release plumbing that starts real carrier
 * spend, the service refuses it outright, and rendering a checkbox for
 * something that can only ever fail is an invitation to try.
 */
function EditFeaturesDialog({
  guard,
  plan,
  onClose,
  onSaved,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly plan:
    | { readonly id: string; readonly name: string; readonly features: readonly string[] }
    | undefined;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const registry = useQuery({
    queryKey: keys.platformFlags(),
    queryFn: async () => wire(await api.platformAdmin.flags.list.query(undefined)),
  });

  const [selected, setSelected] = useState<readonly string[] | null>(null);
  const features = selected ?? plan?.features ?? [];

  const save = useMutation({
    mutationFn: (input: { planId: string; features: string[] }) =>
      api.platformAdmin.plans.update.mutate(input),
    onSuccess: onSaved,
    onError: (error, input) => {
      guard(error, () => {
        save.mutate(input);
      });
    },
  });

  if (plan === undefined) return null;

  const grantable = (registry.data ?? []).filter((flag) => flag.perOrg);

  const toggle = (flagName: string) => {
    setSelected(
      features.includes(flagName)
        ? features.filter((name) => name !== flagName)
        : [...features, flagName],
    );
  };

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalTitle>{plan.name} features</ModalTitle>
        <ModalDescription>
          Which modules this tier includes. Turning one off does not delete anything — orgs on this
          plan keep their data and lose access to it until the module is included again.
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          {registry.isPending && <SkeletonRows rows={4} className="*:h-10" />}
          {registry.isError && (
            <ErrorView error={registry.error} title="Could not load the flag registry" />
          )}

          {registry.data !== undefined && (
            <ul className="divide-y divide-line/40 overflow-hidden rounded-lg border border-line/50">
              {grantable.map((flag) => (
                <li key={flag.flagName} className="px-3 py-2 hover:bg-surface-hover">
                  {/* htmlFor/id rather than nesting the text: the description
                      belongs to the control too, and only an explicit
                      association gets both lines read out together. */}
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      id={`plan-feature-${flag.flagName}`}
                      className="mt-0.5"
                      checked={features.includes(flag.flagName)}
                      onChange={() => {
                        toggle(flag.flagName);
                      }}
                    />
                    <label
                      htmlFor={`plan-feature-${flag.flagName}`}
                      className="min-w-0 flex-1 cursor-pointer"
                    >
                      <span className="block text-sm text-ink">
                        {featureLabel(flag.flagName)}
                        <span className="ml-1.5 font-mono text-[11px] text-ink-faint">
                          {flag.flagName}
                        </span>
                      </span>
                      {/* The CUSTOMER-facing sentence, so an operator pricing
                          a tier reads the same description the person buying
                          it will. The registry's own `description` is written
                          for developers and is kept as the second line. */}
                      <span className="block text-xs text-ink-muted">
                        {featureDescription(flag.flagName) ?? flag.description}
                      </span>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {save.isError && <ErrorView error={save.error} title="Could not save the features" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {selected !== null && (
              <Button
                variant="ghost"
                disabled={save.isPending}
                onClick={() => {
                  setSelected(null);
                }}
              >
                Reset
              </Button>
            )}
            <Button
              variant="primary"
              disabled={save.isPending || selected === null}
              onClick={() => {
                save.mutate({ planId: plan.id, features: [...features] });
              }}
            >
              {save.isPending ? <Spinner /> : 'Save features'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

function CreatePlanDialog({
  guard,
  onClose,
  onCreated,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [withProduct, setWithProduct] = useState(true);

  const create = useMutation({
    mutationFn: (input: { id: string; name: string; withProduct: boolean }) =>
      api.platformAdmin.plans.create.mutate(input),
    onSuccess: onCreated,
    onError: (error, input) => {
      guard(error, () => {
        create.mutate(input);
      });
    },
  });

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalTitle>New plan</ModalTitle>
        <ModalDescription>
          The id is permanent — it is written onto every org that subscribes, and it appears in logs
          and support conversations. Features and ceilings are edited after creation.
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="Id" htmlFor="plan-id">
            <Input
              id="plan-id"
              value={id}
              placeholder="business"
              onChange={(event) => {
                setId(event.target.value);
              }}
            />
          </Field>
          <Field label="Name" htmlFor="plan-name">
            <Input
              id="plan-name"
              value={name}
              placeholder="Business"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>

          <label className="flex items-start gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={withProduct}
              onChange={(event) => {
                setWithProduct(event.target.checked);
              }}
            />
            {/* Not inferable from a zero price: "this tier is never charged
                for" is a decision, and a plan created without a processor
                product cannot grow one later. */}
            <span>
              Create a product at the payment processor. Uncheck for a free tier — a plan created
              without one can never carry a price.
            </span>
          </label>

          {create.isError && <ErrorView error={create.error} title="Could not create the plan" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={create.isPending || id.trim() === '' || name.trim() === ''}
              onClick={() => {
                create.mutate({ id: id.trim(), name: name.trim(), withProduct });
              }}
            >
              {create.isPending ? <Spinner /> : 'Create'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * Repricing, with the consequence stated before the button.
 *
 * The count and the "they stay" sentence are the whole point of this dialog
 * existing rather than an inline field: an operator changing a number must see
 * that existing customers do NOT move before they commit, because that is the
 * behaviour they are most likely to assume wrongly in either direction.
 */
function SetPriceDialog({
  guard,
  plan,
  onClose,
  onPriced,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly plan:
    | {
        readonly id: string;
        readonly name: string;
        readonly orgCount: number;
        readonly currentPrices: readonly {
          readonly interval: 'month' | 'year';
          readonly amountCents: number;
          readonly currency: string;
        }[];
      }
    | undefined;
  readonly onClose: () => void;
  readonly onPriced: () => void;
}) {
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [amount, setAmount] = useState('');

  const setPrice = useMutation({
    mutationFn: (input: {
      planId: string;
      interval: 'month' | 'year';
      amountCents: number;
      currency: string;
    }) => api.platformAdmin.plans.setPrice.mutate(input),
    onSuccess: onPriced,
    onError: (error, input) => {
      guard(error, () => {
        setPrice.mutate(input);
      });
    },
  });

  if (plan === undefined) return null;

  const existing = plan.currentPrices.find((price) => price.interval === interval);
  /* Parsed to an INTEGER number of cents at the edge. Nothing downstream ever
     does decimal arithmetic on money — the route, the catalog and the
     processor all take minor units. */
  const amountCents = Math.round(Number.parseFloat(amount === '' ? 'NaN' : amount) * 100);
  const valid = Number.isInteger(amountCents) && amountCents >= 0;

  return (
    <ModalRoot open onOpenChange={onClose}>
      <ModalContent className="p-4">
        <ModalTitle>Set {plan.name} price</ModalTitle>
        <ModalDescription>
          {existing === undefined ? (
            <>No {interval}ly price yet — this creates the first one.</>
          ) : (
            <>
              Currently {money(existing.amountCents, existing.currency)}/{interval}. Saving retires
              that price and creates a new one.{' '}
              <strong>
                The {plan.orgCount} org{plan.orgCount === 1 ? '' : 's'} on this plan keep paying
                what they signed up for
              </strong>{' '}
              — only new subscriptions get the new amount.
            </>
          )}
        </ModalDescription>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="Interval" htmlFor="plan-interval">
            <div className="flex gap-1.5">
              {(['month', 'year'] as const).map((value) => (
                <Button
                  key={value}
                  {...(interval === value ? ({ variant: 'primary' } as const) : {})}
                  onClick={() => {
                    setInterval(value);
                  }}
                >
                  {value}ly
                </Button>
              ))}
            </div>
          </Field>

          <Field label="Amount (USD)" htmlFor="plan-amount">
            <Input
              id="plan-amount"
              value={amount}
              inputMode="decimal"
              placeholder="29.00"
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          </Field>

          {setPrice.isError && <ErrorView error={setPrice.error} title="Could not set the price" />}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={setPrice.isPending || !valid}
              onClick={() => {
                setPrice.mutate({ planId: plan.id, interval, amountCents, currency: 'usd' });
              }}
            >
              {setPrice.isPending ? <Spinner /> : 'Save price'}
            </Button>
          </div>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/* -------------------------------------------------------------------------- *
 * Operator audit
 * -------------------------------------------------------------------------- */

function AuditTab({ onStepUp }: { readonly onStepUp: () => void }) {
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
              Operator actions will appear here once they are taken. Every call — including reads — is recorded in the hash chain.
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
                    <tr key={entry.seq} className="border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50">
                      <td className="px-3 py-2.5 font-mono text-xs text-ink-faint">{entry.seq}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                        {formatDateTime(entry.occurredAt)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1 rounded-md bg-surface-hover px-1.5 py-0.5 text-xs font-medium text-ink">
                          {entry.action}
                        </span>
                      </td>
                      <td className="max-w-50 px-3 py-2.5 font-mono text-[11px] text-ink-muted">
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
                          <p className="text-xs text-ink-faint">Try a different action, operator email, or target.</p>
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

/* -------------------------------------------------------------------------- *
 * Operations dashboard — "did a system action succeed or fail" (mail
 * delivery, a billing webhook, the billing sweep's heartbeat), the different
 * question from the operator audit tab above, which answers "what did a
 * human operator do". Read-only in this wave — no retry action yet.
 * -------------------------------------------------------------------------- */

type OperationalEventKind = 'mail' | 'billing_webhook' | 'billing_sweep';

const OPERATIONAL_EVENT_KINDS: readonly (readonly [OperationalEventKind | null, string])[] = [
  [null, 'All'],
  ['mail', 'Mail'],
  ['billing_webhook', 'Billing webhook'],
  ['billing_sweep', 'Billing sweep'],
];

function OperationsTab({ onStepUp }: { readonly onStepUp: () => void }) {
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
              Operational events will appear here as system actions occur — mail delivery, billing webhooks, and sweep heartbeats.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-sunken/60">
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      When
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Kind
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Outcome
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Target
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/50">
                  {(filteredEvents ?? []).map((event) => (
                    <tr key={event.id} className="border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50">
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
                      <td className="max-w-50 px-3 py-2.5 font-mono text-[11px] text-ink-muted">
                        {event.target ?? '—'}
                      </td>
                      <td className="max-w-50 px-3 py-2.5 font-mono text-[11px] text-ink-muted">
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
                          <p className="text-xs text-ink-faint">Try a different kind, outcome, or target.</p>
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
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
        <span className="size-1.5 rounded-full bg-success" />
        success
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
      <ShieldAlert className="size-3" strokeWidth={2.5} />
      failure
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Billing (Phase 12 Wave 3 §3.6)
 * -------------------------------------------------------------------------- */

/**
 * A pure-SVG horizontal bar chart for billing summary stats.
 * No charting library — just rect elements sized proportionally.
 */
function BillingBarChart({
  data,
  maxValue,
}: {
  readonly data: readonly {
    readonly label: string;
    readonly value: number;
    readonly color: string;
  }[];
  readonly maxValue: number;
}) {
  if (maxValue === 0) return null;

  return (
    <div className="space-y-1.5">
      {data.map((item) => {
        const width = Math.max((item.value / maxValue) * 100, item.value > 0 ? 4 : 0);
        return (
          <div key={item.label} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-right text-[11px] text-ink-muted">
              {item.label}
            </span>
            <div className="min-w-0 flex-1">
              <svg width="100%" height="16" className="overflow-visible">
                <rect
                  x={0}
                  y={2}
                  width={`${String(width)}%`}
                  height={12}
                  rx={4}
                  fill={item.color}
                  opacity={item.value > 0 ? 0.85 : 0.15}
                />
              </svg>
            </div>
            <span className="w-8 shrink-0 text-right text-[11px] font-medium text-ink">
              {String(item.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Billing summary dashboard — computed from the current page of billing data.
 * Shows MRR, status breakdown, and plan distribution as compact bar charts.
 */
function BillingSummary({ orgs }: { readonly orgs: readonly Record<string, unknown>[] }) {
  /* MRR — sum of currentPriceCents for active orgs only. */
  const mrr = orgs.reduce((sum, org) => {
    const price = (org as { currentPriceCents?: number | null; billingStatus?: string })
      .currentPriceCents;
    const status = (org as { billingStatus?: string }).billingStatus;
    if (price !== null && price !== undefined && status === 'active') {
      return sum + price;
    }
    return sum;
  }, 0);

  /* Status counts */
  const statusCounts = {
    active: 0,
    trialing: 0,
    past_due: 0,
    canceled: 0,
  };
  for (const org of orgs) {
    const status = (org as { billingStatus?: string }).billingStatus;
    if (status === 'active') statusCounts.active++;
    else if (status === 'trialing') statusCounts.trialing++;
    else if (status === 'past_due') statusCounts.past_due++;
    else statusCounts.canceled++;
  }

  /* Plan distribution */
  const planCounts = new Map<string, number>();
  for (const org of orgs) {
    const plan = (org as { planId?: string | null }).planId ?? 'none';
    planCounts.set(plan, (planCounts.get(plan) ?? 0) + 1);
  }
  const planData = [...planCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({
      label,
      value,
      color: 'var(--color-accent)',
    }));

  const statusData = [
    { label: 'Active', value: statusCounts.active, color: 'var(--color-success)' },
    { label: 'Trialing', value: statusCounts.trialing, color: 'var(--color-accent)' },
    { label: 'Past due', value: statusCounts.past_due, color: 'var(--color-danger)' },
    { label: 'Canceled', value: statusCounts.canceled, color: 'var(--color-ink-faint)' },
  ];

  const maxStatus = Math.max(
    statusCounts.active,
    statusCounts.trialing,
    statusCounts.past_due,
    statusCounts.canceled,
  );
  const maxPlan = planData.length > 0 ? Math.max(...planData.map((d) => d.value)) : 0;

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {/* MRR card */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          Monthly recurring revenue
        </p>
        <p className="mt-1 text-2xl font-semibold tracking-tight text-ink">{money(mrr, 'usd')}</p>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          from {String(statusCounts.active)} active organization
          {statusCounts.active === 1 ? '' : 's'}
        </p>
      </div>

      {/* Status breakdown */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          By status
        </p>
        <BillingBarChart data={statusData} maxValue={maxStatus} />
      </div>

      {/* Plan distribution */}
      <div className="rounded-xl border border-line bg-surface-raised p-4">
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          By plan
        </p>
        {planData.length === 0 ? (
          <p className="text-[11px] text-ink-faint">No data</p>
        ) : (
          <BillingBarChart data={planData} maxValue={maxPlan} />
        )}
      </div>
    </div>
  );
}

function BillingTab({
  guard,
  onStepUp,
}: {
  readonly guard: (error: unknown, retry: () => void) => boolean;
  readonly onStepUp: () => void;
}) {
  /** The drill-down panel's subject — the same one the Orgs tab opens. */
  const [billingDetailOrgId, setBillingDetailOrgId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState<string | null>(null);
  const [extendTarget, setExtendTarget] = useState<{ orgId: string; name: string } | null>(null);
  const [extendByDays, setExtendByDays] = useState('7');
  const [search, setSearch] = useState('');

  const billing = useQuery({
    queryKey: keys.platformBilling(cursor),
    queryFn: async () => wire(await api.platformAdmin.billing.list.query({ cursor, limit: 25 })),
  });

  const extend = useMutation({
    mutationFn: (input: { orgId: OrgId; extendByDays: number }) =>
      api.platformAdmin.billing.grantExtension.mutate(input),
    onSuccess: async () => {
      setExtendTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['platform', 'billing'] });
    },
    onError: (error, input) => {
      guard(error, () => {
        extend.mutate(input);
      });
    },
  });

  if (errorCodeOf(billing.error) === 'STEP_UP_REQUIRED') return <StepUpGate onStepUp={onStepUp} />;

  const filteredOrgs = billing.data?.orgs.filter((org) => {
    if (search.trim() === '') return true;
    const q = search.toLowerCase();
    return (
      org.name.toLowerCase().includes(q) ||
      org.slug.toLowerCase().includes(q) ||
      org.planId?.toLowerCase().includes(q) === true ||
      org.planName?.toLowerCase().includes(q) === true ||
      org.stripeCustomerId?.toLowerCase().includes(q) === true ||
      org.billingStatus.toLowerCase().includes(q)
    );
  });

  return (
    <section aria-label="Billing">
      {billing.data !== undefined && billing.data.orgs.length > 0 && (
        <BillingSummary orgs={billing.data.orgs} />
      )}

      <div className="flex items-center justify-between gap-3">
        <TableSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter by name, slug, plan, or Stripe ID…"
        />
        {billing.data !== undefined && billing.data.orgs.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const header = [
                'Organization',
                'Slug',
                'Billing status',
                'Plan',
                'Plan name',
                'Current price',
                'Interval',
                'Renews',
                'Last invoice status',
                'Last invoice amount',
                'Last invoice date',
                'Trial ends',
                'Grace ends',
                'Pending plan',
                'Stripe customer',
              ];
              const rows = [
                header,
                ...billing.data.orgs.map((org) => [
                  org.name,
                  org.slug,
                  org.billingStatus,
                  org.planId ?? '',
                  org.planName ?? '',
                  org.currentPriceCents !== null ? money(org.currentPriceCents, 'usd') : '',
                  org.currentPriceInterval ?? '',
                  org.currentPeriodEnd !== null ? formatDate(org.currentPeriodEnd) : '',
                  org.lastInvoice?.status ?? '',
                  org.lastInvoice !== null
                    ? money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)
                    : '',
                  org.lastInvoice !== null ? formatDate(org.lastInvoice.issuedAt) : '',
                  org.trialEndsAt !== null ? formatDate(org.trialEndsAt) : '',
                  org.billingGraceEndsAt !== null ? formatDate(org.billingGraceEndsAt) : '',
                  org.pendingPlanId ?? '',
                  org.stripeCustomerId ?? '',
                ]),
              ];
              downloadCsv(`billing-export-${new Date().toISOString().slice(0, 10)}.csv`, rows);
            }}
          >
            Export CSV
          </Button>
        )}
      </div>

      {billing.isPending && <SkeletonRows rows={5} className="mt-3 *:h-12" />}
      {billing.isError && <ErrorView error={billing.error} title="Could not load billing" />}

      {billing.data !== undefined && (
        <div className="mt-3 overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-sunken/60">
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Organization
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Status
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Plan
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Renews
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Last invoice
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Trial / grace ends
                </th>
                <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                  Stripe customer
                </th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>{' '}
            <tbody className="divide-y divide-line/50">
              {(filteredOrgs ?? []).map((org) => (
                <tr
                  key={org.orgId}
                  className="group cursor-pointer border-l-2 border-l-transparent transition-all hover:border-l-accent hover:bg-surface-hover/50"
                  onClick={() => {
                    setBillingDetailOrgId(org.orgId);
                  }}
                >
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-ink transition-colors group-hover:text-accent">{org.name}</p>
                    <p className="font-mono text-[11px] text-ink-faint">{org.slug}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <BillingStatusBadge billingStatus={org.billingStatus} />
                  </td>
                  <td className="px-3 py-2.5">
                    <p className="text-ink">{org.planName ?? org.planId ?? '—'}</p>
                    {org.currentPriceCents !== null && (
                      <p className="text-[11px] text-ink-faint">
                        {money(org.currentPriceCents, 'usd')}/{org.currentPriceInterval ?? 'month'}
                      </p>
                    )}
                    {org.pendingPlanId !== null && org.pendingPlanEffectiveAt !== null && (
                      <p className="text-[11px] font-medium text-warning">
                        → {org.pendingPlanId} {formatDate(org.pendingPlanEffectiveAt)}
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {org.currentPeriodEnd === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <span>
                        {formatDate(org.currentPeriodEnd)}
                        <span className="ml-1.5 text-[10px] text-ink-faint">
                          {relativeTime(new Date(org.currentPeriodEnd))}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {org.lastInvoice === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <>
                        <p
                          className={
                            org.lastInvoice.status === 'paid' ? 'text-success' : 'text-danger'
                          }
                        >
                          {org.lastInvoice.status}{' '}
                          {money(org.lastInvoice.amountDueCents, org.lastInvoice.currency)}
                        </p>
                        <p className="text-[11px] text-ink-faint">
                          {formatDate(org.lastInvoice.issuedAt)}
                        </p>
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">
                    {org.billingStatus === 'past_due' && org.billingGraceEndsAt !== null
                      ? formatDate(org.billingGraceEndsAt)
                      : org.trialEndsAt !== null
                        ? formatDate(org.trialEndsAt)
                        : '—'}
                  </td>
                  <td className="max-w-35 truncate px-3 py-2.5 font-mono text-[11px] text-ink-faint">
                    {org.stripeCustomerId ?? '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {org.billingStatus === 'past_due' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={extend.isPending}
                        onClick={() => {
                          setExtendByDays('7');
                          setExtendTarget({ orgId: org.orgId, name: org.name });
                        }}
                      >
                        Extend grace
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {(filteredOrgs ?? []).length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center">
                    {search.trim() !== '' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="size-5 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm text-ink-faint">No organizations match your search.</p>
                        <p className="text-xs text-ink-faint">Try a different name, slug, plan, or Stripe ID.</p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <CreditCard className="size-8 text-ink-faint" strokeWidth={1.5} />
                        <p className="text-sm font-medium text-ink">No billing entries yet</p>
                        <p className="max-w-xs text-xs text-ink-faint">
                          Billing data appears here once an organization subscribes to a plan through Stripe.
                        </p>
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {extend.isError && (
        <ErrorView error={extend.error} title="Could not extend the grace period" />
      )}

      {/* A support-ticket override, not a way to mark an org paid — this
          writes billing_grace_ends_at alone, never billing_status. */}
      {billingDetailOrgId !== null && (
        <OrgDetailDialog
          orgId={billingDetailOrgId}
          onClose={() => {
            setBillingDetailOrgId(null);
          }}
        />
      )}

      {extendTarget !== null && (
        <ModalRoot
          open
          onOpenChange={(next) => {
            if (!next) setExtendTarget(null);
          }}
        >
          <ModalContent size="sm" className="p-4">
            <ModalTitle>Extend grace period for {extendTarget.name}?</ModalTitle>
            <ModalDescription>
              Pushes the deadline before this organization is locked out for non-payment. This does
              not mark the organization as paid — only Stripe, or the organization&rsquo;s own owner
              completing checkout, does that.
            </ModalDescription>

            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const days = Number.parseInt(extendByDays, 10);
                if (Number.isInteger(days) && days > 0) {
                  extend.mutate({ orgId: extendTarget.orgId as OrgId, extendByDays: days });
                }
              }}
            >
              <Field label="Extend by (days)" htmlFor="extend-by-days">
                <Input
                  id="extend-by-days"
                  type="number"
                  min={1}
                  max={90}
                  value={extendByDays}
                  onChange={(event) => {
                    setExtendByDays(event.target.value);
                  }}
                />
              </Field>

              <div className="flex gap-2">
                <Button type="submit" variant="primary" disabled={extend.isPending}>
                  {extend.isPending ? 'Extending…' : 'Extend'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setExtendTarget(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </ModalContent>
        </ModalRoot>
      )}

      <div className="mt-3">
        <Pagination
          hasMore={cursor !== null || (billing.data?.nextCursor ?? null) !== null}
          onNewest={() => {
            setCursor(null);
          }}
          onOlder={() => {
            setCursor(billing.data?.nextCursor ?? null);
          }}
        />
      </div>
    </section>
  );
}

function BillingStatusBadge({ billingStatus }: { readonly billingStatus: string }) {
  if (billingStatus === 'active') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
        <span className="size-1.5 rounded-full bg-success" />
        active
      </span>
    );
  }
  if (billingStatus === 'trialing') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken px-2 py-0.5 text-xs font-medium text-ink-faint">
        trial
      </span>
    );
  }
  if (billingStatus === 'past_due') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
        <ShieldAlert className="size-3" strokeWidth={2.5} />
        past due
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-danger/30 bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
      canceled
    </span>
  );
}
