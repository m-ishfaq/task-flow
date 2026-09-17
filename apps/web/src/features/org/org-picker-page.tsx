import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronUp,
  Loader2,
  LogOut,
  Plus,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import type { OrgId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { signOut, useSession } from '../../lib/session.js';
import { useBranding } from '../../lib/branding-context.js';
import { keys, resetCache } from '../../lib/query.js';
import { cn } from '../../lib/cn.js';
import { Badge, Button, Field, Input, SkeletonRows } from '../../components/primitives.js';
import { BrandMark } from '../../components/brand-mark.js';
import { ErrorView } from '../../components/error-view.js';
import { orgsQuery, type OrgMembership } from './api.js';

/**
 * The full-screen org picker — a premium welcome experience.
 *
 * This is the one page that works with no org selected, which is why
 * `tenancy.orgs.list` is a `selfRoute` rather than a permissioned one: asking
 * "which orgs am I in?" cannot require having already answered it.
 *
 * ## Layout
 *
 * The shell hides the sidebar, header, and footer when no org is selected,
 * so this page IS the entire viewport. It renders a centered, scrollable
 * column with its own branding header, sign-out, operator console access,
 * org list, and create-org form.
 *
 * ## Operator vs. member
 *
 * A platform operator sees a premium operator landing — no "Create org"
 * form (that is not their concern), the console as primary action, and
 * a sign-out chip in the top-right. Non-operators see the standard
 * org list and create form.
 */

interface CreateValues {
  name: string;
  slug: string;
}

/** Role badge colors — semantic, not decorative. */
const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-accent/10 text-accent border-accent/20',
  admin: 'bg-purple-500/10 text-purple-600 border-purple-500/20 dark:bg-purple-400/10 dark:text-purple-400',
  member: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:bg-emerald-400/10 dark:text-emerald-400',
  guest: 'bg-amber-500/10 text-amber-600 border-amber-500/20 dark:bg-amber-400/10 dark:text-amber-400',
};

const MANAGEMENT_ROLES = new Set(['owner', 'admin']);
const MEMBER_ROLES = new Set(['member']);

function roleColor(role: string): string {
  return ROLE_COLORS[role] ?? 'bg-surface-hover text-ink-muted border-line';
}

export function OrgPickerPage() {
  const orgs = useQuery(orgsQuery());
  const { productName } = useBranding();
  const [search, setSearch] = useState('');

  const isOperator = useQuery({
    queryKey: keys.platformSelf(),
    queryFn: async () => (await api.platformAdmin.self.check.query(undefined)).isOperator,
  });
  const me = useQuery({ queryKey: keys.me(), queryFn: async () => await api.auth.me.query() });
  const selectOrg = useSession((state) => state.selectOrg);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const choose = (orgId: OrgId) => {
    selectOrg(orgId);
    resetCache(queryClient);
    void navigate({ to: '/projects' });
  };

  const handleSignOut = async () => {
    await signOut();
    resetCache(queryClient);
    void navigate({ to: '/login' });
  };

  const filteredOrgs = useMemo(() => {
    if (!orgs.data) return [];
    if (!search.trim()) return orgs.data;
    const q = search.toLowerCase();
    return orgs.data.filter(
      (o) =>
        o.name.toLowerCase().includes(q) ||
        o.slug.toLowerCase().includes(q) ||
        o.role.toLowerCase().includes(q),
    );
  }, [orgs.data, search]);

  const isEmpty = orgs.data?.length === 0;
  const activeOrgs = filteredOrgs.filter(
    (o) => o.orgStatus === 'active' && o.membershipStatus === 'active',
  );
  const suspendedOrgs = filteredOrgs.filter(
    (o) => o.orgStatus !== 'active' || o.membershipStatus !== 'active',
  );
  const showSearch = (orgs.data?.length ?? 0) > 3;
  const operator = isOperator.data === true;

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col px-6 py-12 md:py-20">
        {/* ── Sign-out chip ────────────────────────────────────────────── */}
        <div className="absolute right-6 top-6 md:right-10 md:top-10">
          <button
            type="button"
            onClick={() => {
              void handleSignOut();
            }}
            className="group flex items-center gap-2.5 rounded-xl border border-line bg-surface-raised px-3.5 py-2 text-left shadow-sm transition-all hover:border-line-hover hover:bg-surface-hover hover:shadow-md"
          >
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
              style={{ backgroundColor: 'oklch(55% 0.12 250)' }}
            >
              {(me.data?.displayName?.trim()[0] ?? me.data?.email?.trim()[0] ?? '?').toUpperCase()}
            </span>
            <span className="hidden min-w-0 md:block">
              <span className="block truncate text-sm font-medium text-ink max-w-[140px]">
                {me.data?.displayName ?? me.data?.email ?? 'Account'}
              </span>
            </span>
            <LogOut
              className="size-4 shrink-0 text-ink-faint transition-colors group-hover:text-danger"
              strokeWidth={2}
            />
          </button>
        </div>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <header className="mb-10 flex flex-col items-center text-center">
          <BrandMark size={56} className="mb-5 text-accent" />
          {operator ? (
            <>
              <h1 className="font-display text-2xl font-bold tracking-tight text-ink md:text-3xl">
                Platform operator
              </h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
                Your work is cross-tenant. Open the platform console to manage
                organizations, users, and plans.
              </p>
            </>
          ) : (
            <>
              <h1 className="font-display text-2xl font-bold tracking-tight text-ink md:text-3xl">
                {isEmpty ? `Welcome to ${productName}` : `Welcome back`}
              </h1>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
                {isEmpty
                  ? `Create your first organization to get started. An organization owns its projects, members, and audit trail.`
                  : `Pick an organization to continue. Each one is its own workspace with its own projects and members.`}
              </p>
            </>
          )}
        </header>

        {/* ── Operator console ────────────────────────────────────────── */}
        {operator && (
          <Link
            to="/platform-admin"
            className="group mb-8 flex items-center gap-4 rounded-xl border border-accent/25 bg-accent/5 p-5 transition-all hover:border-accent/40 hover:bg-accent/10 hover:shadow-md"
          >
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ShieldCheck className="size-5" strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-ink">
                Open platform console
              </span>
              <span className="block text-xs text-ink-muted">
                Manage organizations, users, plans, flags, and the operator audit log.
              </span>
            </span>
            <ArrowRight
              className="size-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
              strokeWidth={2}
            />
          </Link>
        )}

        {/* ── Loading ─────────────────────────────────────────────────── */}
        {orgs.isPending && (
          <div className="space-y-3">
            <SkeletonRows rows={3} className="*:h-20" />
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────────── */}
        {orgs.isError && (
          <ErrorView error={orgs.error} title="Could not load your organizations" />
        )}

        {/* ── Org list ────────────────────────────────────────────────── */}
        {!orgs.isPending && !orgs.isError && (
          <>
            {/* Section label */}
            {!isEmpty && (
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-ink-faint">
                {operator ? 'Your organizations' : 'Organizations'}
              </p>
            )}

            {/* Search */}
            {showSearch && (
              <div className="relative mb-4">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
                <input
                  type="text"
                  placeholder="Search organizations..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                  }}
                  className="h-10 w-full rounded-lg border border-line bg-surface-raised pl-9 pr-9 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-accent/50 focus:outline-none focus:ring-2 focus:ring-accent/15"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-muted"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* Active orgs */}
            {activeOrgs.length > 0 && (
              <ul className="space-y-2.5">
                {activeOrgs.map((org) => (
                  <OrgRow key={org.orgId} org={org} onChoose={choose} />
                ))}
              </ul>
            )}

            {/* Suspended orgs */}
            {suspendedOrgs.length > 0 && (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-ink-faint">
                  Unavailable
                </p>
                <ul className="space-y-2">
                  {suspendedOrgs.map((org) => (
                    <SuspendedRow key={org.orgId} org={org} />
                  ))}
                </ul>
              </div>
            )}

            {/* Empty search */}
            {showSearch && search && activeOrgs.length === 0 && suspendedOrgs.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-sm text-ink-muted">
                  No organizations match &ldquo;{search}&rdquo;
                </p>
              </div>
            )}

            {/* Empty state for non-operators */}
            {isEmpty && !operator && (
              <div className="py-6 text-center">
                <p className="text-sm text-ink-muted">
                  You don&apos;t belong to any organizations yet.
                </p>
              </div>
            )}

            {/* Empty state for operators — they can still access orgs via console */}
            {isEmpty && operator && (
              <div className="rounded-xl border border-dashed border-line/50 bg-surface-sunken/30 p-6 text-center">
                <p className="text-sm text-ink-muted">
                  No organizations assigned to your account. Use the platform console to create or
                  assign one.
                </p>
              </div>
            )}
          </>
        )}

        {/* ── Create org (non-operators only) ─────────────────────────── */}
        {!operator && !orgs.isPending && !orgs.isError && (
          <div className={cn('mt-6', orgs.data.length > 0 && 'mt-8')}>
            <CreateOrgPanel startOpen={isEmpty} onCreated={choose} />
          </div>
        )}

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <footer className="mt-auto pt-12 text-center">
          <p className="text-xs text-ink-faint">
            {productName} &middot; Multi-tenant project management
          </p>
        </footer>
      </div>
    </div>
  );
}

/* ── Active org row ──────────────────────────────────────────────────────── */

function OrgRow({
  org,
  onChoose,
}: {
  readonly org: OrgMembership;
  readonly onChoose: (orgId: OrgId) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onChoose(org.orgId as OrgId);
        }}
        className="group flex w-full items-center gap-4 rounded-xl border border-line bg-surface-raised p-4 text-left shadow-sm transition-all hover:border-accent/30 hover:bg-surface-hover hover:shadow-md"
      >
        <OrgAvatar name={org.name} />

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold text-ink group-hover:text-accent">
            {org.name}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className="truncate font-mono text-xs text-ink-faint">{org.slug}</span>
          </span>
        </span>

        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize',
            roleColor(org.role),
          )}
        >
          {MANAGEMENT_ROLES.has(org.role) && <ShieldCheck className="size-3" />}
          {MEMBER_ROLES.has(org.role) && <Users className="size-3" />}
          {org.role}
        </span>

        <ArrowRight
          className="size-4 shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-accent"
          strokeWidth={2}
        />
      </button>
    </li>
  );
}

/* ── Suspended org row ───────────────────────────────────────────────────── */

function SuspendedRow({ org }: { readonly org: OrgMembership }) {
  const isOrgSuspended = org.orgStatus !== 'active';
  return (
    <li className="flex items-center gap-4 rounded-xl border border-dashed border-line/50 bg-surface-sunken/30 p-4 opacity-60">
      <OrgAvatar name={org.name} muted />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-ink-muted">{org.name}</span>
        <span className="mt-0.5 block text-xs text-ink-faint">
          {isOrgSuspended
            ? 'This organization has been suspended'
            : 'Your membership is suspended'}
        </span>
      </span>
      <Badge className="opacity-60">{isOrgSuspended ? 'Suspended' : 'Inactive'}</Badge>
    </li>
  );
}

/* ── Org avatar ──────────────────────────────────────────────────────────── */

/**
 * Colored avatar disc for an org.
 *
 * Deliberately not `Avatar` — that component hues from a USER id and is
 * documented as keeping one person one colour everywhere. An org is not a
 * person, and feeding an org id into it would mint a second meaning for the
 * same visual language. Instead we hue from the org name via a simple hash.
 */
function OrgAvatar({ name, muted }: { readonly name: string; readonly muted?: boolean }) {
  const hue = useMemo(() => {
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }, [name]);

  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold',
        muted ? 'bg-surface-hover text-ink-faint' : 'text-white',
      )}
      style={
        muted
          ? undefined
          : {
              backgroundColor: `oklch(55% 0.12 ${String(hue)})`,
            }
      }
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/* ── Create org panel ────────────────────────────────────────────────────── */

function CreateOrgPanel({
  startOpen,
  onCreated,
}: {
  readonly startOpen: boolean;
  readonly onCreated: (orgId: OrgId) => void;
}) {
  const [open, setOpen] = useState(startOpen);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="group flex w-full items-center gap-3 rounded-xl border border-dashed border-line/60 bg-surface-sunken/30 p-4 text-left transition-all hover:border-accent/40 hover:bg-surface-hover"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-hover text-ink-faint transition-colors group-hover:bg-accent/10 group-hover:text-accent">
          <Plus className="size-5" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink">New organization</span>
          <span className="block text-xs text-ink-muted">
            Create a new workspace for your team.
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-ink-faint transition-transform group-hover:text-ink-muted" />
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface-raised p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Building2 className="size-4.5" strokeWidth={2} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-ink">Create organization</h2>
            <p className="text-xs text-ink-muted">You become its owner.</p>
          </div>
        </div>
        {startOpen ? null : (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
            className="rounded-md p-1 text-ink-faint hover:text-ink-muted"
          >
            <ChevronUp className="size-4" />
          </button>
        )}
      </div>
      <CreateOrgForm
        onCreated={onCreated}
        onCancel={
          startOpen
            ? null
            : () => {
                setOpen(false);
              }
        }
      />
    </div>
  );
}

/* ── Create org form ─────────────────────────────────────────────────────── */

function CreateOrgForm({
  onCreated,
  onCancel,
}: {
  readonly onCreated: (orgId: OrgId) => void;
  /** Null when there is nothing to go back to — a first org is not optional. */
  readonly onCancel: (() => void) | null;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, setValue, watch } = useForm<CreateValues>({
    defaultValues: { name: '', slug: '' },
  });

  const nameValue = watch('name');

  const create = useMutation({
    mutationFn: (values: CreateValues) => api.tenancy.orgs.create.mutate(values),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: keys.orgs() });
      onCreated(result.orgId as OrgId);
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        void handleSubmit((values) => {
          create.mutate(values);
        })(event);
      }}
    >
      <Field label="Organization name" htmlFor="org-name">
        <Input
          id="org-name"
          placeholder="Acme Corp"
          {...register('name', {
            required: true,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
              setValue('slug', slugify(event.target.value), { shouldDirty: false });
            },
          })}
        />
      </Field>

      <Field
        label="Slug"
        htmlFor="org-slug"
        hint="Used in URLs. Derived from the name; edit it if you want something else."
      >
        <Input id="org-slug" className="font-mono text-xs" {...register('slug', { required: true })} />
      </Field>

      {create.isError && <ErrorView error={create.error} />}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" disabled={create.isPending || !nameValue.trim()}>
          {create.isPending ? (
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              Creating…
            </span>
          ) : (
            'Create organization'
          )}
        </Button>
        {onCancel !== null && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
