import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { BoardIdSchema, CardIdSchema, ProjectIdSchema } from '@taskflow/contracts';
import { FilterTree } from '@taskflow/filter';
import { useSession } from './lib/session.js';
import { Shell } from './components/shell.js';
import { LoginPage } from './features/auth/login-page.js';
import { RegisterPage } from './features/auth/register-page.js';
import { VerifyEmailPage } from './features/auth/verify-email-page.js';
import { ResetPasswordPage } from './features/auth/reset-password-page.js';
import { ForgotPasswordPage } from './features/auth/forgot-password-page.js';
import { OrgPickerPage } from './features/org/org-picker-page.js';
import { ProjectsPage } from './features/work/projects-page.js';
import { HomePage } from './features/work/home-page.js';
import { BoardPage } from './features/work/board-page.js';
import { PermissionDebugPage } from './features/admin/permission-debug-page.js';
import { SettingsPage } from './features/admin/settings-page.js';
import { AuditPage } from './features/admin/audit-page.js';
import { ProjectSettingsPage } from './features/work/project-settings-page.js';

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
    view: z.enum(['board', 'table', 'list']).catch('board').optional(),
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
  }),
  beforeLoad: ({ params }) => requireOrg(`/boards/${params.boardId}`),
  component: BoardPage,
});

const permissionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/permissions',
  beforeLoad: () => requireOrg('/admin/permissions'),
  component: PermissionDebugPage,
});

const projectSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  parseParams: (params) => ({ projectId: ProjectIdSchema.parse(params.projectId) }),
  stringifyParams: (params) => ({ projectId: params.projectId }),
  beforeLoad: ({ params }) => requireOrg(`/projects/${params.projectId}`),
  component: ProjectSettingsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => requireOrg('/settings'),
  component: SettingsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/audit',
  beforeLoad: () => requireOrg('/settings/audit'),
  component: AuditPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  verifyEmailRoute,
  resetPasswordRoute,
  forgotPasswordRoute,
  orgsRoute,
  homeRoute,
  projectsRoute,
  projectSettingsRoute,
  boardRoute,
  settingsRoute,
  auditRoute,
  permissionsRoute,
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
