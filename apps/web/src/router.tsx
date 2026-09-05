import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BoardIdSchema,
  CardIdSchema,
  ChannelIdSchema,
  OrgIdSchema,
  PageIdSchema,
  ProjectIdSchema,
  SpaceIdSchema,
  SprintIdSchema,
} from '@taskflow/contracts';
import { FilterTree } from '@taskflow/filter';
import { useSession } from './lib/session.js';
import { Shell } from './components/shell.js';
import { FeatureGate } from './components/feature-gate.js';
import { CapabilityGate } from './components/capability-gate.js';
import { LoginPage } from './features/auth/login-page.js';
import { RegisterPage } from './features/auth/register-page.js';
import { VerifyEmailPage } from './features/auth/verify-email-page.js';
import { ResetPasswordPage } from './features/auth/reset-password-page.js';
import { ForgotPasswordPage } from './features/auth/forgot-password-page.js';
import { OAuthCallbackPage } from './features/auth/oauth-callback-page.js';
import { AccountPage } from './features/auth/account-page.js';
import { PeoplePage } from './features/people/people-page.js';
import { PersonPage } from './features/people/person-page.js';
import { OrgPickerPage } from './features/org/org-picker-page.js';
import { ProjectsPage } from './features/work/projects-page.js';
import { HomePage } from './features/work/home-page.js';
import { BoardPage } from './features/work/board-page.js';
import { ChatPage } from './features/chat/chat-page.js';
import { TelephonyPage } from './features/telephony/telephony-page.js';
import { DocsPage } from './features/docs/docs-page.js';
import { SearchPage } from './features/search/search-page.js';
import { PublicPageView } from './features/docs/public-page.js';
import { PermissionDebugPage } from './features/admin/permission-debug-page.js';
import { SettingsPage } from './features/admin/settings-page.js';
import { AuditPage } from './features/admin/audit-page.js';
import { ProjectSettingsPage } from './features/work/project-settings-page.js';
import { SprintsPage } from './features/work/sprints-page.js';
import { PlatformAdminPage } from './features/platform-admin/platform-admin-page.js';
import { AUTOMATION_TAB_IDS, AutomationsPage } from './features/automation/automations-page.js';
import { IntegrationsCallbackPage } from './features/automation/integrations-callback-page.js';
import { AnalyticsPage } from './features/analytics/analytics-page.js';

/**
 * The route tree (PLAN.md §4.1 — typed routes and typed search params).
 *
 * Code-based rather than file-based. The generated tree buys nothing here and
 * costs a codegen step that has to run before typecheck; with a dozen routes the
 * explicit version is shorter than the config that would produce it.
 *
 * ## Search params are a trust boundary
 *
 * `validateSearch` runs on whatever is in the address bar, which anybody can
 * type or send in a link. So each schema below is the SAME parser the API uses
 * for the same value — `BoardIdSchema`, `CardIdSchema`, and `FilterTree` come
 * from the shared packages rather than being restated as `z.string()`. A filter
 * pasted into a URL is parsed against the real AST schema before it reaches a
 * component, and an unparseable one falls back rather than rendering a builder
 * over a tree that is not one.
 *
 * The server re-validates all of it regardless. This is about the app not
 * breaking on a malformed link, not about trusting the result.
 */

export interface RouterContext {
  readonly queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Shell,
});

/**
 * Sends an unauthenticated caller to the login page.
 *
 * A convenience, not a control. Every route it guards is enforced on the
 * server by `route({ permission })`, and the UI re-deriving authorization is
 * explicitly what §8.2 warns against — divergence between what the app hides and
 * what the API refuses is a bug factory. This only avoids rendering a page that
 * would answer 401 for every query on it.
 *
 * Returned rather than thrown. TanStack Router accepts either from
 * `beforeLoad`, and returning keeps the redirect an ordinary value — a thrown
 * non-Error is what `@typescript-eslint/only-throw-error` objects to, and it is
 * right to: a `throw` of a plain object is indistinguishable from a bug at every
 * catch site between here and the router.
 */
function requireSession(pathname: string) {
  return useSession.getState().status === 'authenticated'
    ? undefined
    : redirect({ to: '/login', search: { next: pathname } });
}

/** Additionally requires an org to be selected. */
function requireOrg(pathname: string) {
  const unauthenticated = requireSession(pathname);
  if (unauthenticated !== undefined) return unauthenticated;

  return useSession.getState().orgId === null ? redirect({ to: '/orgs' }) : undefined;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: z.object({
    /**
     * Where to return after signing in.
     *
     * A PATH, never a URL. `next=https://evil.example` in a link would make the
     * sign-in page a redirector to an attacker's site carrying our branding —
     * the classic open-redirect phish. Anything not starting with a single `/`
     * is discarded, and `//host` is rejected too because browsers read it as
     * protocol-relative and follow it off-site.
     */
    next: z
      .string()
      .refine((value) => value.startsWith('/') && !value.startsWith('//'))
      .catch('/')
      .optional(),
  }),
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/register',
  component: RegisterPage,
});

/**
 * The two routes an emailed link lands on.
 *
 * Their PATHS are fixed by `packages/mail/src/templates.ts`, which builds
 * `${WEB_ORIGIN}/verify-email?token=` and `${WEB_ORIGIN}/reset-password?token=`.
 * Mail already delivered cannot be corrected, so renaming either of these breaks
 * every outstanding link in every inbox — retroactively, with no way to tell who
 * is affected. They are a published contract, not an internal path.
 *
 * The token schema matches the API's input (`z.string().min(1).max(200)`), and
 * `.optional()` without `.catch` on purpose: a link that arrives WITHOUT a token
 * should render "this link is incomplete", not silently submit an empty string
 * and report an invalid token.
 */
const TokenSearch = z.object({
  token: z.string().min(1).max(200).optional(),
});

const verifyEmailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/verify-email',
  validateSearch: TokenSearch,
  component: VerifyEmailPage,
});

const resetPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: TokenSearch,
  component: ResetPasswordPage,
});

const forgotPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: ForgotPasswordPage,
});

/**
 * Where every OAuth redirect lands (Phase 12 Wave 2 §3.3). `$provider` is a
 * PATH param, not a search param, because it is also a fixed piece of the
 * redirect URI `server.ts` registers with each provider's console — see
 * `oauth-callback-page.tsx`'s own header on why that makes it a published
 * contract, the same as `verifyEmailRoute`'s path below.
 *
 * `code`/`state` are what the provider echoes back; `error` is what it sends
 * instead when the person declines the consent screen. All three are
 * `.optional()` with no `.catch` — a callback missing what it needs should
 * render "this link is incomplete," the same choice `TokenSearch` makes for
 * a mail link, not silently attempt an empty exchange.
 */
const oauthCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/oauth/callback/$provider',
  parseParams: (params) => ({ provider: z.enum(['google', 'github']).parse(params.provider) }),
  stringifyParams: (params) => ({ provider: params.provider }),
  validateSearch: z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
  }),
  component: OAuthCallbackPage,
});

/**
 * Where every CONNECTOR OAuth redirect lands (Phase 10 Wave 4 slice 2, §7).
 *
 * A deliberately DIFFERENT path from `oauthCallbackRoute` above: the two
 * flows mint different signed-state claims and must never cross-complete, so
 * the paths are separate contracts with the providers' consoles. No
 * `beforeLoad` guard — the round trip loses the in-memory token, `complete`
 * is a public route trusting the state, and only the GitHub repo picker
 * (which follows) needs a session, recovered by the shell's boot-time
 * `restore()`. Same search contract as the login callback: missing pieces
 * render "this link is incomplete", never a silent empty exchange.
 */
const integrationsCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/integrations/callback/$provider',
  parseParams: (params) => ({ provider: z.enum(['slack', 'github']).parse(params.provider) }),
  stringifyParams: (params) => ({ provider: params.provider }),
  validateSearch: z.object({
    code: z.string().min(1).optional(),
    state: z.string().min(1).optional(),
    error: z.string().optional(),
  }),
  component: IntegrationsCallbackPage,
});

const orgsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/orgs',
  beforeLoad: () => requireSession('/orgs'),
  component: OrgPickerPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    const { status, orgId } = useSession.getState();
    if (status !== 'authenticated') return redirect({ to: '/login' });
    return redirect({ to: orgId === null ? '/orgs' : '/projects' });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  beforeLoad: () => requireOrg('/projects'),
  component: ProjectsPage,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/home',
  beforeLoad: () => requireOrg('/home'),
  component: HomePage,
});

/**
 * The board — kanban and table over the same query (§10.4).
 *
 * `card` is a search param rather than a nested route because §10.5 requires the
 * detail panel to be deep-linkable and back-button correct while the board
 * stays mounted behind it. A child route would unmount the board.
 */
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/boards/$boardId',
  parseParams: (params) => ({ boardId: BoardIdSchema.parse(params.boardId) }),
  stringifyParams: (params) => ({ boardId: params.boardId }),
  validateSearch: z.object({
    view: z.enum(['board', 'table', 'list', 'insights']).catch('board').optional(),
    card: CardIdSchema.optional().catch(undefined),
    project: ProjectIdSchema.optional().catch(undefined),
    /**
     * The filter tree, in the URL so a filtered view is shareable.
     *
     * Parsed with the real `FilterTree` schema — depth limit, node budget,
     * operator/value pairing and all. `.catch(undefined)` means a corrupted link
     * shows the unfiltered board instead of an error page, which is the right
     * failure for a view: the URL is a suggestion, and the board is still
     * useful without it.
     */
    filter: FilterTree.optional().catch(undefined),
    /** View settings (`ai/phase-3.5-work-ux.md` §5.6) — also shareable, same reasoning as `filter`. */
    groupBy: z.enum(['list', 'status', 'assignee', 'priority', 'due']).catch('list').optional(),
    sortBy: z.enum(['manual', 'title', 'due', 'priority']).catch('manual').optional(),
    /**
     * The sprint dimension (`ai/phase-10.5-sprints.md`) — a sprint board is
     * the same board, filtered, with a shareable link.
     *
     * `backlog` is the one non-id: the backlog is NOT a row (decision 4), so
     * the URL names it literally, alongside real sprint ids. Anything else
     * falls back to absent — All — because the URL is a suggestion and the
     * unfiltered board is always true.
     */
    sprint: z
      .union([z.literal('backlog'), SprintIdSchema])
      .optional()
      .catch(undefined),
  }),
  beforeLoad: ({ params }) => requireOrg(`/boards/${params.boardId}`),
  component: BoardPage,
});

/**
 * Channels and direct messages (Phase 5, ai/phase-5-chat.md §5 Wave 1).
 *
 * `channel` is a search param rather than a nested route, for the same reason
 * `boardRoute`'s `card` is: it must be deep-linkable and back-button correct
 * while the channel list stays mounted, and a child route would unmount it on
 * every switch.
 */
/**
 * The org directory and one member's detail (Phase 11.5, ai/phase-11.5-people.md).
 *
 * `requireOrg` — both pages are org surfaces: the directory is `member:read`
 * and the detail page's admin affordances are `member:manage`, neither of
 * which means anything without a membership to scope them.
 */
const peopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/people',
  beforeLoad: () => requireOrg('/people'),
  component: PeoplePage,
});

const personRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/people/$userId',
  parseParams: (params) => ({ userId: params.userId }),
  stringifyParams: (params) => ({ userId: params.userId }),
  beforeLoad: () => requireOrg('/people'),
  component: function PersonRoute() {
    const { userId } = personRoute.useParams();
    return <PersonPage userId={userId} />;
  },
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  validateSearch: z.object({
    channel: ChannelIdSchema.optional().catch(undefined),
  }),
  beforeLoad: () => requireOrg('/chat'),
  component: () => (
    <FeatureGate flag="chat">
      <ChatPage />
    </FeatureGate>
  ),
});

/**
 * Phone numbers, calls, SMS threads, and spend (Phase 7 Wave 5 — the UI
 * consuming `apps/api/src/telephony`'s Waves 1-4).
 *
 * `tab`/`thread` are search params, not nested routes, on the identical
 * reasoning `chatRoute`'s `channel` gives — the page stays mounted and a
 * selected thread is a shareable, back-button-correct link. `tab` is not
 * branded (there is no `TelephonyTabSchema` in @taskflow/contracts; it names
 * a client-side view, not a server resource), so it is a plain closed enum
 * here. `thread` is a bare uuid rather than a branded id for the same reason
 * `router.ts`'s own inputs are — every telephony route takes
 * `z.string().uuid()`, not a branded schema (§6.3: no relationship-tuple or
 * ancestor component to a telephony resource, so nothing here needed one).
 *
 * Also wrapped in `CapabilityGate`, `anyOf` rather than a single
 * `capability` (Phase 15 §1): unlike Analytics/Automations/Audit log, none
 * of the five telephony permissions are all-or-nothing by role for a
 * Member — each is its own `authz.member_grants` row, so a Member with only
 * `sms:read` still needs to reach this route to use it. The page itself
 * (`telephony-page.tsx`) gates each TAB on its own specific capability;
 * this route-level gate only refuses someone holding NONE of the five,
 * matching the sidebar's own `anyOfCapabilities` on the `/calls` nav item.
 */
const telephonyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calls',
  validateSearch: z.object({
    tab: z.enum(['calls', 'numbers', 'messages', 'spend']).optional().catch(undefined),
    thread: z.string().uuid().optional().catch(undefined),
    /* Which call in the log opens expanded. Added by Phase 8 Wave 3 so a
       TRANSCRIPT search hit has somewhere to land — a hit whose permalink
       cannot open the thing it found is a result that only proves the index
       works. `.catch(undefined)` per this file's convention: a malformed id in
       a pasted link renders the log unexpanded, never an error page. */
    call: z.string().uuid().optional().catch(undefined),
  }),
  beforeLoad: () => requireOrg('/calls'),
  component: () => (
    <FeatureGate flag="telephony">
      <CapabilityGate anyOf={['readPhoneNumbers', 'placeCalls', 'readCalls', 'sendSms', 'readSms']}>
        <TelephonyPage />
      </CapabilityGate>
    </FeatureGate>
  ),
});

/**
 * Cross-product search (Phase 8 Wave 3, ai/phase-8-search.md §3.1).
 *
 * `q` is the raw TQL text the user typed — deliberately a plain string up to
 * the API's own 1,000-char bound, NOT a parsed tree. The URL is a shareable
 * query, and the server is the only parser; parsing here would validate
 * against a second copy of the grammar and reject links the API accepts (or
 * accept links the API rejects). An unparseable `q` just renders the page's
 * own error state, which is the point of the live per-token errors.
 */
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: z.object({
    q: z.string().max(1_000).optional().catch(undefined),
  }),
  beforeLoad: () => requireOrg('/search'),
  component: function SearchRoute() {
    const { q } = searchRoute.useSearch();
    return <SearchPage initialQuery={q ?? ''} />;
  },
});

/**
 * Spaces and pages (Phase 6, ai/phase-6-docs.md §5 Wave 1 of the UI).
 *
 * `space`/`page` are search params, not nested routes — the identical
 * reasoning `chatRoute`'s `channel` gives: the tree must stay mounted and
 * the open page must be deep-linkable and back-button correct, and a child
 * route would unmount the tree on every switch.
 */
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docs',
  validateSearch: z.object({
    space: SpaceIdSchema.optional().catch(undefined),
    page: PageIdSchema.optional().catch(undefined),
  }),
  beforeLoad: () => requireOrg('/docs'),
  component: () => (
    <FeatureGate flag="docs">
      <DocsPage />
    </FeatureGate>
  ),
});

/**
 * The public, no-session view of a published page (Phase 6 Wave 4, §3.9).
 *
 * No `beforeLoad` guard — the whole point is that it works with no session
 * at all. `components/shell.tsx`'s `bare` rendering already covers a route
 * hit while `status !== 'authenticated'`, which is the ordinary case for a
 * link shared outside the app; a signed-in visitor sees the normal app
 * chrome around it, which is harmless (the same content either way).
 */
const publicDocsPageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/public/docs/$orgId/$pageId',
  parseParams: (params) => ({
    orgId: OrgIdSchema.parse(params.orgId),
    pageId: PageIdSchema.parse(params.pageId),
  }),
  stringifyParams: (params) => ({ orgId: params.orgId, pageId: params.pageId }),
  component: function PublicDocsRoute() {
    const { orgId, pageId } = publicDocsPageRoute.useParams();
    return <PublicPageView orgId={orgId} pageId={pageId} />;
  },
});

/**
 * Behind `audit:read` server-side (`apps/api/src/tenancy/router.ts`'s
 * `authz.explain` — "because it reports another user's access, which is
 * exactly the information an attacker would want before choosing a
 * target"). Wrapped in `CapabilityGate capability="viewAuditLog"` — the
 * SAME capability the Audit log route already uses, since both are gated
 * on the identical permission — rather than showing this page to every
 * role and letting it answer FORBIDDEN: unlike a page reporting the
 * caller's OWN access, this one exists specifically to inspect someone
 * ELSE's, so leaving it reachable-but-refused is not a cosmetic miss, it
 * advertises the existence of a tool for probing a colleague's grants to
 * people who were never going to be allowed to use it (Phase 15 §1's sweep).
 */
const permissionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/permissions',
  beforeLoad: () => requireOrg('/admin/permissions'),
  component: () => (
    <CapabilityGate capability="viewAuditLog">
      <PermissionDebugPage />
    </CapabilityGate>
  ),
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  parseParams: (params) => ({ projectId: ProjectIdSchema.parse(params.projectId) }),
  stringifyParams: (params) => ({ projectId: params.projectId }),
  beforeLoad: ({ params }) => requireOrg(`/projects/${params.projectId}`),
  component: ProjectSettingsPage,
});

/**
 * A project's sprints (ai/phase-10.6-sprint-flow.md D2).
 *
 * Registered as a SIBLING of `/projects/$projectId` rather than a child,
 * matching how every other route in this tree is declared — the router is flat
 * here, and a nested route would be the only one of its kind. The more specific
 * path is matched first, so project settings is unaffected.
 */
const projectSprintsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/sprints',
  parseParams: (params) => ({ projectId: ProjectIdSchema.parse(params.projectId) }),
  stringifyParams: (params) => ({ projectId: params.projectId }),
  beforeLoad: ({ params }) => requireOrg(`/projects/${params.projectId}/sprints`),
  component: SprintsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => requireOrg('/settings'),
  component: SettingsPage,
});

/**
 * The personal account page (`ai/account-page.md`).
 *
 * `requireSession`, not `requireOrg` — deliberately. This is the fix for the
 * bug that motivated it: passkeys need no org, but were reachable only through
 * `/settings`, which does. Anyone signed in must reach this page, org selected
 * or not, which is also why `Shell` renders the sidebar footer (and therefore
 * the avatar menu this is reached from) even in the no-org state.
 */
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  beforeLoad: () => requireSession('/account'),
  component: AccountPage,
});

/**
 * The org audit log. `audit:read` is Admin-and-Owner-only by role, same
 * shape as analytics/automations above — see `analyticsRoute`'s comment for
 * why this wraps in `CapabilityGate`: `settings-page.tsx` already hides the
 * link itself, but a direct URL still reached the real page and surfaced a
 * raw FORBIDDEN without this.
 */
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/audit',
  beforeLoad: () => requireOrg('/settings/audit'),
  component: () => (
    <CapabilityGate capability="viewAuditLog">
      <AuditPage />
    </CapabilityGate>
  ),
});

/**
 * The platform administration console (Phase 12 Wave 1).
 *
 * `requireSession`, not `requireOrg` — deliberately, and for the same reason
 * `accountRoute` is: the console is relative to NO organization. Every route
 * behind it is `platformRoute`, which never resolves a membership and checks
 * the operator flag instead. Gating it on an org selection would lock the
 * cross-tenant console behind one tenant's membership — the exact inverse of
 * what it is for. The page itself is the access control: a non-operator who
 * reaches it gets FORBIDDEN from every query it fires.
 */
const platformAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/platform-admin',
  beforeLoad: () => requireSession('/platform-admin'),
  component: PlatformAdminPage,
});

/**
 * Analytics dashboards (Phase 11, ai/phase-11-analytics.md §3, §5).
 *
 * `tab` is a search param — same pattern as telephony and automations — so
 * the open dashboard is shareable and back-button-correct.
 *
 * `analytics:read` is Admin-and-Owner-only by role, with no way for a Member
 * to earn it via plan upgrade (unlike telephony, which every Member holds by
 * default) — so unlike most gated routes in this file, this one wraps its
 * component in `CapabilityGate` as well as `FeatureGate`: a Member reaching
 * this URL directly (typed, bookmarked, or the back button) sees a plain
 * "not for your role" page instead of the real dashboard trying to load and
 * surfacing a raw FORBIDDEN. `CapabilityGate` is still only a COSMETIC
 * gate — see its own doc comment — every route behind it still declares
 * `permission: 'analytics:read'` and the server re-checks it regardless.
 */
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  validateSearch: z.object({
    tab: z
      .enum(['velocity', 'burndown', 'cfd', 'cycle-time', 'workload', 'volume', 'status'])
      .optional()
      .catch(undefined),
  }),
  beforeLoad: () => requireOrg('/analytics'),
  component: () => (
    <CapabilityGate capability="viewAnalytics">
      <FeatureGate flag="analytics">
        <AnalyticsPage />
      </FeatureGate>
    </CapabilityGate>
  ),
});

/**
 * Automation rules (Phase 10 Wave 1).
 *
 * `requireOrg`, not `requireSession`: rules are org-scoped, and every query
 * this page fires needs an org header.
 *
 * Same reasoning as `analyticsRoute` above: `automation:manage` is
 * Admin-and-Owner-only by role with no plan-upgrade path for a Member, so
 * this also wraps in `CapabilityGate` — a direct URL/bookmark shows "not for
 * your role" instead of a raw FORBIDDEN. The server still re-checks
 * `automation:manage` on every route regardless; this only changes what a
 * Member who cannot use it sees on the way there.
 */
const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/automations',
  validateSearch: z.object({
    /* Which half of the surface is open. A search param rather than nested
       routes, the same shape `/calls` and `/settings` use, so the open tab is
       a shareable, back-button-correct link. `.catch(undefined)` per this
       file's convention: a junk value renders Rules, never an error page.

       The enum comes from the page itself (`AUTOMATION_TAB_IDS`), not from a
       second copy — the first version restated `['rules', 'webhooks']` here
       and the page later grew an API-tokens tab the router had never heard
       of, so clicking it navigated to `?tab=apiTokens`, validation refused
       the value, and the click did nothing. A tab that cannot open is worse
       than a missing tab: it looks broken rather than absent. */
    tab: z.enum(AUTOMATION_TAB_IDS).optional().catch(undefined),
  }),
  beforeLoad: () => requireOrg('/automations'),
  component: () => (
    <CapabilityGate capability="viewAutomations">
      <FeatureGate flag="automation">
        <AutomationsPage />
      </FeatureGate>
    </CapabilityGate>
  ),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  verifyEmailRoute,
  resetPasswordRoute,
  forgotPasswordRoute,
  oauthCallbackRoute,
  integrationsCallbackRoute,
  orgsRoute,
  homeRoute,
  projectsRoute,
  projectSettingsRoute,
  projectSprintsRoute,
  boardRoute,
  peopleRoute,
  personRoute,
  chatRoute,
  searchRoute,
  telephonyRoute,
  docsRoute,
  publicDocsPageRoute,
  settingsRoute,
  auditRoute,
  permissionsRoute,
  accountRoute,
  platformAdminRoute,
  automationsRoute,
  analyticsRoute,
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    /* The query cache is the source of truth for freshness; letting the router
       cache loader results too would give two answers to "is this stale". */
    defaultPreloadStaleTime: 0,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
