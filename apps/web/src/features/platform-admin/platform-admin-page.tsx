import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Menu } from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Button } from '../../components/primitives.js';
import { useStepUp } from '../auth/use-step-up.js';
import { StepUpDialog } from '../auth/step-up.js';
import { downloadCsv, money } from './shared.js';
import { PlatformSidebar } from './platform-sidebar.js';
import { useIsDesktop } from '../../lib/use-media-query.js';
import { cn } from '../../lib/cn.js';
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
import { ErrorsTab } from './errors-tab.js';
import { DashboardTab } from './dashboard-tab.js';
import { ConfigTab } from './config-tab.js';

/**
 * ## Platform Admin Page — premium responsive layout
 *
 * Mobile: hamburger → fixed drawer overlay (dark sidebar slides in from left).
 * Desktop: static collapsible sidebar on the left, content fills remaining space.
 *
 * The drawer auto-closes on navigation (mobile only). Escape closes it too.
 * Focus management matches the member shell's drawer pattern.
 */
export type PlatformTab =
  | 'dashboard'
  | 'orgs'
  | 'users'
  | 'plans'
  | 'billing'
  | 'ai'
  | 'flags'
  | 'branding'
  | 'broadcast'
  | 'audit'
  | 'operations'
  | 'errors'
  | 'config';

export function PlatformAdminPage() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [gateOpen, setGateOpen] = useState(false);
  const [tab, setTab] = useState<PlatformTab>('dashboard');
  const isDesktop = useIsDesktop();

  /* Mobile drawer state */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  /* Escape closes the drawer */
  useEffect(() => {
    if (!drawerOpen) return undefined;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setDrawerOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [drawerOpen]);

  /* Focus management for drawer */
  useEffect(() => {
    if (drawerOpen) {
      previouslyFocused.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      drawerRef.current?.focus();
    } else {
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    }
  }, [drawerOpen]);

  /* Navigate with drawer close */
  const navigate = (t: PlatformTab) => {
    setTab(t);
    if (!isDesktop) setDrawerOpen(false);
  };

  /* Step-up gate */
  const onProof = () => {
    setGateOpen(false);
    void queryClient.invalidateQueries({ queryKey: ['platform'] });
  };

  /* Summary stats */
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

  const hasExportData =
    (orgs.data?.orgs.length ?? 0) > 0 ||
    (users.data?.users.length ?? 0) > 0 ||
    (billing.data?.orgs.length ?? 0) > 0;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-surface">
      {/* ── Mobile backdrop — tap outside to dismiss.
           Matches shell.tsx's own backdrop: same z-index, same `bg-overlay`,
           same click-to-close. The sidebar (z-40) sits above this; anything
           to the RIGHT of the sidebar hits this div and closes the drawer. */}
      {drawerOpen && (
        <div
          aria-hidden="true"
          onClick={() => {
            setDrawerOpen(false);
          }}
          className="fixed inset-0 z-30 bg-overlay md:hidden"
        />
      )}

      {/* ── Mobile drawer sidebar ── */}
      <div
        ref={drawerRef}
        tabIndex={-1}
        inert={!drawerOpen}
        className={cn(
          'md:hidden',
          'fixed inset-y-0 left-0 z-40 w-64 transition-transform duration-200',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <PlatformSidebar
          activeTab={tab}
          onNavigate={(t) => {
            navigate(t as PlatformTab);
          }}
          isMobileDrawer
          onCloseMobile={() => {
            setDrawerOpen(false);
          }}
        />
      </div>

      {/* ── Desktop static sidebar ── */}
      <div className="hidden md:block">
        <PlatformSidebar
          activeTab={tab}
          onNavigate={(t) => {
            navigate(t as PlatformTab);
          }}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => {
            setSidebarCollapsed((c) => !c);
          }}
        />
      </div>

      {/* ── Content area ── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Sticky top bar */}
        <div className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line/50 bg-surface/90 px-4 backdrop-blur-md">
          {/* Mobile hamburger */}
          <button
            type="button"
            onClick={() => {
              setDrawerOpen(true);
            }}
            aria-label="Open navigation"
            className="-ml-1 shrink-0 rounded-lg p-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink md:hidden"
          >
            <Menu aria-hidden="true" className="size-5" strokeWidth={2} />
          </button>

          {/* Page title */}
          <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink">
            {tab === 'dashboard' && 'Dashboard'}
            {tab === 'orgs' && 'Organizations'}
            {tab === 'users' && 'Users'}
            {tab === 'plans' && 'Plans'}
            {tab === 'billing' && 'Billing'}
            {tab === 'ai' && 'AI Models'}
            {tab === 'flags' && 'Feature Flags'}
            {tab === 'branding' && 'Branding'}
            {tab === 'broadcast' && 'Broadcast'}
            {tab === 'audit' && 'Audit Log'}
            {tab === 'operations' && 'Operations'}
            {tab === 'errors' && 'Error Health'}
            {tab === 'config' && 'Configuration'}
          </h1>

          {/* Export button (desktop only, orgs tab) */}
          {hasExportData && tab === 'orgs' && (
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
              <Download className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Export CSVs</span>
            </Button>
          )}
        </div>

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-5">
            {/* Tab subtitle */}
            <p className="text-[13px] text-ink-muted">
              {tab === 'dashboard' && 'Platform health at a glance.'}
              {tab === 'orgs' &&
                'Every organization in the platform. Click an org to inspect its health and activity.'}
              {tab === 'users' && 'All registered users across every organization.'}
              {tab === 'plans' && 'The plan catalog and per-org entitlement overrides.'}
              {tab === 'billing' && 'Revenue, subscriptions, and invoices.'}
              {tab === 'ai' && 'Provider catalog, per-org overrides, and spend.'}
              {tab === 'flags' && 'Global feature flag overrides.'}
              {tab === 'branding' && 'Product name and color palette.'}
              {tab === 'broadcast' && 'Send a message to one or more organizations.'}
              {tab === 'audit' && 'The accountability record of every operator action.'}
              {tab === 'operations' && 'System-action outcomes across every process.'}
              {tab === 'errors' && 'Per-org error rates, trends, and velocity tracking.'}
              {tab === 'config' &&
                'Platform identity, infrastructure status, and feature flag overview.'}
            </p>

            {/* Tab content */}
            {tab === 'dashboard' && (
              <DashboardTab
                onNavigate={(t) => {
                  navigate(t as PlatformTab);
                }}
                onStepUp={() => {
                  setGateOpen(true);
                }}
              />
            )}
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
            {tab === 'errors' && (
              <ErrorsTab
                onStepUp={() => {
                  setGateOpen(true);
                }}
              />
            )}
            {tab === 'config' && (
              <ConfigTab
                onStepUp={() => {
                  setGateOpen(true);
                }}
              />
            )}

            {/* Step-up dialogs */}
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
        </div>
      </div>
    </div>
  );
}
