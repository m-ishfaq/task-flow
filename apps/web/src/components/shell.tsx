import { useEffect, useRef } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { cn } from '../lib/cn.js';
import { Avatar, Button } from './primitives.js';
import { Sidebar } from './sidebar.js';
import { CommandPalette } from './command-palette.js';
import { NotificationBell } from '../features/chat/notification-bell.js';
import { CallSurface } from '../features/rtc/call-surface.js';

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
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
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
        /* The pre-org state has no drawer, so its switcher is an ordinary flex
           child with a fixed width — which below `md` left the org picker about
           180px to render "Choose an organization" in, header and all. Stacking
           is the fix rather than a narrower column: at this width there is no
           room for two, and the switcher is the one thing on this screen that
           is not the choice being made. */
        !hasOrg && 'flex-col md:flex-row',
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
             desktop layout `Sidebar`'s own `open ? w-60 : w-12` already
             handles is untouched by anything here. */
          hasOrg &&
            cn(
              'fixed inset-y-0 left-0 z-40 transition-transform duration-200 md:static md:translate-x-0',
              mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
            ),
          /* Stacked (pre-org, below `md`) it belongs UNDER the choice, not
             above it: source order puts it first because at `md`+ it is the
             left column, and `order-last` restores the reading order the
             layout implies without moving it in the DOM. */
          !hasOrg && 'order-last md:order-0',
        )}
      >
        {hasOrg && <Sidebar />}
        <SidebarFooter standalone={!hasOrg} />
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

      <div className="flex min-w-0 flex-1 flex-col">
        <Header showMenuButton={hasOrg} />
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
        <main className="relative min-h-0 flex-1 overflow-x-auto">
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
        'mt-auto flex shrink-0 items-center gap-1 border-t border-line bg-surface-raised p-2',
        /* With no tree above it there is nothing to inherit a width from, and a
           switcher sized to the word "Select organization" is not a layout. The
           fixed width is `md`+ ONLY: below that the pre-org shell stacks, and a
           240px column there consumed more than half a phone's width, leaving
           the org picker to wrap "Choose an organization" over three lines and
           truncating the header to "Orga…" and "Settir". */
        standalone ? 'w-full border-r-0 md:w-60 md:border-r' : 'border-r',
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
function Header({ showMenuButton }: { readonly showMenuButton: boolean }) {
  const setShortcutsOpen = useUi((state) => state.setShortcutsOpen);
  const toggleMobileNav = useUi((state) => state.toggleMobileNav);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
      {/* Below `md`, the sidebar is an off-canvas drawer (Shell) with no
          permanent trigger of its own — this is the only way to open it.
          `showMenuButton` is false in the org-picker's pre-org state, where
          Shell renders no drawer at all for this to open. */}
      {showMenuButton && (
        <button
          type="button"
          onClick={toggleMobileNav}
          aria-label="Open navigation"
          className="-ml-1 shrink-0 rounded p-1.5 text-ink-muted hover:bg-surface-hover hover:text-ink md:hidden"
        >
          <span aria-hidden="true">☰</span>
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
          className="shrink-0 rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
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
      : pathname.startsWith('/search')
        ? 'Search'
        : pathname.startsWith('/chat')
          ? 'Chat'
          : pathname.startsWith('/docs')
            ? 'Docs'
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
                      : pathname.startsWith('/platform-admin')
                        ? 'Platform admin'
                        : pathname.startsWith('/orgs')
                          ? 'Organizations'
                          : 'TaskFlow';

  /* `min-w-0` is load-bearing, not decorative: a flex item's default
     min-width is `auto`, which means it will NOT shrink below its own content
     size no matter how little room its siblings (the menu button, the
     notification bell, the nav links) leave it — so `truncate`'s
     `overflow-hidden` + `text-overflow: ellipsis` never actually engages on a
     narrow header, and the row overflows the viewport instead of eliding the
     label. This is the one-line fix for a bug that only shows up once the
     header actually gets tight, which the desktop-only build before this wave
     never exercised. */
  return <h1 className="min-w-0 truncate text-sm font-medium text-ink">{label}</h1>;
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
      className="shrink-0 rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
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
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="min-w-0 flex-1 justify-start">
          <span className="truncate">{current?.name ?? 'Select organization'}</span>
          <span aria-hidden="true" className="ml-auto">
            ▾
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="min-w-48">
        {memberships.map((org) => (
          <DropdownMenuItem
            key={org.orgId}
            onSelect={() => {
              switchTo(org.orgId as OrgId);
            }}
          >
            <span>{org.name}</span>
            <span className="text-[11px] text-ink-faint">{org.role}</span>
          </DropdownMenuItem>
        ))}

        {memberships.length > 0 && <DropdownMenuSeparator />}

        {/* The unconditional way to `/orgs`. It is also the only way to CREATE
            an org, which the switcher cannot offer and which a caller with no
            memberships needs before anything else in the app works. */}
        <DropdownMenuItem
          tone="muted"
          onSelect={() => {
            void navigate({ to: '/orgs' });
          }}
        >
          All organizations…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

function AccountMenu() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const email = useSession((state) => state.email);
  const sessionId = useSession((state) => state.sessionId);

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
          className="shrink-0 rounded p-0.5 hover:bg-surface-hover"
        >
          {/* `email` is in memory only and is null after a reload — see
              session.ts on why it is deliberately not persisted. The session id
              keeps the avatar's colour stable across that gap rather than having
              it change on every refresh. */}
          <Avatar userId={sessionId ?? 'anonymous'} label={email ?? 'Account'} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="min-w-44">
        {email !== null && (
          <>
            <p className="truncate px-2 py-1.5 text-xs text-ink-faint">{email}</p>
            <DropdownMenuSeparator />
          </>
        )}
        {/* `/account` — requireSession only, not requireOrg (ai/account-page.md).
            Reachable from here specifically because it must be: the org
            switcher above it is the one place someone can be signed in with
            no org selected, and this is the account menu's only other item. */}
        <DropdownMenuItem
          onSelect={() => {
            void navigate({ to: '/account' });
          }}
        >
          Profile settings
        </DropdownMenuItem>
        {isOperator.data === true && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void navigate({ to: '/platform-admin' });
              }}
            >
              Platform admin
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem onSelect={leave}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}
