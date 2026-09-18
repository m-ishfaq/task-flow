import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FolderKanban,
  MessageSquare,
  FileText,
  Phone,
  Settings,
  Sparkles,
  Search,
  Shield,
  GitPullRequest,
  Lock,
  Check,
  Eye,
  Pencil,
  Trash2,
  Plus,
  Move,
  Download,
  Upload,
  Send,
  Users,
  CreditCard,
  Key,
  Globe,
  Zap,
  Mic,
  CircleDot,
} from 'lucide-react';
import {
  PERMISSIONS,
  RESOURCE_TYPES,
  ROLE_PERMISSIONS,
  type Permission,
  type ResourceType,
  type Role,
} from '@taskflow/policy';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { useBranding } from '../../lib/branding-context.js';
import { wire } from '@taskflow/client';
import { cn } from '../../lib/cn.js';
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  PageHeader,
  SearchInput,
  Section,
  Spinner,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { membersQuery, memberGrantsQuery, orgDetailQuery } from '../org/api.js';

/* -------------------------------------------------------------------------- */
/*  Permission guide mapping — what each permission means in plain language    */
/* -------------------------------------------------------------------------- */

type ModuleId =
  | 'work'
  | 'chat'
  | 'docs'
  | 'collaboration'
  | 'calls'
  | 'settings'
  | 'ai'
  | 'platform'
  | 'compliance'
  | 'search';

interface PermissionEntry {
  readonly label: string;
  readonly description: string;
  readonly location: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly module: ModuleId;
}

const MODULE_META: Readonly<
  Record<
    ModuleId,
    { readonly label: string; readonly icon: React.ComponentType<{ className?: string }> }
  >
> = {
  work: { label: 'Work', icon: FolderKanban },
  chat: { label: 'Chat', icon: MessageSquare },
  docs: { label: 'Docs', icon: FileText },
  collaboration: { label: 'Collaboration', icon: Users },
  calls: { label: 'Calls & Messaging', icon: Phone },
  settings: { label: 'Organization', icon: Settings },
  ai: { label: 'AI Copilot', icon: Sparkles },
  platform: { label: 'Platform', icon: Zap },
  compliance: { label: 'Compliance', icon: Shield },
  search: { label: 'Search', icon: Search },
};

const PERMISSION_GUIDE: Readonly<Record<Permission, PermissionEntry>> = {
  // — Work —
  'org:read': {
    label: 'View organization',
    description: 'See your org in the sidebar and switch between orgs.',
    location: 'Sidebar → Org switcher',
    icon: Eye,
    module: 'settings',
  },
  'org:update': {
    label: 'Update organization',
    description: 'Rename the org, change its slug, and manage billing settings.',
    location: 'Settings → Organization',
    icon: Pencil,
    module: 'settings',
  },
  'org:delete': {
    label: 'Delete organization',
    description: 'Permanently remove the org and all its data. Irreversible.',
    location: 'Settings → Organization → Danger zone',
    icon: Trash2,
    module: 'settings',
  },
  'org:billing': {
    label: 'Manage billing',
    description: 'View plans, invoices, and manage the subscription.',
    location: 'Settings → Billing',
    icon: CreditCard,
    module: 'settings',
  },

  'member:read': {
    label: 'View members',
    description: 'See the list of people in your organization and their roles.',
    location: 'Settings → Members',
    icon: Users,
    module: 'settings',
  },
  'member:invite': {
    label: 'Invite members',
    description: 'Send email invitations to join the organization.',
    location: 'Settings → Members → Invite',
    icon: Send,
    module: 'settings',
  },
  'member:manage': {
    label: 'Manage members',
    description: 'Change roles, transfer ownership, and manage individual permission grants.',
    location: 'Settings → Members',
    icon: Settings,
    module: 'settings',
  },
  'member:remove': {
    label: 'Remove members',
    description: 'Remove someone from the organization entirely.',
    location: 'Settings → Members → Remove',
    icon: Trash2,
    module: 'settings',
  },

  'team:read': {
    label: 'View teams',
    description: 'See the list of teams in your organization.',
    location: 'Settings → Teams',
    icon: Users,
    module: 'settings',
  },
  'team:manage': {
    label: 'Manage teams',
    description: 'Create, rename, and delete teams; add or remove members.',
    location: 'Settings → Teams',
    icon: Settings,
    module: 'settings',
  },

  'project:read': {
    label: 'View projects',
    description: 'See projects in the sidebar and open their boards.',
    location: 'Sidebar → Projects',
    icon: Eye,
    module: 'work',
  },
  'project:create': {
    label: 'Create projects',
    description: 'Start a new project with its own boards, labels, and statuses.',
    location: 'Projects → New project',
    icon: Plus,
    module: 'work',
  },
  'project:update': {
    label: 'Update projects',
    description: 'Rename projects, manage labels, statuses, and custom fields.',
    location: 'Project settings',
    icon: Pencil,
    module: 'work',
  },
  'project:delete': {
    label: 'Delete projects',
    description: 'Archive or permanently remove a project and all its cards.',
    location: 'Project settings → Danger zone',
    icon: Trash2,
    module: 'work',
  },

  'board:read': {
    label: 'View boards',
    description: 'Open a board and see its cards in any view.',
    location: 'Project → Board',
    icon: Eye,
    module: 'work',
  },
  'board:create': {
    label: 'Create boards',
    description: 'Add a new board to a project.',
    location: 'Project settings → Boards',
    icon: Plus,
    module: 'work',
  },
  'board:update': {
    label: 'Update boards',
    description: 'Rename a board, change its default view, or manage columns.',
    location: 'Board → Settings',
    icon: Pencil,
    module: 'work',
  },
  'board:delete': {
    label: 'Delete boards',
    description: 'Archive or remove a board from a project.',
    location: 'Board settings',
    icon: Trash2,
    module: 'work',
  },

  'card:read': {
    label: 'View cards',
    description: 'Open cards and see their details, comments, and history.',
    location: 'Board → Card',
    icon: Eye,
    module: 'work',
  },
  'card:create': {
    label: 'Create cards',
    description: 'Add new cards to any list on the board.',
    location: 'Board → List → + card',
    icon: Plus,
    module: 'work',
  },
  'card:update': {
    label: 'Edit cards',
    description: 'Change title, description, priority, dates, labels, and assignees.',
    location: 'Card detail panel',
    icon: Pencil,
    module: 'work',
  },
  'card:move': {
    label: 'Move cards',
    description: 'Drag cards between lists or boards.',
    location: 'Board → Drag card',
    icon: Move,
    module: 'work',
  },
  'card:delete': {
    label: 'Delete cards',
    description: 'Archive cards to hide them from the board.',
    location: 'Card detail → Archive',
    icon: Trash2,
    module: 'work',
  },

  // — Chat —
  'channel:read': {
    label: 'View channels',
    description: 'See and open chat channels and DMs.',
    location: 'Sidebar → Chat',
    icon: Eye,
    module: 'chat',
  },
  'channel:create': {
    label: 'Create channels',
    description: 'Start a new channel for the team.',
    location: 'Chat → New channel',
    icon: Plus,
    module: 'chat',
  },
  'channel:manage': {
    label: 'Manage channels',
    description: 'Rename channels, manage members, and set retention.',
    location: 'Channel → Details',
    icon: Settings,
    module: 'chat',
  },

  'message:read': {
    label: 'Read messages',
    description: 'See messages in channels you belong to.',
    location: 'Chat → Channel',
    icon: Eye,
    module: 'chat',
  },
  'message:create': {
    label: 'Send messages',
    description: 'Write and send messages, start conversations.',
    location: 'Chat → Composer',
    icon: Send,
    module: 'chat',
  },
  'message:update': {
    label: 'Edit messages',
    description: 'Edit your own messages after sending.',
    location: 'Chat → Your message → Edit',
    icon: Pencil,
    module: 'chat',
  },
  'message:delete': {
    label: 'Moderate messages',
    description: 'Delete any message in a channel (moderation power).',
    location: 'Chat → Message → Delete',
    icon: Trash2,
    module: 'chat',
  },

  // — Docs —
  'space:read': {
    label: 'View spaces',
    description: 'See and open Docs spaces.',
    location: 'Sidebar → Docs',
    icon: Eye,
    module: 'docs',
  },
  'space:create': {
    label: 'Create spaces',
    description: 'Start a new Docs space for documentation.',
    location: 'Docs → New space',
    icon: Plus,
    module: 'docs',
  },
  'space:manage': {
    label: 'Manage spaces',
    description: 'Rename spaces, manage permissions, and control sharing.',
    location: 'Space settings',
    icon: Settings,
    module: 'docs',
  },

  'page:read': {
    label: 'Read pages',
    description: 'Open and read pages in a Docs space.',
    location: 'Docs → Page',
    icon: Eye,
    module: 'docs',
  },
  'page:create': {
    label: 'Create pages',
    description: 'Add new pages to a Docs space.',
    location: 'Docs → Space → + page',
    icon: Plus,
    module: 'docs',
  },
  'page:update': {
    label: 'Edit pages',
    description: 'Write and edit page content using the rich text editor.',
    location: 'Docs → Page → Edit',
    icon: Pencil,
    module: 'docs',
  },
  'page:delete': {
    label: 'Delete pages',
    description: 'Archive or remove pages from a Docs space.',
    location: 'Docs → Page → Delete',
    icon: Trash2,
    module: 'docs',
  },

  // — Collaboration —
  'comment:create': {
    label: 'Add comments',
    description: 'Comment on cards and pages.',
    location: 'Card detail → Comments',
    icon: MessageSquare,
    module: 'collaboration',
  },
  'comment:delete': {
    label: 'Delete comments',
    description: 'Remove any comment (moderation).',
    location: 'Comment → Delete',
    icon: Trash2,
    module: 'collaboration',
  },
  'attachment:upload': {
    label: 'Upload files',
    description: 'Attach files to cards and pages.',
    location: 'Card detail → Attachments',
    icon: Upload,
    module: 'collaboration',
  },
  'attachment:download': {
    label: 'Download files',
    description: 'Download attached files from cards and pages.',
    location: 'Card detail → Attachments → Download',
    icon: Download,
    module: 'collaboration',
  },

  // — Platform —
  'automation:manage': {
    label: 'Manage automations',
    description: 'Create and edit automation rules.',
    location: 'Automations → Rules',
    icon: Zap,
    module: 'platform',
  },
  'webhook:manage': {
    label: 'Manage webhooks',
    description: 'Configure webhook endpoints for integrations.',
    location: 'Automations → Webhooks',
    icon: Globe,
    module: 'platform',
  },
  'integration:manage': {
    label: 'Manage integrations',
    description: 'Connect and configure third-party integrations (GitHub, Slack).',
    location: 'Automations → Integrations',
    icon: Settings,
    module: 'platform',
  },
  'apiToken:create': {
    label: 'Create API tokens',
    description: 'Generate API tokens for programmatic access.',
    location: 'Automations → API tokens',
    icon: Key,
    module: 'platform',
  },
  'apiToken:revoke': {
    label: 'Revoke API tokens',
    description: 'Invalidate API tokens no longer in use.',
    location: 'Automations → API tokens',
    icon: Trash2,
    module: 'platform',
  },

  // — Calls —
  'phoneNumber:read': {
    label: 'View phone numbers',
    description: "See the org's purchased phone numbers.",
    location: 'Calls → Numbers',
    icon: Phone,
    module: 'calls',
  },
  'phoneNumber:purchase': {
    label: 'Purchase numbers',
    description: 'Buy new phone numbers for the org.',
    location: 'Calls → Numbers → Buy',
    icon: Plus,
    module: 'calls',
  },
  'phoneNumber:release': {
    label: 'Release numbers',
    description: 'Release phone numbers back to the carrier.',
    location: 'Calls → Numbers → Release',
    icon: Trash2,
    module: 'calls',
  },
  'call:place': {
    label: 'Place calls',
    description: "Make outbound phone calls through the org's numbers.",
    location: 'Calls → Dialer',
    icon: Phone,
    module: 'calls',
  },
  'call:read': {
    label: 'View call history',
    description: "See the org's call log with durations and participants.",
    location: 'Calls → History',
    icon: Eye,
    module: 'calls',
  },
  'sms:send': {
    label: 'Send SMS',
    description: "Send text messages through the org's numbers.",
    location: 'Calls → Messages → Compose',
    icon: Send,
    module: 'calls',
  },
  'sms:read': {
    label: 'View SMS history',
    description: "See the org's text message threads.",
    location: 'Calls → Messages',
    icon: Eye,
    module: 'calls',
  },
  'recording:read': {
    label: 'View recordings',
    description: 'Listen to call recordings and read transcripts.',
    location: 'Calls → Recordings',
    icon: Mic,
    module: 'calls',
  },
  'recording:export': {
    label: 'Export recordings',
    description: 'Download call recordings for compliance or archival.',
    location: 'Calls → Recordings → Export',
    icon: Download,
    module: 'calls',
  },

  // — Platform —
  'analytics:read': {
    label: 'View analytics',
    description: 'Access dashboards for velocity, burndown, cycle time, and workload.',
    location: 'Sidebar → Analytics',
    icon: CircleDot,
    module: 'platform',
  },

  // — Compliance —
  'audit:read': {
    label: 'View audit log',
    description: "See the org's audit trail of who did what and when.",
    location: 'Settings → Audit log',
    icon: Eye,
    module: 'compliance',
  },
  'audit:export': {
    label: 'Export audit log',
    description: 'Download the audit log for compliance reporting.',
    location: 'Settings → Audit log → Export',
    icon: Download,
    module: 'compliance',
  },

  // — Search —
  'search:query': {
    label: 'Search content',
    description: 'Search across cards, messages, pages, and comments.',
    location: 'Search bar (⌘K)',
    icon: Search,
    module: 'search',
  },
  'search:manage': {
    label: 'Share saved searches',
    description: 'Pin saved searches for the whole organization to see.',
    location: 'Search → Save → Share',
    icon: Settings,
    module: 'search',
  },

  // — AI —
  'ai:use': {
    label: 'Use AI Copilot',
    description: 'Open the assistant and ask questions about your projects.',
    location: 'Sidebar → Assistant',
    icon: Sparkles,
    module: 'ai',
  },

  // — GitHub/PR —
  'pr:view': {
    label: 'View pull requests',
    description: 'See linked PRs on cards and browse PR diffs.',
    location: 'Card → Development section',
    icon: GitPullRequest,
    module: 'platform',
  },
  'pr:review': {
    label: 'Review pull requests',
    description: 'Post review comments and request changes on PRs.',
    location: 'Card → PR → Comment',
    icon: MessageSquare,
    module: 'platform',
  },
  'pr:merge': {
    label: 'Merge pull requests',
    description: 'Merge or close pull requests from within the app.',
    location: 'Card → PR → Merge',
    icon: GitPullRequest,
    module: 'platform',
  },
  'repo:connect': {
    label: 'Connect repositories',
    description: 'Link GitHub repos and create feature branches from cards.',
    location: 'Automations → Integrations → GitHub',
    icon: GitPullRequest,
    module: 'platform',
  },
} as const;

/** Module display order. */
const MODULE_ORDER: readonly ModuleId[] = [
  'work',
  'chat',
  'docs',
  'collaboration',
  'calls',
  'platform',
  'ai',
  'search',
  'settings',
  'compliance',
];

/* -------------------------------------------------------------------------- */
/*  Admin debugger (legacy) — gated inline, not page-level                    */
/* -------------------------------------------------------------------------- */

const LAYER_NAMES: Readonly<Record<number, string>> = {
  1: 'Membership',
  2: 'Role',
  3: 'Relationship tuples',
  4: 'Restrictions',
};

/* -------------------------------------------------------------------------- */
/*  Main page                                                                 */
/* -------------------------------------------------------------------------- */

export function PermissionDebugPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const userId = useSession((state) => state.userId) ?? '';
  const { productName } = useBranding();
  const org = useQuery(orgDetailQuery(orgId));
  const members = useQuery(membersQuery(orgId));
  const grants = useQuery(memberGrantsQuery(orgId));
  const capabilities = org.data?.capabilities;

  // Get my role from the members list (orgs.get doesn't include it)
  const me = members.data?.find((m) => m.userId === userId);
  const myRole = me?.role as Role | undefined;

  // The permissions my role grants
  const rolePermissions = myRole !== undefined ? ROLE_PERMISSIONS[myRole] : [];
  const roleSet = new Set(rolePermissions);

  // My individual grants (beyond role)
  const myGrants = (grants.data ?? []).filter((g) => g.userId === userId);
  const myGrantSet = new Set(myGrants.map((g) => g.permission as Permission));

  // Combined: role + individual grants
  const allMyPermissions = new Set([...roleSet, ...myGrantSet]);

  // Group permissions by module
  const modules = MODULE_ORDER.map((moduleId) => {
    const meta = MODULE_META[moduleId];
    const permissions = PERMISSIONS.filter((p) => PERMISSION_GUIDE[p].module === moduleId);
    return { moduleId, meta, permissions };
  }).filter((m) => m.permissions.length > 0);

  // Search filter
  const [search, setSearch] = useState('');

  const filteredModules = modules
    .map((m) => ({
      ...m,
      permissions: m.permissions.filter((p) => {
        if (search === '') return true;
        const entry = PERMISSION_GUIDE[p];
        const q = search.toLowerCase();
        return (
          entry.label.toLowerCase().includes(q) ||
          entry.description.toLowerCase().includes(q) ||
          p.toLowerCase().includes(q)
        );
      }),
    }))
    .filter((m) => m.permissions.length > 0);

  const totalAllowed = [...allMyPermissions].length;
  const totalPermissions = PERMISSIONS.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-5xl shrink-0 px-8 pt-8">
        <PageHeader
          title="Your Permissions"
          description={`What you can do in ${productName}, based on your ${myRole ?? '…'} role.`}
          actions={
            <div className="flex items-center gap-2">
              <Badge className="bg-accent/15 text-accent">
                {totalAllowed} of {totalPermissions}
              </Badge>
            </div>
          }
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8">
        <div className="mx-auto max-w-5xl">
          {/* Summary strip */}
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <div className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-accent" />
              <span className="text-ink-muted">
                Role: <span className="font-medium text-ink capitalize">{myRole ?? '…'}</span>
              </span>
            </div>
            {myGrants.length > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full bg-success" />
                <span className="text-ink-muted">
                  {myGrants.length} individual grant{myGrants.length === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </div>

          {/* Search */}
          <div className="mt-6">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Filter permissions…"
              className="max-w-sm"
            />
          </div>

          {/* Module sections */}
          <div className="mt-6 space-y-8">
            {filteredModules.map((m) => {
              const allowedCount = m.permissions.filter((p) => allMyPermissions.has(p)).length;
              return (
                <Section
                  key={m.moduleId}
                  title={m.meta.label}
                  count={allowedCount}
                  description={`${String(allowedCount)} of ${String(m.permissions.length)} permissions granted`}
                >
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {m.permissions.map((p) => {
                      const entry = PERMISSION_GUIDE[p];
                      const Icon = entry.icon;
                      const allowed = allMyPermissions.has(p);
                      const fromGrant = !roleSet.has(p) && myGrantSet.has(p);
                      return (
                        <div
                          key={p}
                          className={cn(
                            'group relative flex items-start gap-3 rounded-xl border p-4 transition-colors',
                            allowed
                              ? 'border-line/40 bg-surface-raised shadow-sm'
                              : 'border-line/30 bg-surface-sunken/40 opacity-60',
                          )}
                        >
                          <div
                            className={cn(
                              'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
                              allowed
                                ? 'bg-accent/15 text-accent'
                                : 'bg-surface-hover text-ink-faint',
                            )}
                          >
                            {allowed ? <Icon className="size-4" /> : <Lock className="size-3.5" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-ink">{entry.label}</p>
                              {fromGrant && (
                                <Badge className="bg-success/15 text-success text-[10px]">
                                  granted
                                </Badge>
                              )}
                            </div>
                            <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                              {entry.description}
                            </p>
                            <p className="mt-1.5 text-[11px] text-ink-faint">{entry.location}</p>
                          </div>
                          {allowed ? (
                            <Check className="mt-1 size-4 shrink-0 text-success" />
                          ) : (
                            <span className="mt-1 size-4 shrink-0" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Section>
              );
            })}

            {filteredModules.length === 0 && (
              <Empty
                title="No matching permissions"
                description={`No permissions match "${search}".`}
              />
            )}
          </div>

          {/* Admin debugger — collapsed, still gated on viewAuditLog */}
          {capabilities?.viewAuditLog === true && (
            <div className="mt-10">
              <AdminDebugger members={members.data ?? []} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Admin debugger — the old can() trace, collapsed by default                */
/* -------------------------------------------------------------------------- */

function AdminDebugger({
  members,
}: {
  readonly members: readonly {
    readonly userId: string;
    readonly email: string;
    readonly role: string;
  }[];
}) {
  const orgId = useSession((state) => state.orgId) ?? '';
  const [userId, setUserId] = useState('');
  const [permission, setPermission] = useState<Permission>('card:update');
  const [resourceType, setResourceType] = useState<ResourceType | ''>('');
  const [resourceId, setResourceId] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const input = {
    userId,
    permission,
    resourceType: resourceType === '' ? null : resourceType,
    resourceId: resourceId.trim() === '' ? null : resourceId.trim(),
  };

  const explanation = useQuery({
    queryKey: keys.explain(orgId, submitted ?? ''),
    queryFn: async () =>
      wire(
        await api.tenancy.authz.explain.query({
          ...input,
          userId: input.userId,
        }),
      ),
    enabled: submitted !== null && userId !== '',
  });

  return (
    <details className="rounded-xl border border-line/40 bg-surface-raised shadow-sm">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-muted hover:text-ink">
        Decision trace (admin debugger)
      </summary>
      <div className="space-y-4 border-t border-line/40 p-4">
        <p className="text-xs text-ink-muted">
          Runs the real policy engine for any user and shows every layer it consulted. This is the
          same <code className="text-xs">can()</code> that decides every request.
        </p>

        <form
          className="grid gap-3 rounded-lg border border-line/50 bg-surface-sunken p-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(JSON.stringify(input));
          }}
        >
          <Field label="User" htmlFor="debug-user">
            <select
              id="debug-user"
              value={userId}
              onChange={(event) => {
                setUserId(event.target.value);
              }}
              className="h-9 w-full rounded-lg border border-line/50 bg-surface px-2 text-sm text-ink"
            >
              <option value="">Select a member…</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.email} ({member.role})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Permission" htmlFor="debug-permission">
            <select
              id="debug-permission"
              value={permission}
              onChange={(event) => {
                setPermission(event.target.value as Permission);
              }}
              className="h-9 w-full rounded-lg border border-line/50 bg-surface px-2 text-sm text-ink"
            >
              {PERMISSIONS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Resource type"
            htmlFor="debug-resource-type"
            hint="Leave blank for org-level."
          >
            <select
              id="debug-resource-type"
              value={resourceType}
              onChange={(event) => {
                setResourceType(event.target.value as ResourceType | '');
              }}
              className="h-9 w-full rounded-lg border border-line/50 bg-surface px-2 text-sm text-ink"
            >
              <option value="">(none)</option>
              {RESOURCE_TYPES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Resource id"
            htmlFor="debug-resource-id"
            hint={
              resourceType === ''
                ? 'Pick a resource type first.'
                : `The ${resourceType} to ask about.`
            }
          >
            <Input
              id="debug-resource-id"
              placeholder="UUID"
              value={resourceId}
              disabled={resourceType === ''}
              className="font-mono text-xs"
              onChange={(event) => {
                setResourceId(event.target.value);
              }}
            />
          </Field>

          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" disabled={userId === ''}>
              Explain
            </Button>
          </div>
        </form>

        {submitted !== null && explanation.isFetching && <Spinner />}

        {explanation.isError && (
          <ErrorView error={explanation.error} title="Could not evaluate that permission" />
        )}

        {explanation.isSuccess && (
          <div className="space-y-4">
            <div
              className={cn(
                'flex items-start gap-3 rounded-lg border px-3 py-2.5',
                explanation.data.allowed
                  ? 'border-success/40 bg-success/10'
                  : 'border-danger/40 bg-danger/10',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                  explanation.data.allowed
                    ? 'bg-success/20 text-success'
                    : 'bg-danger/20 text-danger',
                )}
              >
                {explanation.data.allowed ? '✓' : '✗'}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  {explanation.data.allowed ? 'Allowed' : 'Denied'}
                  <span className="ml-2 font-normal text-ink-muted">
                    as <span className="font-mono text-xs">{explanation.data.role}</span>
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">{explanation.data.reason}</p>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-[13px] font-semibold text-ink">Decision trace</h3>
              <ol className="space-y-0">
                {explanation.data.trace.map((step, index) => (
                  <li
                    key={`${String(step.layer)}-${step.rule}-${String(index)}`}
                    className="grid grid-cols-[1.5rem_1fr] gap-x-3"
                  >
                    <div className="flex flex-col items-center">
                      <span
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold',
                          step.outcome === 'allow'
                            ? 'border-success/40 bg-success/15 text-success'
                            : step.outcome === 'deny'
                              ? 'border-danger/40 bg-danger/15 text-danger'
                              : 'border-line bg-surface-sunken text-ink-faint',
                        )}
                      >
                        {step.layer}
                      </span>
                      {index < explanation.data.trace.length - 1 && (
                        <span aria-hidden="true" className="w-px flex-1 bg-line" />
                      )}
                    </div>
                    <div className="min-w-0 pb-3">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm text-ink">{step.rule}</span>
                        <span className="text-[11px] text-ink-faint">
                          {LAYER_NAMES[step.layer] ?? `Layer ${String(step.layer)}`}
                        </span>
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            step.outcome === 'allow'
                              ? 'bg-success/15 text-success'
                              : step.outcome === 'deny'
                                ? 'bg-danger/15 text-danger'
                                : 'bg-surface-hover text-ink-muted',
                          )}
                        >
                          {step.outcome}
                        </span>
                      </p>
                      {step.detail !== undefined && (
                        <p className="mt-0.5 text-xs text-ink-muted">{step.detail}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <details className="rounded-lg border border-line/50">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink">
                As the server formats it
              </summary>
              <pre className="overflow-x-auto border-t border-line/50 bg-surface-sunken p-3 font-mono text-[11px] text-ink-muted">
                {explanation.data.formatted}
              </pre>
            </details>
          </div>
        )}

        {submitted === null && (
          <p className="text-xs text-ink-muted">
            Pick a member and a permission, then Explain to see the full decision trace.
          </p>
        )}
      </div>
    </details>
  );
}
