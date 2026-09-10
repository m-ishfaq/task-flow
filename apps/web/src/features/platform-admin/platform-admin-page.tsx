import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Building2,
  CreditCard,
  Flag,
  LayoutGrid,
  Megaphone,
  Palette,
  Shield,
  Users,
  Zap,
} from 'lucide-react';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { formatDate } from '../../lib/format.js';
import { Button, PageHeader, TabBar } from '../../components/primitives.js';
import { useStepUp } from '../auth/use-step-up.js';
import { StepUpDialog } from '../auth/step-up.js';
import { StatCard, downloadCsv, money } from './shared.js';
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
 * This file is the page shell only (state, summary stats, the tab switcher).
 * Each tab, its dialogs, and the primitives/formatters they share were split
 * out of what used to be one ~4,900-line file (mechanical extraction, no
 * behavior changes): `shared.tsx` for cross-tab primitives and the two
 * dialogs opened from more than one tab, and one file per tab otherwise.
 */
export function PlatformAdminPage() {
  const queryClient = useQueryClient();
  const { guard, dialog } = useStepUp();
  const [gateOpen, setGateOpen] = useState(false);
  const [tab, setTab] = useState<
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

      {/* §18's operator band: the danger-toned scope notice that makes it
          impossible to forget this is a cross-tenant tool. The org admin
          console (settings-page) stays deliberately neutral — only THIS page
          wears the warning. */}
      <div
        role="note"
        className="flex items-center gap-3 rounded-xl border border-danger/40 border-l-4 bg-danger/8 px-4 py-2.5"
      >
        <Shield aria-hidden="true" className="size-4 shrink-0 text-danger" strokeWidth={2} />
        <p className="text-xs leading-relaxed text-ink">
          <span className="font-semibold text-danger">Operator mode</span> — you’re acting across
          all organizations as{' '}
          <span className="font-mono text-[13px] text-ink-muted">taskflow_platform_admin</span>.{' '}
          <span className="text-ink-muted">Every action is logged.</span>
        </p>
      </div>

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
      <TabBar
        className="sticky top-0 z-10 shadow-sm"
        ariaLabel="Platform administration sections"
        items={(
          [
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
          ] as const
        ).map(([value, label, Icon]) => [value, label, Icon] as const)}
        value={tab}
        onChange={setTab}
      />

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
