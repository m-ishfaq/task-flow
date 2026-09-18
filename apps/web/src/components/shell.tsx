import { useEffect, useRef, type ComponentType } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  ChevronDown,
  Keyboard,
  LogOut,
  Menu,
  ShieldCheck,
  SlidersHorizontal,
  User,
  type LucideProps,
} from 'lucide-react';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@taskflow/ui';
import type { OrgId } from '@taskflow/contracts';
import { signOut, useSession } from '../lib/session.js';
import { resetCache, keys } from '../lib/query.js';
import { api } from '../lib/trpc.js';
import { disconnectSocket } from '../lib/socket.js';
import { disconnectChatSocket } from '../lib/chat-socket.js';
import { disconnectRtcSocket } from '../lib/rtc-socket.js';
import { hangUp } from '../features/rtc/use-call.js';
import { useUi } from '../lib/ui-store.js';
import { useIsDesktop } from '../lib/use-media-query.js';
import { orgsQuery } from '../features/org/api.js';
import { useBranding } from '../lib/branding-context.js';
import { cn } from '../lib/cn.js';
import { hueOf } from './avatar-color.js';
import { Avatar } from './primitives.js';
import { Sidebar } from './sidebar.js';
import { CommandPalette } from './command-palette.js';
import { NotificationBell } from '../features/chat/notification-bell.js';
import { CallSurface } from '../features/rtc/call-surface.js';
import { NewOrgSetupDialog } from '../features/ai/setup-dialog.js';
import { MaintenanceBanner, MaintenanceScreen } from './maintenance-banner.js';
import { useMaintenanceStore } from '../lib/maintenance-store.js';

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
  const mobileNavOpen = useUi((state) => state.mobileNavOpen);
  const closeMobileNav = useUi((state) => state.closeMobileNav);
  const isDesktop = useIsDesktop();

  /* Read maintenance state early — before the bare/hasOrg layout decisions.
     A prior session may have stored `active: true` in localStorage; reading
     it here prevents a flash of the normal shell on a page reload while
     maintenance is on. The fetch wrapper (query.ts) catches fresh 503s
     before any query fires, but this handles the localStorage-rehydrated
     case synchronously on first render. */
  const maintenanceActive = useMaintenanceStore((s) => s.active);

  const bare =
    ANONYMOUS_PATHS.has(pathname) ||
    // Carries a `$provider` path param, so it cannot be a literal Set entry
    // like the others above. Reached via a full-page redirect from the OAuth
    // provider, which loses whatever session existed before the app left —
    // the same reasoning `router.tsx`'s own comment on that route gives.
    pathname.startsWith('/oauth/callback/') ||
    status !== 'authenticated';

  /* The org picker is authenticated but pre-org, so the tree has nothing to
     show and every query behind it would answer NOT_A_MEMBER. It keeps the
     footer — that is where the switcher lives — and drops the tree. */
  const hasOrg = orgId !== null;

  /* Closes the mobile drawer on every navigation, not on each Link's own
     click handler. Threading `onClick={closeMobileNav}` through every link in
     `Sidebar` (My tasks, Chat, Docs, People, every project, every board) would
     mean a new link added there later silently forgets to close the drawer;
     watching the URL instead makes the drawer agree with the route no matter
     which link — or the browser back button — got you there. */
  useEffect(() => {
    closeMobileNav();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeMobileNav is a stable Zustand action
  }, [pathname]);

  /* Escape closes the drawer — a real gap Wave 5's keyboard pass found in
     Wave 6's own work (ai/phase-6.5-ui-polish.md): the backdrop is
     `aria-hidden` (correctly, since it is a pointer-only affordance with
     nothing for a keyboard user to tab to), which is exactly why
     `jsx-a11y/no-static-element-interactions` did not flag its `onClick` as
     needing a keyboard equivalent — the rule assumes, correctly, that an
     aria-hidden element isn't reachable by keyboard in the first place. But
     that leaves the drawer with a mouse/touch way to close it and NO
     keyboard way at all, since `Sidebar`'s content is a plain nav tree, not
     a Radix `Dialog` that would have handled this for free. Every other
     dialog-shaped surface in this app (`packages/ui`'s `Modal`) gets Escape
     from Radix; this is the one piece of "dialog-like" chrome this phase
     built by hand instead, so it needs the same behaviour spelled out. */
  useEffect(() => {
    if (!mobileNavOpen) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMobileNav();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeMobileNav is a stable Zustand action
  }, [mobileNavOpen]);

  /* Focus moves INTO the drawer when it opens and back to whatever opened it
     when it closes — the other half of what Radix's `Dialog` gives for free
     and this hand-built drawer has to do itself (see the Escape effect
     above). `document.activeElement` at the moment `mobileNavOpen` flips
     true is, by construction, the control that just opened it — normally the
     header's hamburger button — so there is no need to thread a ref down
     into `Header` just to remember it.
     Deliberately NOT a full focus trap: Tab can still leave the drawer into
     the page content behind the backdrop while it's open. Radix's `Dialog`
     traps focus and this doesn't, which is a real, known gap rather than a
     silent one — building a correct trap by hand (wrap-around on Tab AND
     Shift+Tab, without also breaking Escape or the backdrop) is exactly the
     kind of thing Radix exists so this codebase doesn't have to get right
     from scratch, and re-implementing it here risked a worse bug than the
     one being fixed. */
  const drawerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (mobileNavOpen) {
      previouslyFocused.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      drawerRef.current?.focus();
    } else {
      previouslyFocused.current?.focus();
      previouslyFocused.current = null;
    }
  }, [mobileNavOpen]);

  if (bare) {
    return (
      /* `h-dvh` for the same reason as the framed branch below — the login and
         mail-link pages centre themselves against this height. */
      <div className="flex h-dvh flex-col">
        <MaintenanceBanner />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    );
  }

  /* Maintenance mode: show the full-page maintenance screen instead of the
     normal app shell. The banner-only path above handles the login page;
     authenticated users see this full screen with the admin's message and,
     for platform operators, a link to the admin console. maintenanceActive
     is declared above (before the bare check) to keep hooks in a fixed
     position and to catch the localStorage-rehydrated case on first render.

     Platform admin routes are always accessible during maintenance — the
     server bypasses them, and the admin needs the console to TOGGLE
     maintenance mode off. Without this guard, the admin gets locked out
     of the very console that controls the setting. */
  const isPlatformAdminRoute = pathname.startsWith('/platform-admin');
  if (maintenanceActive && !isPlatformAdminRoute) {
    return (
      <div className="flex h-dvh flex-col">
        <MaintenanceScreen />
      </div>
    );
  }

  return (
    <div
      className={cn(
        /* `h-dvh`, not `h-full`. `h-full` is `height: 100%`, which only
           resolves if EVERY ancestor has a definite height — html, body and
           #root each carry `h-full` for exactly that reason, and the chain
           holds today. It is still the wrong tool for the outermost frame:
           the whole layout below depends on this element having a real
           height, and a percentage makes that a property of four elements in
           two files rather than of this one.

           When the chain breaks, nothing errors. Every height falls back to
           `auto`, so the sidebar collapses to the height of its own tree and
           `main` grows past the viewport — which means a page that manages
           its own scrolling (`h-full` root, `flex-1 overflow-y-auto` body)
           has its inner region grow instead of scroll, and its `shrink-0`
           header scrolls away with the rest. A sticky header sliding off the
           top is the visible symptom of a height that was never definite.

           `dvh` is viewport-relative, so it resolves unconditionally. */
        'flex h-dvh overflow-hidden',
        /* The pre-org state renders no sidebar, header, or footer — the org
           picker is a standalone full-screen experience with its own chrome. */
      )}
    >
      {/* The drawer's backdrop, below `md` only. A click anywhere outside the
          drawer closes it — the same "tap away to dismiss" a Radix Popover
          gives for free, restated by hand because this isn't a Radix
          component, it's the app's own persistent chrome. */}
      {hasOrg && mobileNavOpen && (
        <div
          aria-hidden="true"
          onClick={closeMobileNav}
          className="fixed inset-0 z-30 bg-overlay md:hidden"
        />
      )}

      <div
        ref={drawerRef}
        /* `-1`: never in the Tab order (nothing about visiting this element
           by TABBING is meaningful — it's a layout wrapper, not a control),
           but still a valid target for the PROGRAMMATIC `.focus()` call
           above, which is what actually lands a keyboard user's focus inside
           the drawer's subtree the moment it opens. */
        tabIndex={-1}
        /* `inert` while the drawer is closed on a small screen — otherwise a
           `-translate-x-full` panel is invisible but NOT actually removed
           from the tab order or the accessibility tree (transform doesn't do
           either), so Tab from the header would walk a keyboard user through
           every sidebar link before reaching anything they can see. `inert`
           makes the whole subtree unfocusable and unreadable to assistive
           tech while it's off-screen, without `display: none`, which would
           kill the slide transition outright. Never inert at `md`+, where
           the drawer classes below don't apply and the sidebar is always the
           ordinary, always-interactive one Phase 3.5 built. */
        inert={hasOrg && !isDesktop && !mobileNavOpen}
        className={cn(
          'flex flex-col',
          /* Below `md`: an off-canvas drawer, fixed to the viewport and
             slid in/out with `translate-x`. At `md` and above: back to being
             an ordinary flex child with no fixed positioning at all — the
             desktop layout `Sidebar`'s own `open ? w-12 : w-60` already
             handles is untouched by anything here. */
          hasOrg &&
            cn(
              'fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0',
              mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
            ),
        )}
      >
        {hasOrg && <Sidebar />}
        {hasOrg && <SidebarFooter />}
      </div>

      {/* Global — reached by Ctrl/⌘K and `?` from anywhere in the frame, not
          just the sidebar it visually sits near. */}
      {hasOrg && <CommandPalette />}

      {/* In-app voice (Phase 13). Mounted in the FRAME, not on the chat page:
          a ringing call has to be answerable from wherever someone happens to
          be, and a call in progress has to survive navigating away from the
          conversation it started in. A microphone that stops when a route
          unmounts is not a phone. */}
      {hasOrg && <CallSurface />}

      {/* The §6 new-org Docs bootstrap offer (ai/phase-15-ai-copilot-and-
          permissions.md §6). Mounted in the frame rather than on `/projects`
          specifically: the component's own effect is a no-op unless THIS
          tab just created the current org, so it costs nothing to keep
          mounted everywhere `hasOrg` is true, and it means the offer still
          appears even if `choose()` ever routes somewhere other than
          `/projects` after creation. */}
      {hasOrg && <NewOrgSetupDialog orgId={orgId} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The header is hidden when no org is selected — the org picker is a
            standalone full-screen experience with its own branding and chrome. */}
        {hasOrg && <Header showMenuButton />}
        {/* The maintenance banner sits between the header and the page content.
            Only visible when the API returns a 503 maintenance response. */}
        {hasOrg && <MaintenanceBanner />}
        {/* `relative` establishes a containing block, and it is load-bearing.
            An `position: absolute` descendant with no positioned ancestor
            resolves against the INITIAL containing block instead — which means
            it escapes both its scroll container's clipping and `#root`'s
            `overflow-hidden`, and contributes to the DOCUMENT's scroll area at
            its static position. Tailwind's `sr-only` is absolutely positioned,
            so every screen-reader label in a long list did exactly that: the
            page itself measured correctly (its own region scrolled, its header
            stayed put) while `<html>` quietly grew past the viewport, and the
            window scrollbar dragged the entire fixed-height frame — header,
            sidebar and all — off the top. Positioning `main` keeps those
            descendants inside the frame that clips them. */}
        <main className="relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-surface">
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
function SidebarFooter() {
  const sidebarOpen = useUi((state) => state.sidebarOpen);
  const isDesktop = useIsDesktop();
  const collapsed = !sidebarOpen && isDesktop;

  return (
    <div
      className={cn(
        'mt-auto flex shrink-0 items-center gap-1 border-t border-line/60 bg-surface-raised',
        collapsed ? 'flex-col justify-center p-2' : 'flex-row p-2',
        'border-r',
      )}
    >
      <OrgSwitcher collapsed={collapsed} />
      <AccountMenu collapsed={collapsed} />
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
function Header({ showMenuButton }: { readonly showMenuButton: boolean }) {
  const setShortcutsOpen = useUi((state) => state.setShortcutsOpen);
  const toggleMobileNav = useUi((state) => state.toggleMobileNav);
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line/50 px-4">
      {/* Below `md`, the sidebar is an off-canvas drawer (Shell) with no
          permanent trigger of its own — this is the only way to open it.
          `showMenuButton` is false in the org-picker's pre-org state, where
          Shell renders no drawer at all for this to open. */}
      {showMenuButton && (
        <button
          type="button"
          onClick={toggleMobileNav}
          aria-label="Open navigation"
          className="-ml-1 shrink-0 rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink md:hidden"
        >
          <Menu aria-hidden="true" className="size-5" strokeWidth={2} />
        </button>
      )}

      <Breadcrumbs />

      {/* `overflow-x-auto` + `flex-nowrap` rather than letting the row wrap:
          wrapping would grow the header past its fixed `h-12` every time the
          viewport is too narrow for four items, which pushes `main` down by a
          varying amount depending on what's currently in the row. Scrolling
          keeps the header's height constant and every item still reachable —
          the smallest phone this has been checked against is a 320px-wide
          viewport, where these four items plus the hamburger button and a
          short breadcrumb still fit without scrolling; scrolling is the
          fallback for narrower or zoomed cases, not the primary path. */}
      <nav
        className="ml-auto flex flex-nowrap items-center gap-1 overflow-x-auto"
        aria-label="Settings"
      >
        {/* Utility group: notifications, shortcuts */}
        <div className="flex items-center gap-0.5">
          {/* Mentions and direct messages. In the shell rather than on the chat
              page because its whole purpose is telling you about a conversation
              you are NOT currently looking at. */}
          <NotificationBell />

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
            className="shrink-0 rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Keyboard aria-hidden="true" className="size-4" strokeWidth={2} />
          </button>
        </div>

        {/* Divider between utility and settings */}
        <div className="mx-1 h-4 w-px bg-line/60" />

        {/* Settings group */}
        <div className="flex items-center gap-0.5">
          <NavLink to="/settings" label="Settings" icon={SlidersHorizontal} />
          <NavLink to="/permissions" label="Permissions" icon={ShieldCheck} />
        </div>
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
  const { productName } = useBranding();

  const label = pathname.startsWith('/boards/')
    ? 'Board'
    : pathname.startsWith('/home')
      ? 'My tasks'
      : pathname.startsWith('/search')
        ? 'Search'
        : pathname.startsWith('/chat')
          ? 'Chat'
          : pathname.startsWith('/calls')
            ? 'Calls'
            : pathname.startsWith('/docs')
              ? 'Docs'
              : pathname.startsWith('/projects/')
                ? 'Project'
                : pathname.startsWith('/people')
                  ? 'People'
                  : pathname.startsWith('/projects')
                    ? 'Projects'
                    : pathname.startsWith('/settings/audit')
                      ? 'Audit log'
                      : pathname.startsWith('/settings')
                        ? 'Settings'
                        : pathname.startsWith('/permissions')
                          ? 'Permissions'
                          : pathname.startsWith('/platform-admin')
                            ? 'Platform admin'
                            : pathname.startsWith('/orgs')
                              ? 'Organizations'
                              : pathname.startsWith('/assistant')
                                ? 'Assistant'
                                : pathname.startsWith('/analytics')
                                  ? 'Analytics'
                                  : pathname.startsWith('/account')
                                    ? 'Account'
                                    : productName;

  /* `min-w-0` is load-bearing, not decorative: a flex item's default
     min-width is `auto`, which means it will NOT shrink below its own content
     size no matter how little room its siblings (the menu button, the
     notification bell, the nav links) leave it — so `truncate`'s
     `overflow-hidden` + `text-overflow: ellipsis` never actually engages on a
     narrow header, and the row overflows the viewport instead of eliding the
     label. This is the one-line fix for a bug that only shows up once the
     header actually gets tight, which the desktop-only build before this wave
     never exercised. */
  return (
    <h1 className="min-w-0 truncate font-display text-[15px] font-semibold tracking-tight text-ink">
      {label}
    </h1>
  );
}

/** A `lucide-react` icon component — matches sidebar.tsx's own alias. */
type NavIcon = ComponentType<LucideProps>;

function NavLink({
  to,
  label,
  icon: Icon,
}: {
  readonly to: '/projects' | '/settings' | '/permissions';
  readonly label: string;
  readonly icon: NavIcon;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      className="shrink-0 rounded-lg p-2 text-ink-muted transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover hover:text-ink"
      activeProps={{ className: 'bg-accent/10 text-accent hover:bg-accent/15 hover:text-accent' }}
    >
      <Icon aria-hidden="true" className="size-4" strokeWidth={2} />
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
function OrgSwitcher({ collapsed }: { readonly collapsed: boolean }) {
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

  /** Org initials: first 2 chars of first word, or first 2 words */
  const orgInitials = (name: string) => {
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    const second = parts[1];
    if (first !== undefined && second !== undefined) {
      return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
    }
    if (first !== undefined) {
      return (first.slice(0, 2) || '?').toUpperCase();
    }
    return '?';
  };

  const avatarDisc = (
    <span
      className="size-6 shrink-0 rounded-md flex items-center justify-center text-[10px] font-semibold text-white"
      style={{
        backgroundColor: `oklch(65% 0.15 ${String(hueOf(current?.orgId ?? 'default'))})`,
      }}
    >
      {current ? current.name.charAt(0).toUpperCase() : '?'}
    </span>
  );

  const menuItems = (
    <>
      {memberships.map((org) => {
        const isActive = org.orgId === orgId;
        return (
          <DropdownMenuItem
            key={org.orgId}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-2',
              isActive && 'bg-accent/8',
            )}
            onSelect={() => {
              switchTo(org.orgId as OrgId);
            }}
          >
            <span
              className="size-5 shrink-0 rounded-full flex items-center justify-center text-[9px] font-semibold text-white"
              style={{
                backgroundColor: `oklch(65% 0.15 ${String(hueOf(org.orgId))})`,
              }}
            >
              {orgInitials(org.name)}
            </span>
            <div className="flex-1 min-w-0">
              <p
                className={cn(
                  'text-[13px] truncate',
                  isActive ? 'font-semibold text-ink' : 'font-medium text-ink',
                )}
              >
                {org.name}
              </p>
              <p className="text-[11px] text-ink-faint capitalize">{org.role}</p>
            </div>
            {isActive && <Check className="size-4 shrink-0 text-accent" />}
          </DropdownMenuItem>
        );
      })}

      {memberships.length > 0 && <DropdownMenuSeparator />}

      {/* The unconditional way to `/orgs`. It is also the only way to CREATE
          an org, which the switcher cannot offer and which a caller with no
          memberships needs before anything else in the app works. */}
      <DropdownMenuItem
        tone="muted"
        className="rounded-md px-2 py-2"
        onSelect={() => {
          void navigate({ to: '/orgs' });
        }}
      >
        All organizations…
      </DropdownMenuItem>
    </>
  );

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        {collapsed ? (
          <button
            type="button"
            aria-label={current?.name ?? 'Select organization'}
            className="mx-auto rounded-full p-0.5 ring-2 ring-transparent transition-all hover:ring-surface-hover"
          >
            {avatarDisc}
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-hover group"
          >
            {avatarDisc}
            <span className="flex-1 min-w-0 text-left text-[13px] font-medium text-ink truncate">
              {current?.name ?? 'Select organization'}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 shrink-0 text-ink-faint"
              strokeWidth={2.25}
            />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-52 p-1.5">
        {menuItems}
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

function AccountMenu({ collapsed }: { readonly collapsed: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const email = useSession((state) => state.email);
  const sessionId = useSession((state) => state.sessionId);
  const me = useQuery({ queryKey: keys.me(), queryFn: async () => await api.auth.me.query() });
  const emailPrefix = email?.split('@')[0];

  /* The ONE nav item this app hides on a server answer, and why that is not the
     §8.2 anti-pattern. Everywhere else the rule is "render the control, let the
     API say no": a button on a page you are already looking at has an honest
     FORBIDDEN experience. A nav link to /platform-admin has no such thing —
     nothing sensible renders for "you are not an operator" at a menu item —
     and pointing it at everyone would advertise a surface nobody else may
     reach. `self.check` is a selfRoute with no step-up on purpose (§3.2) so
     this probe is cheap for every logged-in user on every load. The link is a
     convenience; the page behind it still refuses non-operators at the server. */
  const isOperator = useQuery({
    queryKey: keys.platformSelf(),
    queryFn: async () => (await api.platformAdmin.self.check.query(undefined)).isOperator,
  });

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
      disconnectChatSocket();
      /* And the signalling namespace. Leaving it connected would keep a live
         call's peer connections negotiating over a socket authenticated as
         somebody who has just signed out — `hangUp` releases the microphone,
         and this releases the transport that would otherwise outlive it. */
      void hangUp({ silent: true });
      disconnectRtcSocket();
      await navigate({ to: '/login' });
    })();
  };

  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account"
          className={cn(
            'rounded-full p-0.5 ring-2 ring-transparent transition-all hover:ring-surface-hover',
            collapsed ? 'mx-auto' : 'shrink-0',
          )}
        >
          {/* `email` is in memory only and is null after a reload — see
              session.ts on why it is deliberately not persisted. The display
              name from `auth.me` provides stable initials; sessionId
              provides a stable hue. */}
          <Avatar
            userId={sessionId ?? 'anonymous'}
            label={me.data?.displayName ?? email ?? 'Account'}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-48 p-1.5">
        {email !== null && (
          <>
            <div className="px-2 py-2">
              <p className="text-[13px] font-medium text-ink truncate">
                {me.data?.displayName ?? emailPrefix ?? 'Account'}
              </p>
              <p className="text-[11px] text-ink-faint truncate">{email}</p>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {/* `/account` — requireSession only, not requireOrg (ai/account-page.md).
            Reachable from here specifically because it must be: the org
            switcher above it is the one place someone can be signed in with
            no org selected, and this is the account menu's only other item. */}
        <DropdownMenuItem
          className="rounded-md px-2 py-2"
          onSelect={() => {
            void navigate({ to: '/account' });
          }}
        >
          <User className="size-4 text-ink-faint" />
          Profile settings
        </DropdownMenuItem>
        {isOperator.data === true && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="rounded-md px-2 py-2"
              onSelect={() => {
                void navigate({ to: '/platform-admin' });
              }}
            >
              <ShieldCheck className="size-4 text-ink-faint" />
              Platform admin
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="rounded-md px-2 py-2" onSelect={leave}>
          <LogOut className="size-4 text-ink-faint" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
