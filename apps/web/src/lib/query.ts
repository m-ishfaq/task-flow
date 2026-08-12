import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { errorCodeOf, isUnauthenticated } from './trpc.js';
import { refresh, useSession } from './session.js';

/**
 * The query client (PLAN.md §10.5).
 *
 * The state ownership rule this configuration serves: SERVER STATE LIVES HERE,
 * always. Boards, cards, comments, members — everything fetched. Zustand holds
 * only what has no server representation (`ui-store.ts`). Copying a card out of
 * the cache into a store is the single most reliable way for an app this size to
 * rot, because the copy has no invalidation story and drifts silently.
 */

/**
 * Failures that retrying cannot fix.
 *
 * Retrying an authorization failure is worse than useless: it triples the audit
 * noise for a denied action and delays the message the user needs by several
 * seconds. Retrying a validation failure re-sends the same invalid input.
 */
const TERMINAL_CODES = new Set([
  'FORBIDDEN',
  'NOT_A_MEMBER',
  'ORG_SUSPENDED',
  'ORG_BILLING_LAPSED',
  'NOT_FOUND',
  'GONE',
  'VALIDATION_FAILED',
  'CONFLICT',
  'ALREADY_EXISTS',
  'STEP_UP_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'QUOTA_EXCEEDED',
]);

function shouldRetry(failureCount: number, error: unknown): boolean {
  /* An expired access token is handled by `authHeaders()` before the request is
     sent, so reaching here means the refresh itself failed — the session is
     gone, and retrying just repeats a signed-out request. */
  if (isUnauthenticated(error)) return false;

  const code = errorCodeOf(error);
  if (code !== null && TERMINAL_CODES.has(code)) return false;

  return failureCount < 2;
}

/**
 * What to do when the selected organization turns out not to be one the caller
 * belongs to. Registered by `app.tsx`, which owns the router.
 *
 * A callback rather than an import because this module cannot reach the router
 * without a cycle — `router.tsx` pulls in every page, and every page pulls in
 * this file for `keys`.
 */
let orgLostHandler: (() => void) | null = null;

export function onOrgLost(handler: () => void): void {
  orgLostHandler = handler;
}

/**
 * Makes NOT_A_MEMBER self-healing.
 *
 * The code means the org header named an org with no active membership behind
 * it — a stored selection that outlived the membership, the database, or the
 * user who chose it. `OrgGate` catches that at boot, but not everything happens
 * at boot: a membership can be revoked while the tab is open, and then every
 * query on the page fails terminally with no way back. It was classified as a
 * terminal code below (correctly — retrying changes nothing) and that is where
 * it stopped, leaving an error card and no route out except signing out.
 *
 * Dropping the selection is what unsticks it, and the router guard then sends
 * the user to the picker.
 */
function recoverFromLostOrg(error: unknown): void {
  if (errorCodeOf(error) !== 'NOT_A_MEMBER') return;

  const { orgId, selectOrg } = useSession.getState();
  /* Both the "already recovered" test and the re-entrancy guard, in one line: a
     board fires a dozen queries and all twelve fail with the same code, but only
     the first still has an org to drop. Without it the handler would navigate
     twelve times and clear the cache under each of them. */
  if (orgId === null) return;

  selectOrg(null);
  orgLostHandler?.();
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    /* On the caches rather than in each query's `onError`, because it has to
       fire for a failure nobody wrote a handler for — which is every query on a
       page whose org just went away. */
    queryCache: new QueryCache({ onError: recoverFromLostOrg }),
    mutationCache: new MutationCache({ onError: recoverFromLostOrg }),

    defaultOptions: {
      queries: {
        retry: shouldRetry,

        /* Long enough that opening a card and coming back does not refetch the
           board, short enough that a colleague's change appears without a
           reload. Phase 5 replaces most of this with socket invalidation, at
           which point staleness stops being a timing guess. */
        staleTime: 30_000,
        gcTime: 5 * 60_000,

        /* On by default, and deliberately kept: returning to a tab after lunch
           should not show yesterday's board. */
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },

      mutations: {
        /* Mutations are NOT retried automatically. Almost every one here is
           non-idempotent — `cards.create` twice is two cards, `comments.create`
           twice is two comments — and a retry after an ambiguous timeout is how
           duplicates appear. §7 specifies mutation ids for idempotent replay;
           until those are wired through, the safe default is one attempt. */
        retry: false,
      },
    },
  });
}

/**
 * Drops every cached response.
 *
 * Called on sign-out and on an org switch, and both reasons are the same one:
 * the cache is keyed by query, not by identity. Without this, signing out and
 * back in as someone else renders the previous user's board from cache until
 * each query settles — the data is stale rather than stolen, but it is another
 * tenant's data on screen, and no amount of server-side scoping can help once
 * the browser already has it.
 */
export function resetCache(client: QueryClient): void {
  client.clear();
}

/**
 * Drops every org-scoped response and keeps the cross-org `orgs` list.
 *
 * Used on the NOT_A_MEMBER recovery path, where `resetCache` would be wrong in
 * a way that loops: clearing removes the `orgs` query too, the picker we are
 * navigating to re-requests it immediately, and the org switcher that is still
 * mounted requests it again. The list is answered by `withUserScope` and belongs
 * to the user, not to the org being dropped, so there is nothing to protect by
 * evicting it.
 *
 * The literal `['org']` is the prefix `keys.org()` builds on. It does NOT match
 * `keys.orgs()` — TanStack compares key segments, and `'orgs' !== 'org'`.
 */
export function dropOrgScopedQueries(client: QueryClient): void {
  client.removeQueries({ queryKey: ['org'] });
}

/**
 * Query keys.
 *
 * Every key begins with the org id, so a switch cannot serve one tenant's data
 * under another's key even for the moment before `resetCache` runs. It also
 * makes the invalidation story readable: `['org', id, 'board', boardId]`
 * invalidates a board and nothing else.
 */
export const keys = {
  orgs: () => ['orgs'] as const,

  /** Personal, not org-scoped — a passkey signs into the account, not one org. */
  passkeys: () => ['auth', 'passkeys'] as const,

  /** Whether the caller's own account has a confirmed TOTP factor (Phase 12 Wave 2 §3.2). */
  totpStatus: () => ['auth', 'totp', 'status'] as const,

  /** Which OAuth providers this server has credentials for (Phase 12 Wave 2 §3.3). */
  oauthProviders: () => ['auth', 'oauth', 'providers'] as const,
  /** The caller's own linked OAuth providers. */
  oauthConnected: () => ['auth', 'oauth', 'connected'] as const,

  /** The caller's own account (`/account`) — answers with no org selected. */
  me: () => ['auth', 'me'] as const,

  /** The caller's own active sessions — §3.4's device inventory (Phase 12 Wave 2). */
  sessions: () => ['auth', 'sessions'] as const,

  /**
   * The caller's own merged profile (Phase 11.5, people/api.ts).
   *
   * Deliberately NOT `keys.me()`: `auth.me` answers with the four-field
   * identity shape (session bootstrap) while `people.profile.get` carries the
   * full merged view — timezone, working hours, OOO. Sharing a key would make
   * two different-shaped responses race for one cache entry and the page
   * would render whichever won.
   */
  profile: () => ['people', 'profile'] as const,

  org: (orgId: string) => ['org', orgId] as const,

  /** The org's own billing state (Phase 12 Wave 3 §3.1) — `billing.status`, owner-only. */
  billing: (orgId: string) => ['org', orgId, 'billing'] as const,

  /**
   * Every projects query for an org, archived or not.
   *
   * The PREFIX, so invalidating it covers both variants below — a project
   * created while the archived view is open must invalidate the live list too,
   * and a key per variant with no shared prefix would leave one of them stale.
   */
  projects: (orgId: string) => ['org', orgId, 'projects'] as const,
  /** One projects query. `includeArchived` changes the response, so it is in the key. */
  projectList: (orgId: string, includeArchived: boolean) =>
    ['org', orgId, 'projects', includeArchived ? 'all' : 'live'] as const,
  boards: (orgId: string, projectId: string) =>
    ['org', orgId, 'projects', projectId, 'boards'] as const,

  lists: (orgId: string, boardId: string) => ['org', orgId, 'board', boardId, 'lists'] as const,
  views: (orgId: string, boardId: string) => ['org', orgId, 'board', boardId, 'views'] as const,
  cards: (orgId: string, boardId: string, filterKey: string) =>
    ['org', orgId, 'board', boardId, 'cards', filterKey] as const,
  /** Every cards query for a board, whatever filter it carries. */
  cardsOfBoard: (orgId: string, boardId: string) =>
    ['org', orgId, 'board', boardId, 'cards'] as const,

  /** Cross-board — every live card assigned to the caller (`home-page.tsx`). */
  myCards: (orgId: string) => ['org', orgId, 'myCards'] as const,

  card: (orgId: string, cardId: string) => ['org', orgId, 'card', cardId] as const,
  cardLabels: (orgId: string, cardId: string) => ['org', orgId, 'card', cardId, 'labels'] as const,
  cardFields: (orgId: string, cardId: string) => ['org', orgId, 'card', cardId, 'fields'] as const,
  checklists: (orgId: string, cardId: string) =>
    ['org', orgId, 'card', cardId, 'checklists'] as const,
  comments: (orgId: string, cardId: string) => ['org', orgId, 'card', cardId, 'comments'] as const,
  attachments: (orgId: string, cardId: string) =>
    ['org', orgId, 'card', cardId, 'attachments'] as const,

  labels: (orgId: string, projectId: string) =>
    ['org', orgId, 'projects', projectId, 'labels'] as const,
  statuses: (orgId: string, projectId: string) =>
    ['org', orgId, 'projects', projectId, 'statuses'] as const,
  sprints: (orgId: string, projectId: string) =>
    ['org', orgId, 'projects', projectId, 'sprints'] as const,
  fields: (orgId: string, projectId: string) =>
    ['org', orgId, 'projects', projectId, 'fields'] as const,

  members: (orgId: string) => ['org', orgId, 'members'] as const,
  explain: (orgId: string, input: string) => ['org', orgId, 'authz', 'explain', input] as const,

  /** Every channel the caller may see (Phase 5, chat/api.ts) — public, private, and DMs alike. */
  channels: (orgId: string) => ['org', orgId, 'channels'] as const,
  channel: (orgId: string, channelId: string) => ['org', orgId, 'channel', channelId] as const,
  messages: (orgId: string, channelId: string) =>
    ['org', orgId, 'channel', channelId, 'messages'] as const,
  reactions: (orgId: string, channelId: string) =>
    ['org', orgId, 'channel', channelId, 'reactions'] as const,
  pins: (orgId: string, channelId: string) => ['org', orgId, 'channel', channelId, 'pins'] as const,
  /** Every pin the caller can see, across every channel — the sidebar panel. */
  allPins: (orgId: string) => ['org', orgId, 'chat', 'pins'] as const,
  /** Who currently holds guest access to one channel. */
  channelGuests: (orgId: string, channelId: string) =>
    ['org', orgId, 'channel', channelId, 'guests'] as const,
  /** Unread counts for the sidebar badge — one query across every channel id given. */
  unreadCounts: (orgId: string) => ['org', orgId, 'channels', 'unread'] as const,

  /** Every space the caller may see (Phase 6, docs/api.ts). */
  spaces: (orgId: string) => ['org', orgId, 'spaces'] as const,
  /** Every page in one space, flat — the client groups by `parentPageId` (docs.service.ts's own convention). */
  pages: (orgId: string, spaceId: string) => ['org', orgId, 'space', spaceId, 'pages'] as const,
  page: (orgId: string, pageId: string) => ['org', orgId, 'page', pageId] as const,
  pageVersions: (orgId: string, pageId: string) =>
    ['org', orgId, 'page', pageId, 'versions'] as const,
  pageComments: (orgId: string, pageId: string) =>
    ['org', orgId, 'page', pageId, 'comments'] as const,
  pageSuggestions: (orgId: string, pageId: string) =>
    ['org', orgId, 'page', pageId, 'suggestions'] as const,
  pageTemplates: (orgId: string, spaceId: string) =>
    ['org', orgId, 'space', spaceId, 'templates'] as const,
  /** "What links here" for one page (Phase 6 Wave 4, docs/api.ts). */
  pageBacklinks: (orgId: string, pageId: string) =>
    ['org', orgId, 'page', pageId, 'backlinks'] as const,

  /** The org directory (Phase 11.5, people/api.ts). One key per cursor — the cursor IS the page. */
  directory: (orgId: string, cursor: string | null) =>
    ['org', orgId, 'people', 'directory', cursor ?? 'first'] as const,
  /** Every directory page, whatever cursor — invalidating this refetches the whole directory. */
  directoryAll: (orgId: string) => ['org', orgId, 'people', 'directory'] as const,
  /** One member's detail with manager and direct reports (Phase 11.5). */
  member: (orgId: string, userId: string) => ['org', orgId, 'people', 'member', userId] as const,

  /** Every phone number the org owns (Phase 7, telephony/api.ts). */
  phoneNumbers: (orgId: string) => ['org', orgId, 'telephony', 'numbers'] as const,
  /** The call log. */
  calls: (orgId: string) => ['org', orgId, 'telephony', 'calls'] as const,
  /** Recordings for one call. */
  callRecordings: (orgId: string, callId: string) =>
    ['org', orgId, 'telephony', 'call', callId, 'recordings'] as const,

  /** One recording's transcript (Phase 8 Wave 3 surfaced it; the route is Phase 7's). */
  callTranscript: (orgId: string, recordingId: string) =>
    ['org', orgId, 'telephony', 'recording', recordingId, 'transcript'] as const,
  /** Recordings attached to one Work card (§3.9). */
  cardRecordings: (orgId: string, cardId: string) =>
    ['org', orgId, 'card', cardId, 'recordings'] as const,
  /**
   * Dialable people — the directory folded down to members who have a work
   * phone (`telephony/api.ts`). Its own key rather than `directory(orgId, …)`:
   * that key is one page per cursor, and this one is every page merged.
   */
  phoneContacts: (orgId: string) => ['org', orgId, 'telephony', 'contacts'] as const,
  /**
   * Search results for one trimmed TQL query (`features/search/api.ts`). The
   * query TEXT is the key because the server is the only parser — a
   * client-side key that hashed a parsed tree would silently re-run for every
   * equivalent-but-different spelling of the same query.
   */
  search: (orgId: string, query: string) => ['org', orgId, 'search', query] as const,

  /**
   * Every saved search the caller may see — shared plus their own (§3.2).
   *
   * Its own root segment rather than `['org', orgId, 'search', 'saved']`,
   * which would COLLIDE with `search(orgId, 'saved')` — the results of
   * literally searching for the word "saved". A cache key that two different
   * queries can produce hands one of them the other's data, and the query
   * segment here is free-form user text, so the collision is reachable by
   * typing.
   */
  savedSearches: (orgId: string) => ['org', orgId, 'saved-searches'] as const,

  /** Every automation rule in the org (Phase 10 Wave 1). */
  automations: (orgId: string) => ['org', orgId, 'automations'] as const,
  /**
   * Run history, either for one rule or across the org.
   *
   * The scope is a distinct segment rather than an optional trailing one:
   * `[... 'runs']` and `[... 'runs', id]` are different queries with different
   * data, and a key that collapses them hands one the other's results.
   */
  automationRuns: (orgId: string, automationId: string | null) =>
    ['org', orgId, 'automations', 'runs', automationId ?? 'all'] as const,
  /** Every registered webhook endpoint (Wave 2). */
  webhooks: (orgId: string) => ['org', orgId, 'automations', 'webhooks'] as const,
  /** Delivery history for one endpoint. */
  webhookDeliveries: (orgId: string, webhookId: string) =>
    ['org', orgId, 'automations', 'webhooks', webhookId, 'deliveries'] as const,
  /** Every programmatic-access token in the org (Wave 3, §6). */
  apiTokens: (orgId: string) => ['org', orgId, 'automations', 'api-tokens'] as const,
  /** The caller's currently held permissions — the scope checklist's options. */
  apiTokenScopes: (orgId: string) => ['org', orgId, 'automations', 'api-tokens', 'scopes'] as const,
  /** Every SMS thread. */
  messageThreads: (orgId: string) => ['org', orgId, 'telephony', 'threads'] as const,
  /** Messages in one thread. */
  threadMessages: (orgId: string, threadId: string) =>
    ['org', orgId, 'telephony', 'thread', threadId, 'messages'] as const,
  /** Current spend vs. cap — the member-visible figure. */
  spendCurrent: (orgId: string) => ['org', orgId, 'telephony', 'spend', 'current'] as const,
  /** Cost attribution by kind (Wave 4) — the admin-visible report. */
  spendReport: (orgId: string, sinceDays: number) =>
    ['org', orgId, 'telephony', 'spend', 'report', sinceDays] as const,

  /* --- Platform admin (Phase 12 Wave 1) -----------------------------------
     Cross-tenant by definition, so deliberately NOT org-prefixed: these
     queries answer without a membership, and keying them under an org would
     make them disappear whenever no org is selected — which is exactly the
     moment the account-menu link (and the page it opens) must work. */
  /** `self.check` — the account menu's one cheap, no-step-up probe. */
  platformSelf: () => ['platform', 'self'] as const,
  /** One page of the org directory. The cursor IS the page. */
  platformOrgs: (cursor: string | null) => ['platform', 'orgs', cursor ?? 'first'] as const,
  /** One page of the user directory. */
  platformUsers: (cursor: string | null) => ['platform', 'users', cursor ?? 'first'] as const,
  /** The flag registry with resolved values. */
  platformFlags: () => ['platform', 'flags'] as const,
  /** One page of the billing directory (Phase 12 Wave 3 §3.6). */
  platformBilling: (cursor: string | null) => ['platform', 'billing', cursor ?? 'first'] as const,
  /** One page of the operator chain. Keyset on seq — the page is `before`. */
  platformAudit: (before: string | null) => ['platform', 'audit', before ?? 'latest'] as const,
} as const;

/** The org id every key needs, or a placeholder that matches nothing. */
export function useOrgKey(): string {
  return useSession((state) => state.orgId) ?? 'none';
}

/** Forces a fresh exchange, e.g. after a step-up prompt. */
export async function reauthenticate(): Promise<void> {
  await refresh();
}
