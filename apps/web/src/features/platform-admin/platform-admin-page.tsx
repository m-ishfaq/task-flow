import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Building2,
  ChevronDown,
  CreditCard,
  Flag,
  LayoutGrid,
  Megaphone,
  Palette,
  Shield,
  TerminalSquare,
  Users,
  Zap,
  type LucideProps,
} from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { cn } from '../../lib/cn.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
import { Button } from '../../components/primitives.js';
import { useStepUp } from '../auth/use-step-up.js';
import { StepUpDialog } from '../auth/step-up.js';
import { downloadCsv, money } from './shared.js';
import { BroadcastTab } from './broadcast-tab.js';
import { OrgsTab } from './orgs-tab.js';
import { UsersTab } from './users-tab.js';
import { FlagsTab } from './flags-tab.js';
import { BrandingTab } from './branding-tab.js';
import { PlansTab } from './plans-tab.js';
import { AuditTab } from './audit-tab.js';
import { OperationsTab } from './operations-tab.js';
import { BillingTab } from './billing-tab.js';
import { AiTab } from './ai-tab.js';

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
 *
 * ## Layout of this feature
 *
 * This file is the page shell only (state, summary metrics, the section
 * nav). Each section, its dialogs, and the primitives/formatters they share
 * were split out of what used to be one ~4,900-line file (mechanical
 * extraction, no behavior changes): `shared.tsx` for cross-section
 * primitives and the two dialogs opened from more than one section, and one
 * file per section otherwise.
 *
 * ## A genuinely distinct console, not the product with a tab strip
 *
 * Reported directly: this page "looks like it is part of the same client
 * side... not up to the mark for the SaaS product we are building." It was,
 * by construction — a `PageContainer`/`PageHeader` shell and a horizontal
 * tab strip identical in shape to every board and settings page, painted
 * red on the active tab as the one signal this was a different surface.
 * Two changes answer it: a persistent left sidebar in place of that tab
 * strip (structurally unmistakable from an ordinary content page at a
 * glance, and the standard shape for an operator/admin console generally),
 * and `body.platform-admin-active` (`styles.css`, toggled by `Shell`) —
 * a colder, darker, near-neutral palette scoped under that class so this
 * page's own surfaces read as a distinct console rather than the product's
 * own theme reused.
 *
 * ## The safety signal — restored, redesigned, not a boxed alarm
 *
 * An earlier pass added a permanent "acting across all organizations, every
 * action is logged" strip — a filled `bg-danger/10` box with a left border
 * and an `AlertTriangle` glyph, in the sidebar footer (desktop) and the
 * compact bar (mobile below `md:`). Reported back directly as reading like
 * an alarm rather than a place, and removed outright.
 *
 * Reversed on further review: the signal itself was right, only its
 * treatment was wrong. A cross-tenant tool where one click changes another
 * company's access genuinely needs a reminder that cannot be missed — that
 * is a security-communication control, not decoration, and this page's own
 * sidebar/cold-palette identity making the console feel DIFFERENT was never
 * the same claim as making the STAKES visible. What actually read as an
 * alarm was the filled color box and the triangle glyph competing for
 * attention with everything else on the page, not the fact of the message
 * itself.
 *
 * The redesign keeps the message and drops the box: a hairline danger-tinted
 * top edge on the whole console frame (below, on the outermost wrapper) as
 * an ambient, always-present cue that costs nothing to look at, plus one
 * slim status line — a small solid dot and a single sentence in the
 * console's own muted type, never a filled background or an alert icon —
 * directly under the identity block on both the desktop sidebar and the
 * mobile compact bar (never gated behind the mobile nav toggle, matching
 * this file's own long-standing rule that the one thing meant to be
 * impossible to forget should not be one tap from hidden). Nothing about the
 * access model changes either way: `platformRoute` still gates every query
 * and mutation behind this page, step-up included, reads included (this
 * file's own header above), whether or not this signal is on screen at all.
 */
const NAV_ITEMS = [
  ['orgs', 'Organizations', Building2],
  ['users', 'Users', Users],
  ['plans', 'Plans', LayoutGrid],
  ['billing', 'Billing', CreditCard],
  ['ai', 'AI Models', Bot],
  ['flags', 'Feature flags', Flag],
  ['branding', 'Branding', Palette],
  ['broadcast', 'Broadcast', Megaphone],
  ['audit', 'Operator audit', Shield],
  ['operations', 'Operations', Zap],
] as const satisfies readonly (readonly [
  PlatformAdminTab,
  string,
  React.ComponentType<LucideProps>,
])[];

type PlatformAdminTab =
  | 'orgs'
  | 'users'
  | 'plans'
  | 'billing'
  | 'ai'
  | 'flags'
  | 'branding'
  | 'broadcast'
  | 'audit'
  | 'operations';

export function PlatformAdminPage() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [gateOpen, setGateOpen] = useState(false);
  const [tab, setTab] = useState<PlatformAdminTab>('orgs');

  /**
   * A permanent left sidebar reported as unusable below `md`: at phone width
   * a fixed `w-60` column left the actual content squeezed into what was
   * left of the screen, which is where the visible symptoms (a search input
   * truncated to "Filte…", "Export CSV" wrapping onto two lines, a metrics
   * row with ragged blank gaps where a row of cells wrapped short) all
   * traced back to — not bugs in those controls, but in never having given
   * them room. `useIsDesktop()` is the same 768px `md:` breakpoint
   * `board-page.tsx`'s own toolbar-collapse and `calendar-view.tsx`'s own
   * month-grid/agenda-list swap already coordinate against, reused rather
   * than a new breakpoint invented for this one page. Below it, the sidebar
   * does not render at all — the content pane gets the full width back —
   * and `navOpen` (mirroring `board-page.tsx`'s own `toolbarExpanded`)
   * gates a compact, collapsible nav list in its place.
   */
  const isDesktop = useIsDesktop();
  const [navOpen, setNavOpen] = useState(false);
  const currentLabel = NAV_ITEMS.find(([value]) => value === tab)?.[1] ?? '';

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

  const exportButton = (
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
  );

  return (
    /* The hairline top edge is the "ambient, always-present" half of the
       safety signal — see this file's own header comment. A 2px border
       rather than a filled bar: at low opacity it reads as a considered
       accent line the way this app's own elevation system already uses
       edges and shadows to signal depth, not as a second alert box stacked
       on top of the status line below it. */
    <div className="flex h-full overflow-hidden border-t-2 border-danger/40 text-ink">
      {/* The sidebar, replacing the horizontal tab strip — see this file's
          own header comment for why a structural change, not just a color
          swap, is what actually answers "looks like the same client". Only
          at `md:` and above: below it, the compact bar in the content pane
          takes over navigation, per the `isDesktop`/`navOpen` comment on
          this component's own state. */}
      {isDesktop && (
        <aside className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-sunken">
          <div className="flex items-center gap-2.5 border-b border-line px-4 py-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-ink-muted">
              <TerminalSquare aria-hidden="true" className="size-4.5" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-ink">Operator console</p>
              <p className="truncate font-mono text-[10px] text-ink-faint">
                taskflow_platform_admin
              </p>
            </div>
          </div>

          {/* The status line — see this file's own header comment. One
              sentence, one small solid dot, the console's own muted type:
              no filled background, no alert icon. `border-b` rather than
              its own boxed panel, so it reads as part of the identity
              block above it, not a second, separate notice. */}
          <div className="flex items-center gap-2 border-b border-line px-4 py-2">
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-danger" />
            <p className="min-w-0 flex-1 text-xs leading-snug text-ink-faint">
              Acting across <span className="text-ink-muted">all organizations</span> — every action
              is logged
            </p>
          </div>

          <nav aria-label="Platform administration sections" className="flex-1 space-y-0.5 p-2">
            {NAV_ITEMS.map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-current={tab === value ? 'page' : undefined}
                onClick={() => {
                  setTab(value);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors duration-150',
                  tab === value
                    ? 'bg-accent/10 text-accent'
                    : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                )}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </nav>
        </aside>
      )}

      <div className="min-w-0 flex-1 overflow-y-auto">
        {/* The sidebar's mobile stand-in: a compact bar always shown, an
            optional expanded section list, and the same safety notice,
            never gated behind the toggle — the one thing that is supposed
            to be impossible to forget should not be one tap from hidden. */}
        {!isDesktop && (
          <div className="border-b border-line bg-surface-sunken">
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-surface-hover text-ink-muted">
                <TerminalSquare aria-hidden="true" className="size-3.5" strokeWidth={2} />
              </span>
              <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                Operator console
              </p>
              <button
                type="button"
                aria-expanded={navOpen}
                aria-label={navOpen ? 'Hide sections' : 'Show sections'}
                onClick={() => {
                  setNavOpen((previous) => !previous);
                }}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line/60 bg-surface/40 px-2.5 text-xs font-medium text-ink-muted transition-colors duration-(--motion-fast) hover:bg-surface-hover hover:text-ink"
              >
                {currentLabel}
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'size-3.5 transition-transform duration-(--motion-fast)',
                    navOpen && 'rotate-180',
                  )}
                />
              </button>
            </div>

            {/* Same status line as the desktop sidebar, and for the same
                reason placed OUTSIDE `navOpen` below — never gated behind
                the collapse toggle. */}
            <div className="flex items-center gap-2 border-t border-line/70 px-3 py-1.5">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-danger" />
              <p className="min-w-0 flex-1 truncate text-xs text-ink-faint">
                Acting across <span className="text-ink-muted">all organizations</span> — every
                action is logged
              </p>
            </div>

            {navOpen && (
              <nav
                aria-label="Platform administration sections"
                className="space-y-0.5 border-t border-line/60 p-2"
              >
                {NAV_ITEMS.map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    aria-current={tab === value ? 'page' : undefined}
                    onClick={() => {
                      setTab(value);
                      setNavOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium transition-colors duration-150',
                      tab === value
                        ? 'bg-accent/10 text-accent'
                        : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}

        <div className="mx-auto max-w-[85%] space-y-5 px-4 py-4 sm:px-6 sm:py-6">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold tracking-tight text-ink">
                Platform administration
              </h1>
              <p className="mt-0.5 text-[13px] text-ink-muted">
                Every organization, user, and release flag — nothing on this page is scoped to one
                tenant.
              </p>
            </div>
            {hasExportData && exportButton}
          </header>

          {/* Metrics strip — a CSS grid, not a `flex-wrap` row: a wrapped
              flex row leaves whatever blank space is left in a short last
              row untouched, which is exactly the ragged gap reported
              alongside the sidebar bug. A grid's cells always fill their
              column tracks, wrapped or not. Hairlines are drawn with a
              `gap-px` background peeking through opaque cells (`bg-line`
              behind, `bg-surface-raised` on each `ConsoleMetric`) rather
              than `divide-x`/`divide-y`, since dividers alone don't draw a
              line under a row that isn't full. */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
            <ConsoleMetric label="Orgs" value={totalOrgs} />
            <ConsoleMetric label="Active" value={activeOrgs} />
            <ConsoleMetric label="Users" value={totalUsers} />
            <ConsoleMetric label="Members" value={totalMembers} />
            <ConsoleMetric label="MRR" value={`$${String(mrr / 100)}`} />
            <ConsoleMetric label="Trials" value={trials} />
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
              guard={guard}
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
          {tab === 'ai' && (
            <AiTab
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
          {tab === 'broadcast' && (
            <BroadcastTab
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
        </div>
      </div>

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
 * One metric in the summary strip — a label and a monospaced, tabular
 * number, no icon square or card chrome. `platform-admin-page.tsx`'s own
 * header explains why this replaced six individual `StatCard`s: a status
 * bar an operator scans at a glance, not the product's own dashboard-widget
 * language reused for a different surface.
 */
function ConsoleMetric({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number;
}) {
  return (
    <div className="min-w-0 bg-surface-raised px-3 py-2.5 sm:px-4">
      <p className="truncate text-[10px] font-medium uppercase tracking-wider text-ink-faint">
        {label}
      </p>
      <p className="truncate font-mono text-base font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}
