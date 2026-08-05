import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { OrgId } from '@taskflow/contracts';
import { signOut, useSession } from '../lib/session.js';
import { resetCache } from '../lib/query.js';
import { disconnectSocket } from '../lib/socket.js';
import { useUi } from '../lib/ui-store.js';
import { orgsQuery } from '../features/org/api.js';
import { cn } from '../lib/cn.js';
import { Avatar, Button } from './primitives.js';
import { Sidebar } from './sidebar.js';
import { CommandPalette } from './command-palette.js';

/**
 * The application frame: the navigation tree, the org switcher, and sign-out.
 *
 * Rendered by the root route, so the pages that have no session — login,
 * register — render inside it too. The frame is hidden for those, because a
 * "switch organization" control on the sign-in page is at best confusing and at
 * worst renders a stale org name to whoever is standing at the machine.
 *
 * ## The shape, and what moved (Phase 3.5 Wave 1)
 *
 * A sidebar owns navigation and identity; the header owns WHERE YOU ARE and what
 * you can do here. Previously the header carried both, which meant the top of
 * every screen was a list of destinations and no screen said what it was.
 *
 * The org switcher and account menu moved into the sidebar footer for the same
 * reason every tool in this category puts them there: they are switched rarely
 * and they anchor the frame rather than the page.
 */

/**
 * Routes that render without the application frame.
 *
 * The last three are reached from an emailed link, usually with no session at
 * all — a header offering "switch organization" and "sign out" there is at best
 * confusing, and at worst renders a previous user's org name to whoever is
 * standing at the machine.
 */
const ANONYMOUS_PATHS = new Set([
  '/login',
  '/register',
  '/verify-email',
  '/reset-password',
  '/forgot-password',
]);

export function Shell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const status = useSession((state) => state.status);
  const orgId = useSession((state) => state.orgId);

  const bare = ANONYMOUS_PATHS.has(pathname) || status !== 'authenticated';

  /* The org picker is authenticated but pre-org, so the tree has nothing to
     show and every query behind it would answer NOT_A_MEMBER. It keeps the
     footer — that is where the switcher lives — and drops the tree. */
  const hasOrg = orgId !== null;

  if (bare) {
    return (
      <div className="flex h-full flex-col">
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-col">
        {hasOrg && <Sidebar />}
        <SidebarFooter standalone={!hasOrg} />
      </div>

      {/* Global — reached by Ctrl/⌘K and `?` from anywhere in the frame, not
          just the sidebar it visually sits near. */}
      {hasOrg && <CommandPalette />}

      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * Identity, pinned to the bottom of the frame.
 *
 * Split from `Sidebar` rather than nested in it because it must survive the one
 * state the tree cannot render — no org selected — which is exactly the state in
 * which someone needs the switcher most. That is the same dead end CLAUDE.md
 * records: an empty org list used to hide the switcher entirely, leaving sign-out
 * as the only way out.
 */
function SidebarFooter({ standalone }: { readonly standalone: boolean }) {
  return (
    <div
      className={cn(
        'mt-auto flex shrink-0 items-center gap-1 border-t border-r border-line bg-surface-raised p-2',
        /* With no tree above it there is nothing to inherit a width from, and a
           switcher sized to the word "Select organization" is not a layout. */
        standalone && 'w-60',
      )}
    >
      <OrgSwitcher />
      <AccountMenu />
    </div>
  );
}

/**
 * Where you are, and what you can do here.
 *
 * Deliberately thin. The page owns its own toolbar — the board's view toggle and
 * filter builder stay on the board — because a header that accumulates
 * page-specific controls becomes a second navigation bar that is wrong on every
 * page but one.
 */
function Header() {
  const setShortcutsOpen = useUi((state) => state.setShortcutsOpen);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
      <Breadcrumbs />

      <nav className="ml-auto flex items-center gap-1" aria-label="Settings">
        {/* The only visible route to the shortcuts overlay — everything else
            about it is keyboard-only, and a feature reachable by one key
            nobody was told about is not discoverable. */}
        <button
          type="button"
          onClick={() => {
            setShortcutsOpen(true);
          }}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          className="rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          ?
        </button>
        <NavLink to="/settings" label="Settings" />
        <NavLink to="/admin/permissions" label="Permissions" />
      </nav>
    </header>
  );
}

/**
 * The trail, derived from the URL rather than from a store.
 *
 * From the path alone, so it cannot disagree with what is rendered. Deriving it
 * from a "current project" store would give two answers during any navigation
 * that changed one before the other, and the wrong one would be the visible one.
 *
 * Names are not resolved here. A breadcrumb that waits on `projects.list` to say
 * anything at all is a header that is blank on every cold load, and the sidebar
 * already highlights the active node with its real name.
 */
function Breadcrumbs() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  const label = pathname.startsWith('/boards/')
    ? 'Board'
    : pathname.startsWith('/home')
      ? 'My tasks'
      : pathname.startsWith('/projects/')
        ? 'Project'
        : pathname.startsWith('/projects')
          ? 'Projects'
          : pathname.startsWith('/settings/audit')
            ? 'Audit log'
            : pathname.startsWith('/settings')
              ? 'Settings'
              : pathname.startsWith('/admin/permissions')
                ? 'Permissions'
                : pathname.startsWith('/orgs')
                  ? 'Organizations'
                  : 'TaskFlow';

  return <h1 className="truncate text-sm font-medium text-ink">{label}</h1>;
}

function NavLink({
  to,
  label,
}: {
  readonly to: '/projects' | '/settings' | '/admin/permissions';
  readonly label: string;
}) {
  return (
    <Link
      to={to}
      className="rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
      activeProps={{ className: 'bg-surface-hover text-ink' }}
    >
      {label}
    </Link>
  );
}

/**
 * The organization switcher.
 *
 * Switching does two things and both are required. It changes the header sent
 * on every subsequent request — which is what the API resolves a membership
 * from — and it CLEARS THE QUERY CACHE. Without the second, the previous org's
 * boards stay on screen under keys that do not mention the new org until each
 * one refetches. Every key is org-prefixed so that window is already small, but
 * "small" is not the standard for showing one tenant's data inside another.
 *
 * ## Why it renders even with nothing to switch between
 *
 * It used to return null when the list was empty, which is the sensible-looking
 * version and produced a dead end. A caller whose stored org no longer resolves
 * has zero memberships to list, so the switcher vanished — and `/orgs` has no
 * navigation link anywhere else. The only way out of "you are not a member of
 * this organization" was to sign out, which is precisely the accident that hid
 * the underlying staleness bug for so long. The picker is now always one click
 * away, whatever the list says.
 */
function OrgSwitcher() {
  const orgId = useSession((state) => state.orgId);
  const selectOrg = useSession((state) => state.selectOrg);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const orgs = useQuery(orgsQuery());
  const memberships = orgs.data ?? [];
  const current = memberships.find((org) => org.orgId === orgId);

  const switchTo = (next: OrgId) => {
    if (next === orgId) return;

    selectOrg(next);
    resetCache(queryClient);
    /* Back to the project list rather than staying put: the current URL names a
       board id belonging to the org being left, and every query on it would 404
       under the new one. */
    void navigate({ to: '/projects' });
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" className="min-w-0 flex-1 justify-start">
          <span className="truncate">{current?.name ?? 'Select organization'}</span>
          <span aria-hidden="true" className="ml-auto">
            ▾
          </span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="top"
          sideOffset={4}
          className="min-w-48 rounded border border-line bg-surface-raised p-1 shadow-lg"
        >
          {memberships.map((org) => (
            <DropdownMenu.Item
              key={org.orgId}
              onSelect={() => {
                switchTo(org.orgId as OrgId);
              }}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-sm',
                'text-ink outline-none data-[highlighted]:bg-surface-hover',
              )}
            >
              <span>{org.name}</span>
              <span className="text-[11px] text-ink-faint">{org.role}</span>
            </DropdownMenu.Item>
          ))}

          {memberships.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-line" />}

          {/* The unconditional way to `/orgs`. It is also the only way to CREATE
              an org, which the switcher cannot offer and which a caller with no
              memberships needs before anything else in the app works. */}
          <DropdownMenu.Item
            onSelect={() => {
              void navigate({ to: '/orgs' });
            }}
            className={cn(
              'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm',
              'text-ink-muted outline-none data-[highlighted]:bg-surface-hover',
            )}
          >
            All organizations…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AccountMenu() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const email = useSession((state) => state.email);
  const sessionId = useSession((state) => state.sessionId);

  const leave = () => {
    void (async () => {
      await signOut();
      /* Cleared after the server call, not before. The cache holds the previous
         user's data, and the next person to use this browser must not be handed
         it by a component that renders from cache before its query settles. */
      resetCache(queryClient);
      // A socket that outlived the session it authenticated with is the same
      // stale-connection shape resetCache prevents for the query cache — and
      // the NEXT person's board would otherwise join rooms over a connection
      // still carrying the previous user's token in its `auth` closure.
      disconnectSocket();
      await navigate({ to: '/login' });
    })();
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Account"
          className="shrink-0 rounded p-0.5 hover:bg-surface-hover"
        >
          {/* `email` is in memory only and is null after a reload — see
              session.ts on why it is deliberately not persisted. The session id
              keeps the avatar's colour stable across that gap rather than having
              it change on every refresh. */}
          <Avatar userId={sessionId ?? 'anonymous'} label={email ?? 'Account'} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="top"
          sideOffset={4}
          className="min-w-44 rounded border border-line bg-surface-raised p-1 shadow-lg"
        >
          {email !== null && (
            <>
              <p className="truncate px-2 py-1.5 text-xs text-ink-faint">{email}</p>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
            </>
          )}
          <DropdownMenu.Item
            onSelect={leave}
            className={cn(
              'cursor-pointer rounded px-2 py-1.5 text-sm',
              'text-ink outline-none data-[highlighted]:bg-surface-hover',
            )}
          >
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
