import type { Role } from '@taskflow/policy';

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

export interface Profile {
  readonly name: string;
  /** Size of the shared user pool. Org plans index into it. */
  readonly users: number;
  readonly orgs: readonly OrgPlan[];
  readonly card: CardMix;
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

/**
 * The default. Three tenants, ~1,350 live cards, every Phase 3 surface populated.
 */
const DEMO: Profile = {
  name: 'demo',
  users: 24,
  cardEventSampleRate: 0.35,
  attachments: true,
  card: DEMO_MIX,
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
            { name: 'Delivery', lists: 6, cards: 380 },
            { name: 'Design Review', lists: 4, cards: 85 },
            { name: 'Bug Triage', lists: 5, cards: 150 },
          ],
        },
        {
          name: 'Public API',
          key: 'API',
          labels: 8,
          customFields: 'standard',
          boards: [
            { name: 'Roadmap', lists: 5, cards: 160 },
            { name: 'Incidents', lists: 4, cards: 60 },
          ],
        },
        {
          name: 'Mobile App',
          key: 'MOB',
          labels: 7,
          customFields: 'standard',
          boards: [{ name: 'Release 4.2', lists: 5, cards: 150 }],
        },
        {
          name: 'Operations',
          key: 'OPS',
          labels: 6,
          customFields: 'standard',
          boards: [
            { name: 'Runbook Tasks', lists: 4, cards: 110 },
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
      projects: [
        {
          name: 'Compliance',
          key: 'GXC',
          labels: 6,
          customFields: 'standard',
          boards: [{ name: 'Audit 2026', lists: 5, cards: 110 }],
        },
        {
          name: 'Sales Ops',
          key: 'GXS',
          labels: 6,
          customFields: 'standard',
          boards: [
            { name: 'Pipeline', lists: 4, cards: 75 },
            /* A board with no cards at all — every column empty. */
            { name: 'Next Quarter', lists: 3, cards: 0 },
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
      projects: [
        {
          name: 'Side Project',
          key: 'SIDE',
          labels: 5,
          customFields: 'standard',
          boards: [{ name: 'Everything', lists: 4, cards: 28 }],
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
  attachments: false,
  card: { ...DEMO_MIX, archivedRate: 0, deletedRate: 0, attachmentRate: 0 },
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
      projects: [
        {
          name: 'First Project',
          key: 'FIRST',
          labels: 4,
          customFields: 'all-types',
          boards: [{ name: 'Main', lists: 4, cards: 12 }],
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
  attachments: false,
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
        role: (i === 0 ? 'owner' : i < 4 ? 'admin' : 'member') as Role,
      })),
      projects: [
        {
          name: 'Firehose',
          key: 'FIRE',
          labels: 12,
          customFields: 'standard',
          boards: [
            { name: 'Everything', lists: 4, cards: 24_000 },
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
