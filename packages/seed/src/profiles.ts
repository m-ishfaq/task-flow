import type { Role } from '@taskflow/policy';
import type { schema } from '@taskflow/db';

/**
 * What each profile produces, written out rather than generated.
 *
 * The demo profile below is a literal description of a database — five projects
 * with these names, this many cards on that board. That is deliberate and worth
 * defending, because the obvious alternative is a handful of `[min, max]` ranges
 * and a loop.
 *
 * Ranges make the seeder easy to write and the RESULT impossible to reason
 * about. "Is the board empty because the seeder is broken, or because the range
 * rolled a one?" is a question a developer should never have to ask, and the
 * shapes that matter here — a project with no boards, a board with no cards, one
 * column large enough to need virtualization — are exactly the ones a uniform
 * range almost never produces.
 *
 * So the STRUCTURE is declared and the CONTENT is generated. Ranges survive only
 * in `CardMix`, where the variation is the point.
 */

export interface BoardPlan {
  readonly name: string;
  /** Columns, taken in order from `LIST_NAMES`. Four to six reads as a board. */
  readonly lists: number;
  /** Live cards. Archived and soft-deleted extras are added on top by the mix. */
  readonly cards: number;
  /**
   * Saved views, taken in order from `VIEW_TEMPLATES` (`modules/work.views.ts`).
   *
   * Same arrangement as `lists` taking the first N of `LIST_NAMES`: the
   * templates are ORDERED so that a board taking more of them picks up
   * progressively rarer states — the `@me` filter, then the negated label
   * filter, then a private view, then a private one colliding by name with a
   * shared one. Omitted means none, and one board per run leaves it omitted so
   * the empty view-tab strip is reachable.
   *
   * A private template produces one row per author rather than one row, which
   * is why the seeded view COUNT is higher than this number on boards that
   * reach them.
   */
  readonly views?: number;
}

export interface ProjectPlan {
  readonly name: string;
  /** The `WEB` in `WEB-142`. Must match `^[A-Z][A-Z0-9]{1,9}$`. */
  readonly key: string;
  readonly boards: readonly BoardPlan[];
  readonly labels: number;
  /**
   * Archived projects are hidden by default and restorable (§7.1).
   *
   * At least one per run, so the `includeArchived` branch of `projects.list` and
   * the "show archived" affordance have something to reveal. A filter with
   * nothing to filter looks identical to a broken one.
   */
  readonly archived?: boolean;
  /**
   * `standard` covers the four field types a project actually uses.
   * `all-types` emits all seven, so every renderer in the card panel has data —
   * exactly one project per run should carry it.
   */
  readonly customFields: 'standard' | 'all-types';
}

/**
 * One chat channel, declared rather than generated — same argument as `BoardPlan`.
 *
 * The states worth having are the ones a uniform range never rolls: an ARCHIVED
 * channel that still holds its history, a channel with NO messages at all, a
 * private channel whose roster includes a GUEST, and a tenant with no DMs
 * because it has only one member. Each of those is a line below rather than an
 * outcome somebody hopes for.
 */
export interface ChannelPlan {
  /**
   * Null for `dm` and `group_dm`.
   *
   * Not a stylistic choice: `channels_name_matches_type` (migration 0017) is one
   * CHECK over both branches, so a named DM is not merely unusual, it is a row
   * the database refuses. A DM carrying a name is exactly the row that would let
   * a private conversation appear in a channel browser.
   */
  readonly name: string | null;
  readonly type: schema.ChannelType;
  /**
   * How many people hold a membership tuple on it.
   *
   * For a public channel this is who JOINED, not who may read — every org member
   * can read a public channel through their role. The distinction is visible in
   * the product: `listChannels` derives `joined` from the tuples, so a public
   * channel with a partial roster is a channel most people have to opt into.
   *
   * For `dm` this must be 2 and for `group_dm` 3 or more; the seeder refuses
   * anything else rather than writing a conversation the product could not open.
   */
  readonly members: number;
  /** Top-level messages. Threaded replies are added on top by the mix. */
  readonly messages: number;
  readonly topic?: boolean;
  /** Archived channels keep every message and accept no new ones (§7.1). */
  readonly archived?: boolean;
  /**
   * Force the org's first guest into the roster — §3.9's channel-scoped guest
   * access. A guest grants NOTHING from their role, so this tuple is the only
   * thing in the entire database that makes chat reachable for them.
   */
  readonly withGuest?: boolean;
}

/**
 * One Docs space and the shape of the tree inside it (Phase 6).
 *
 * The declared/generated split is drawn one level lower than `BoardPlan`'s,
 * because the states worth having in a TREE are not counts — they are shapes,
 * and a random tree of the right size produces none of them reliably. So the
 * three that matter are guaranteed by construction and the rest of the tree is
 * filled in around them:
 *
 *   - `depth` builds one root-to-leaf SPINE of exactly that length, first. The
 *     nearest-ancestor grant walk (§3.4) and the `ancestor_ids` prefix match
 *     are what this phase's authorization spine rests on, and a tree that
 *     happened to come out three deep exercises neither.
 *   - `wide` gives one parent exactly that many children — sibling ranks, the
 *     `(rank, id)` ordering, and a tree render that has to hold up past a
 *     screenful.
 *   - `archivedSubtree` archives one whole branch of a LIVE space, which is a
 *     different state from an archived space and hides a different bug: a
 *     tree query that filters `archived_at IS NULL` on the page but forgets its
 *     ancestors shows orphaned children hanging off nothing.
 */
export interface SpacePlan {
  readonly name: string;
  /** Pages in total, spine and wide set included. Zero is a real state. */
  readonly pages: number;
  /** Length of the one guaranteed root-to-leaf chain. 1 means a flat space. */
  readonly depth: number;
  /** One parent given exactly this many children. Omitted means none. */
  readonly wide?: number;
  /** An archived space keeps its whole tree, exactly as an archived project does. */
  readonly archived?: boolean;
  /** Archive one whole subtree inside a live space. See the note above. */
  readonly archivedSubtree?: boolean;
  /** Grants on pages and on the space itself — per-resource, on top of the role. */
  readonly grants: number;
  /**
   * Give the org's first guest a tuple on ONE subtree and nothing else.
   *
   * The §3.3 case in fixture form: a guest's role grants nothing at all, so
   * this tuple is the entire authorization deciding whether `apps/collab`'s
   * `onAuthenticate` opens a document for them — and the pages it must NOT open
   * are the ones in the same space one level up.
   */
  readonly withGuest?: boolean;
  /** Seed real Yjs bodies — WAL rows and snapshots — for pages in this space. */
  readonly content?: boolean;
}

export interface OrgPlan {
  readonly name: string;
  readonly slug: string;
  /**
   * Indexes into the user pool, with the role held HERE.
   *
   * An index appearing in two orgs is a user who belongs to both, and the demo
   * profile does that on purpose: the org switcher, the stored-org validation in
   * `OrgGate`, and the NOT_A_MEMBER recovery path are all unreachable with
   * one-org users, and all three are described in CLAUDE.md as places bugs hid.
   */
  readonly members: readonly { readonly user: number; readonly role: Role }[];
  readonly teams: readonly string[];
  readonly projects: readonly ProjectPlan[];
  /** Relationship tuples — per-resource grants on top of the role. */
  readonly grants: number;
  readonly channels: readonly ChannelPlan[];
  readonly spaces: readonly SpacePlan[];
}

/**
 * How one card is filled in. The only place ranges belong.
 *
 * Every rate here is a probability, and the defaults are chosen so the states
 * that break UIs are common enough to hit by accident rather than rare enough to
 * ship: a quarter of cards carry no label, a third have no priority, a fifth
 * have no status.
 */
export interface CardMix {
  readonly describedRate: number;
  readonly archivedRate: number;
  readonly deletedRate: number;
  readonly noStatusRate: number;
  readonly noPriorityRate: number;
  readonly dueDateRate: number;
  readonly overdueShare: number;
  readonly startDateRate: number;
  readonly assignees: readonly [number, number];
  readonly unlabelledRate: number;
  readonly labels: readonly [number, number];
  readonly checklists: readonly [number, number];
  readonly checklistItems: readonly [number, number];
  readonly itemDoneRate: number;
  readonly comments: readonly [number, number];
  readonly editedCommentRate: number;
  readonly deletedCommentRate: number;
  readonly customFieldRate: number;
  readonly attachmentRate: number;
}

/**
 * How one message is filled in. `CardMix`'s counterpart, and ranges belong here
 * for the same reason.
 *
 * The rates are chosen so the states that break a message list are common enough
 * to hit by scrolling: roughly one message in twenty-five is a tombstone, one in
 * eight grows a thread, and most channels carry at least one pin.
 */
export interface MessageMix {
  /** Messages that grow a thread. */
  readonly threadedRate: number;
  readonly replies: readonly [number, number];
  readonly editedRate: number;
  readonly deletedRate: number;
  /**
   * Share of deletions that are a MODERATOR removing someone else's message
   * rather than an author withdrawing their own.
   *
   * The two are different rows (`deleted_by_author`) and different audit
   * entries, and the message list branches on them — a moderator removal says so
   * where a self-withdrawal does not.
   */
  readonly moderatorShare: number;
  readonly mentionRate: number;
  readonly linkRate: number;
  readonly reactedRate: number;
  readonly reactions: readonly [number, number];
  readonly pinnedPerChannel: readonly [number, number];
  /** Share of a channel's members carrying a read cursor in it. */
  readonly readCursorRate: number;
  /** Share of link-carrying messages that got a preview row. */
  readonly unfurlRate: number;
  readonly attachmentRate: number;
}

/**
 * How one page is filled in. `CardMix` and `MessageMix`'s counterpart.
 *
 * The rates here describe two different things and it is worth knowing which is
 * which: `archivedRate`, `bodyRate` and the two history rates shape what the
 * PRODUCT looks like, while `snapshotRate`, `prunedShare` and `tailRate` shape
 * what the RECOVERY PATHS look like — which combination of `docs.page_versions`
 * snapshot and `docs.yjs_updates` tail a page's content is spread across. All
 * four combinations occur in a seeded database on purpose:
 *
 *   - no snapshot, WAL only            — a page opened once and never compacted
 *   - snapshot + tail, WAL kept        — compaction ran, then editing continued
 *   - snapshot + tail, WAL pruned      — the ordinary steady state
 *   - snapshot, no tail                — compacted and untouched since
 *
 * `replayPage` (apps/collab) reconstructs all four the same way, and a bug in
 * the boundary arithmetic shows up in exactly one of them. A fixture carrying
 * only the easy case would let that ship.
 */
export interface PageMix {
  /** Pages archived individually, outside a plan's `archivedSubtree`. */
  readonly archivedRate: number;
  /** Live pages that have any body content at all. */
  readonly bodyRate: number;
  readonly blocks: readonly [number, number];
  /** WAL rows per page with a body — one per editing transaction. */
  readonly updates: readonly [number, number];
  /** Pages with a body that also have a `page_versions` row. */
  readonly snapshotRate: number;
  /** Share of those snapshots that are `manual` rather than `autosave`. */
  readonly manualShare: number;
  /** Share of snapshotted pages whose pre-snapshot WAL rows were pruned. */
  readonly prunedShare: number;
  /** Share of snapshotted pages with WAL rows written AFTER the snapshot. */
  readonly tailRate: number;
  /** Pages that emit a `page.updated` rename in their history. */
  readonly renamedRate: number;
  /** Pages that emit a `page.moved` in their history. */
  readonly movedRate: number;

  /**
   * Wave 3 additions — comments, suggestions, internal links, and the one
   * scenario Wave 2's own second bug lived in (restore).
   *
   * All four read a page's body that `docs.content` already built rather than
   * generating their own, for the reason `docs.content`'s own header gives for
   * WAL bytes: a comment anchor or an internal link is only a real fixture if
   * it points at real, structurally valid Yjs state. A page with no body
   * cannot have any of the four — there is nothing yet to anchor, link, or
   * restore.
   */

  /** Pages with a body that also get one internal `pageLink` to another page
   * in the org — what `docs.backlinks` exists to answer "what links here" for. */
  readonly pageLinkRate: number;
  /** Share of SNAPSHOTTED pages, with a tail past that snapshot, that get a
   * restore scenario: a further edit, then a version that reverts to the
   * ORIGINAL snapshot's exact bytes — the precise shape Wave 2's second bug
   * (ai/phase-6-docs.md's status header) got wrong the first time. */
  readonly restoreShare: number;
  /** Pages with a body that get any comments at all. */
  readonly commentRate: number;
  readonly commentsPerPage: readonly [number, number];
  /** Share of comments that are resolved rather than left open. */
  readonly resolvedShare: number;
  /** Pages with a body that get any suggestions at all. */
  readonly suggestionRate: number;
  readonly suggestionsPerPage: readonly [number, number];
  /** Share of suggestions that have been decided rather than left pending. */
  readonly suggestionDecidedShare: number;
  /** Of the DECIDED suggestions, the share accepted rather than rejected. */
  readonly suggestionAcceptedShare: number;
}

export interface Profile {
  readonly name: string;
  /** Size of the shared user pool. Org plans index into it. */
  readonly users: number;
  readonly orgs: readonly OrgPlan[];
  readonly card: CardMix;
  readonly message: MessageMix;
  readonly page: PageMix;
  /**
   * Share of cards that contribute lifecycle events to the outbox.
   *
   * Not 1. Every event becomes an audit entry, and each entry takes the per-org
   * chain-head lock to compute its hash — so a full-fidelity demo run would
   * spend most of its time writing an audit trail nobody asked for. Structural
   * events (orgs, members, grants, projects, boards) are always emitted; card
   * chatter is sampled.
   */
  readonly cardEventSampleRate: number;
  /**
   * The same sampling, for chat.
   *
   * Its own number rather than reusing `cardEventSampleRate` because the volumes
   * are not comparable: a demo run writes a few thousand messages against about
   * thirteen hundred cards, and every message event takes the per-org audit
   * chain-head lock on its way through. Channel STRUCTURE — created, member
   * added, archived — is always emitted, exactly as org and board structure is;
   * it is the per-message chatter that is sampled.
   */
  readonly messageEventSampleRate: number;
  /**
   * The same sampling, for docs.
   *
   * SPACE structure is always emitted, as org and channel structure is. Page
   * lifecycle is sampled for the reason cards are — and rather more so at
   * volume, since `large` plans a tree an order of magnitude bigger than its
   * board.
   */
  readonly docEventSampleRate: number;
  /** Whether to upload real objects and write attachment rows. */
  readonly attachments: boolean;
}

/** Columns, in board order. A board takes the first `lists` of these. */
export const LIST_NAMES = [
  'Backlog',
  'To Do',
  'In Progress',
  'In Review',
  'Blocked',
  'Done',
] as const;

/** The column that gets a WIP limit, and the limit. Advisory — see §10.1. */
export const WIP_LIMITED_LIST = 'In Progress';
export const WIP_LIMIT = 5;

const DEMO_MIX: CardMix = {
  describedRate: 0.7,
  archivedRate: 0.12,
  deletedRate: 0.03,
  noStatusRate: 0.2,
  noPriorityRate: 0.35,
  dueDateRate: 0.3,
  overdueShare: 0.15,
  startDateRate: 0.2,
  assignees: [0, 2],
  unlabelledRate: 0.25,
  labels: [1, 3],
  checklists: [0, 2],
  checklistItems: [3, 8],
  itemDoneRate: 0.45,
  comments: [0, 6],
  editedCommentRate: 0.08,
  deletedCommentRate: 0.04,
  customFieldRate: 0.45,
  attachmentRate: 0.08,
};

const DEMO_MESSAGE_MIX: MessageMix = {
  threadedRate: 0.12,
  replies: [1, 4],
  editedRate: 0.06,
  deletedRate: 0.04,
  moderatorShare: 0.3,
  mentionRate: 0.18,
  linkRate: 0.1,
  reactedRate: 0.22,
  reactions: [1, 3],
  pinnedPerChannel: [0, 3],
  readCursorRate: 0.7,
  unfurlRate: 0.8,
  attachmentRate: 0.05,
};

const DEMO_PAGE_MIX: PageMix = {
  archivedRate: 0.08,
  bodyRate: 0.75,
  blocks: [3, 9],
  updates: [2, 6],
  snapshotRate: 0.55,
  manualShare: 0.35,
  prunedShare: 0.5,
  tailRate: 0.7,
  renamedRate: 0.15,
  movedRate: 0.2,
  pageLinkRate: 0.3,
  restoreShare: 0.25,
  commentRate: 0.4,
  commentsPerPage: [1, 4],
  resolvedShare: 0.4,
  suggestionRate: 0.25,
  suggestionsPerPage: [1, 3],
  suggestionDecidedShare: 0.6,
  suggestionAcceptedShare: 0.65,
};

/**
 * The default. Three tenants, ~1,350 live cards, ~2,500 messages, ~150 pages,
 * every Phase 3, Phase 5 and Phase 6 (Waves 1–3) surface populated.
 */
const DEMO: Profile = {
  name: 'demo',
  users: 24,
  cardEventSampleRate: 0.35,
  messageEventSampleRate: 0.2,
  docEventSampleRate: 0.4,
  attachments: true,
  card: DEMO_MIX,
  message: DEMO_MESSAGE_MIX,
  page: DEMO_PAGE_MIX,
  orgs: [
    {
      name: 'Acme Corp',
      slug: 'acme',
      grants: 18,
      teams: ['Engineering', 'Design', 'Quality', 'Leadership'],
      members: [
        { user: 0, role: 'owner' },
        { user: 1, role: 'admin' },
        { user: 2, role: 'admin' },
        ...Array.from({ length: 12 }, (_, i) => ({ user: 3 + i, role: 'member' as const })),
        { user: 15, role: 'guest' },
        { user: 16, role: 'guest' },
        { user: 17, role: 'guest' },
      ],
      channels: [
        /* Everyone is in #general, and it is the one channel large enough for a
           three-digit unread badge and for the id cursor to page more than
           twice. */
        { name: 'general', type: 'public', members: 18, messages: 320, topic: true },
        { name: 'engineering', type: 'public', members: 11, messages: 260, topic: true },
        { name: 'design', type: 'public', members: 7, messages: 140, topic: true },
        /* Thread-heavy by content rather than by plan: an incident channel is
           where the "N replies" affordance actually has to hold up. */
        { name: 'incidents', type: 'public', members: 9, messages: 90, topic: true },
        { name: 'random', type: 'public', members: 13, messages: 180 },
        { name: 'announcements', type: 'public', members: 18, messages: 40, topic: true },
        /* A channel with NO messages. The message list, the composer and the
           unread badge each have an empty state that only this row exercises. */
        { name: 'watercooler', type: 'public', members: 4, messages: 0, topic: true },
        { name: 'leadership', type: 'private', members: 4, messages: 120, topic: true },
        { name: 'security-review', type: 'private', members: 5, messages: 80, topic: true },
        /* The guest's one channel. Signing in as them must reach exactly this
           and nothing else — the §3.9 case, and the only place in the seeded
           database where an empty role grant set is the whole authorization. */
        {
          name: 'vendor-portal',
          type: 'private',
          members: 4,
          messages: 45,
          topic: true,
          withGuest: true,
        },
        /* Archived, and populated rather than empty: "show archived" has to
           reveal a conversation that really happened, not a channel nobody
           used. */
        { name: 'old-migration', type: 'public', members: 6, messages: 60, archived: true },
        { name: null, type: 'dm', members: 2, messages: 90 },
        { name: null, type: 'dm', members: 2, messages: 55 },
        { name: null, type: 'dm', members: 2, messages: 30 },
        { name: null, type: 'dm', members: 2, messages: 12 },
        { name: null, type: 'group_dm', members: 4, messages: 70 },
      ],
      spaces: [
        /* The one space that is actually a TREE: six levels deep, and one
           parent with two dozen children. Everything the §3.4 resolver and the
           `ancestor_ids` prefix match are for is only visible here. */
        {
          name: 'Engineering Handbook',
          pages: 46,
          depth: 6,
          wide: 24,
          grants: 5,
          content: true,
        },
        /* A live space with one archived BRANCH — see `SpacePlan`'s note on why
           that is a different state from an archived space. */
        {
          name: 'Product',
          pages: 30,
          depth: 3,
          grants: 3,
          archivedSubtree: true,
          content: true,
        },
        /* The guest's one subtree. Signing in as them must reach exactly this
           and nothing else — the §3.3 case, and the only place in the seeded
           database where a page opens on a tuple alone. */
        { name: 'Runbooks', pages: 18, depth: 2, grants: 2, withGuest: true, content: true },
        /* Archived, and populated: "show archived" has to reveal a space that
           was really used, exactly as the archived project does. */
        { name: 'Onboarding', pages: 12, depth: 3, grants: 1, archived: true },
        /* A space with NO pages. The tree, the breadcrumb and the page picker
           each have an empty state that only this row exercises. */
        { name: 'Customer Research', pages: 0, depth: 1, grants: 0 },
      ],
      projects: [
        {
          name: 'Web Platform',
          key: 'WEB',
          labels: 8,
          customFields: 'all-types',
          boards: [
            /* The one board large enough to mean something. Table-view
               virtualization, rank length after hundreds of appends, and the
               filter compiler's index use are all invisible at fifty cards. */
            { name: 'Delivery', lists: 6, cards: 380, views: 9 },
            { name: 'Design Review', lists: 4, cards: 85, views: 2 },
            { name: 'Bug Triage', lists: 5, cards: 150, views: 6 },
          ],
        },
        {
          name: 'Public API',
          key: 'API',
          labels: 8,
          customFields: 'standard',
          boards: [
            { name: 'Roadmap', lists: 5, cards: 160, views: 4 },
            { name: 'Incidents', lists: 4, cards: 60, views: 2 },
          ],
        },
        {
          name: 'Mobile App',
          key: 'MOB',
          labels: 7,
          customFields: 'standard',
          boards: [{ name: 'Release 4.2', lists: 5, cards: 150, views: 3 }],
        },
        {
          name: 'Operations',
          key: 'OPS',
          labels: 6,
          customFields: 'standard',
          /* The archived project (see `ProjectPlan.archived`) — populated rather
             than empty, so the "show archived" affordance reveals a project with
             real content rather than a folder that was never used. */
          archived: true,
          boards: [
            { name: 'Runbook Tasks', lists: 4, cards: 110, views: 2 },
            { name: 'Vendor Reviews', lists: 4, cards: 40 },
          ],
        },
        /* A project with NO boards. The projects page, the sidebar tree and the
           board picker each have an empty state that only this row exercises. */
        { name: 'Design System', key: 'DES', labels: 5, customFields: 'standard', boards: [] },
      ],
    },
    {
      name: 'Globex Industries',
      slug: 'globex',
      grants: 8,
      teams: ['Compliance', 'Revenue'],
      members: [
        { user: 18, role: 'owner' },
        { user: 19, role: 'admin' },
        { user: 20, role: 'member' },
        { user: 21, role: 'member' },
        // Members of Acme as well — the two-org users. See `OrgPlan.members`.
        { user: 3, role: 'member' },
        { user: 4, role: 'guest' },
        { user: 22, role: 'guest' },
      ],
      /* The second tenant exists so the two-org users see chat in both places —
         switching orgs must swap the whole channel list, and a bug that leaks
         one tenant's channels into another is only visible when both have
         some. */
      channels: [
        { name: 'general', type: 'public', members: 7, messages: 130, topic: true },
        { name: 'revenue', type: 'public', members: 5, messages: 80, topic: true },
        { name: 'compliance', type: 'private', members: 4, messages: 60, topic: true },
        { name: 'archived-q1', type: 'public', members: 4, messages: 35, archived: true },
        { name: null, type: 'dm', members: 2, messages: 40 },
        { name: null, type: 'dm', members: 2, messages: 18 },
      ],
      /* The second tenant has docs for the same reason it has chat: the two-org
         users must see the whole tree swap when they switch, and a leak between
         tenants is only visible when both sides have something to leak. */
      spaces: [
        { name: 'Architecture Decisions', pages: 22, depth: 4, grants: 2, content: true },
        /* Flat — every page a root. A tree renderer that assumes nesting and a
           breadcrumb that assumes an ancestor both meet this space first. */
        { name: 'Meeting Notes', pages: 14, depth: 1, grants: 1, content: true },
      ],
      projects: [
        {
          name: 'Compliance',
          key: 'GXC',
          labels: 6,
          customFields: 'standard',
          boards: [{ name: 'Audit 2026', lists: 5, cards: 110, views: 3 }],
        },
        {
          name: 'Sales Ops',
          key: 'GXS',
          labels: 6,
          customFields: 'standard',
          boards: [
            { name: 'Pipeline', lists: 4, cards: 75, views: 2 },
            /* A board with no cards at all — every column empty. */
            { name: 'Next Quarter', lists: 3, cards: 0, views: 1 },
          ],
        },
      ],
    },
    {
      /* One user, one project. The smallest thing the product can be, and the
         only tenant where "you are the only member" states are reachable. */
      name: 'Solo Co',
      slug: 'solo-co',
      grants: 2,
      teams: [],
      members: [{ user: 23, role: 'owner' }],
      /* One channel and NO direct messages — a DM needs two participants, so
         this is the one tenant where "you are the only person here" is a real
         state rather than something to mock up. */
      channels: [{ name: 'general', type: 'public', members: 1, messages: 25, topic: true }],
      /* One person, so no grants at all: every page here is reachable through
         the owner's role alone. The tuple-free path is worth having a fixture
         for — it is what most pages in most tenants will actually be. */
      spaces: [{ name: 'Side Notes', pages: 8, depth: 2, grants: 0, content: true }],
      projects: [
        {
          name: 'Side Project',
          key: 'SIDE',
          labels: 5,
          customFields: 'standard',
          boards: [{ name: 'Everything', lists: 4, cards: 28, views: 2 }],
        },
      ],
    },
  ],
};

/** Smallest useful database. Seconds to run, for a quick manual check. */
const MINIMAL: Profile = {
  name: 'minimal',
  users: 4,
  cardEventSampleRate: 1,
  messageEventSampleRate: 1,
  docEventSampleRate: 1,
  attachments: false,
  card: { ...DEMO_MIX, archivedRate: 0, deletedRate: 0, attachmentRate: 0 },
  message: { ...DEMO_MESSAGE_MIX, deletedRate: 0, unfurlRate: 0, attachmentRate: 0 },
  /* Content stays ON at this size. The recovery paths (§3.7) are the part of
     Phase 6 most worth being able to check in seconds, and six pages of it cost
     nothing — it is the TREE that gets small here, not the mechanism. */
  page: { ...DEMO_PAGE_MIX, archivedRate: 0, bodyRate: 1, blocks: [2, 4], updates: [2, 4] },
  orgs: [
    {
      name: 'Test Org',
      slug: 'test-org',
      grants: 2,
      teams: ['Core'],
      members: [
        { user: 0, role: 'owner' },
        { user: 1, role: 'admin' },
        { user: 2, role: 'member' },
        { user: 3, role: 'guest' },
      ],
      channels: [
        { name: 'general', type: 'public', members: 4, messages: 40, topic: true },
        { name: 'private-notes', type: 'private', members: 2, messages: 15, withGuest: true },
        { name: null, type: 'dm', members: 2, messages: 20 },
      ],
      spaces: [{ name: 'Handbook', pages: 6, depth: 3, grants: 1, withGuest: true, content: true }],
      projects: [
        {
          name: 'First Project',
          key: 'FIRST',
          labels: 4,
          customFields: 'all-types',
          boards: [{ name: 'Main', lists: 4, cards: 12, views: 2 }],
        },
      ],
    },
  ],
};

/**
 * Volume, for the questions only volume answers.
 *
 * Card CHILDREN are switched off here — no comments, no checklists, one label at
 * most. This profile exists to answer "does a 24,000-card board still work", and
 * seeding a quarter of a million child rows to ask it would make the run take
 * twenty minutes and measure the seeder rather than the product.
 */
const LARGE: Profile = {
  name: 'large',
  users: 60,
  cardEventSampleRate: 0.01,
  messageEventSampleRate: 0.01,
  docEventSampleRate: 0.01,
  attachments: false,
  /**
   * Page CONTENT is switched off here, and that is a different decision from
   * switching card children off.
   *
   * The question this profile answers for Docs is whether the TREE holds up:
   * whether `ancestor_ids @> ARRAY[:pageId]` stays an index scan at eight
   * thousand pages and whether the nearest-ancestor walk is still cheap at
   * depth ten. Bodies would answer none of that and would write hundreds of
   * megabytes of `bytea` to ask it — the WAL and snapshot mechanisms are
   * proven by `minimal` in seconds, and their cost here is measured in how
   * long the seeder takes rather than in anything about the product.
   */
  page: {
    ...DEMO_PAGE_MIX,
    bodyRate: 0,
    snapshotRate: 0,
    updates: [0, 0],
    renamedRate: 0.02,
    movedRate: 0.02,
  },
  /* Message CHILDREN are switched off for the same reason card children are:
     this profile answers "does a 20,000-message channel still page", and
     seeding a hundred thousand reactions to ask it would measure the seeder. */
  message: {
    ...DEMO_MESSAGE_MIX,
    threadedRate: 0,
    replies: [0, 0],
    editedRate: 0.02,
    deletedRate: 0.01,
    mentionRate: 0.02,
    linkRate: 0,
    reactedRate: 0,
    reactions: [0, 0],
    pinnedPerChannel: [0, 0],
    readCursorRate: 0.1,
    unfurlRate: 0,
    attachmentRate: 0,
  },
  card: {
    ...DEMO_MIX,
    describedRate: 0.15,
    assignees: [0, 1],
    labels: [0, 1],
    unlabelledRate: 0.6,
    checklists: [0, 0],
    checklistItems: [0, 0],
    comments: [0, 0],
    customFieldRate: 0.05,
    attachmentRate: 0,
  },
  orgs: [
    {
      name: 'Scale Test',
      slug: 'scale-test',
      grants: 12,
      teams: ['Alpha', 'Beta'],
      members: Array.from({ length: 60 }, (_, i) => ({
        user: i,
        role: i === 0 ? 'owner' : i < 4 ? 'admin' : 'member',
      })),
      channels: [
        { name: 'firehose', type: 'public', members: 60, messages: 20_000 },
        { name: 'secondary', type: 'public', members: 20, messages: 5_000 },
      ],
      spaces: [
        { name: 'Everything', pages: 8_000, depth: 10, wide: 400, grants: 12 },
        { name: 'Secondary', pages: 2_000, depth: 4, grants: 4 },
      ],
      projects: [
        {
          name: 'Firehose',
          key: 'FIRE',
          labels: 12,
          customFields: 'standard',
          boards: [
            { name: 'Everything', lists: 4, cards: 24_000, views: 2 },
            { name: 'Secondary', lists: 6, cards: 6_000 },
          ],
        },
        {
          name: 'Volume Alpha',
          key: 'VOLA',
          labels: 8,
          customFields: 'standard',
          boards: [{ name: 'Main', lists: 5, cards: 15_000 }],
        },
        {
          name: 'Volume Beta',
          key: 'VOLB',
          labels: 8,
          customFields: 'standard',
          boards: [{ name: 'Main', lists: 5, cards: 15_000 }],
        },
      ],
    },
  ],
};

export const PROFILES: Readonly<Record<string, Profile>> = {
  demo: DEMO,
  minimal: MINIMAL,
  large: LARGE,
};

export const DEFAULT_PROFILE = 'demo';

export function findProfile(name: string): Profile {
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `Unknown profile "${name}". Available: ${Object.keys(PROFILES).sort().join(', ')}.`,
    );
  }
  return profile;
}

/**
 * Top-level messages across every org — for the plan the CLI prints.
 *
 * Deliberately excludes threaded replies. They are a function of the mix rather
 * than of the plan, so counting them here would mean reproducing the generator's
 * own random draws, and a printed estimate that disagrees with the run is worse
 * than one that is honestly a floor.
 */
export function plannedMessageCount(profile: Profile): number {
  return profile.orgs.reduce(
    (total, org) => total + org.channels.reduce((perOrg, channel) => perOrg + channel.messages, 0),
    0,
  );
}

/**
 * Live pages across every org — for the plan the CLI prints.
 *
 * A ceiling rather than a floor, unlike `plannedMessageCount`: `pages` is the
 * total a space generates, and the mix then archives a share of them, so the
 * LIVE count comes out slightly under this. Stated as planned rather than
 * predicted, for the same reason that function gives — an estimate reproducing
 * the generator's own draws is one more thing that can disagree with the run.
 */
export function plannedPageCount(profile: Profile): number {
  return profile.orgs.reduce(
    (total, org) => total + org.spaces.reduce((perOrg, space) => perOrg + space.pages, 0),
    0,
  );
}

/** Live cards across every org — for the plan the CLI prints before writing. */
export function plannedCardCount(profile: Profile): number {
  return profile.orgs.reduce(
    (total, org) =>
      total +
      org.projects.reduce(
        (perOrg, project) =>
          perOrg + project.boards.reduce((perProject, board) => perProject + board.cards, 0),
        0,
      ),
    0,
  );
}
