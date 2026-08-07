import { rankSequence } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { grantCreated } from '@taskflow/api/events/tenancy';
import {
  pageArchived,
  pageCreated,
  pageMoved,
  pageUpdated,
  spaceArchived,
  spaceCreated,
} from '@taskflow/api/events/docs';
import { roleGrants, type Permission, type Relation, type ResourceType } from '@taskflow/policy';
import { pageTitle } from '../corpus.js';
import type { SeedContext } from '../context.js';
import type { Rng } from '../rng.js';
import type { PageMix, SpacePlan } from '../profiles.js';
import { defineSeedModule } from '../registry.js';
import { daysBefore, envelopeFor, latest } from '../support.js';
import { orgsModule, type SeededMembership, type SeededOrg } from './tenancy.orgs.js';

/**
 * Spaces, the page tree, and the grants that hang off it (Phase 6, Wave 1).
 *
 * ## `ancestor_ids` is the whole point of this module
 *
 * Migration 0023 is explicit that nothing in the database checks a page's
 * `ancestor_ids` against a walk of `parent_page_id` — it is a service-level
 * invariant over a column Postgres constrains only by shape, exactly as a
 * card's `rank` is. So a seeder that gets it wrong produces a tree that looks
 * correct in every row-level check and answers the §3.4 nearest-ancestor walk
 * with the wrong page, which is a PERMISSION bug wearing a fixture's clothes.
 * It is built here in one place — `ancestorIds: [parent.id, ...parent.ancestorIds]`
 * — and `docs.test.ts` re-derives it from the parent pointers rather than
 * trusting this file.
 *
 * Nearest-first, never root-first. `packages/policy`'s `Target.ancestors` is
 * documented that way and `nearestApplicable` stops at the first entry carrying
 * a tuple, so the order is the difference between "the closest grant wins" and
 * "the space's grant silently overrides the one on the page".
 *
 * ## Shapes are guaranteed, filler is generated
 *
 * `SpacePlan`'s own header argues why a random tree of the right size is not a
 * useful fixture. The spine is built first, then the wide sibling set, then the
 * remainder is scattered over whatever exists — so the two shapes the
 * authorization spine actually rests on are present by construction and the
 * rest of the tree still looks organic.
 *
 * ## Roles are asked, never compared
 *
 * Same discipline as `chat.channels`: `roleGrants` decides who could plausibly
 * have created a space, written a page, or archived one, because guardrail 7
 * bans `role === ...` outside `packages/policy` and because a fixture whose
 * `created_by` could not have created the row is a row no route could have
 * written. It matters more here than it looks — `page:delete` is NOT a member
 * permission, so a page archived by a member is a state the product cannot
 * produce.
 */

/* Typed against `@taskflow/policy`'s unions rather than written as bare strings,
   for the reason chat.channels states: `loadTuples` drops unrecognized relations
   before the engine sees them, so a typo produces a row that exists, looks
   right, and grants nothing. */
const PAGE_OBJECT_TYPE: ResourceType = 'page';
const SPACE_OBJECT_TYPE: ResourceType = 'space';

/** Weighted toward editor/commenter, same reasoning as `authz.tuples`. */
const RELATION_WEIGHTS: readonly (readonly [Relation, number])[] = [
  ['editor', 4],
  ['commenter', 3],
  ['viewer', 3],
];

export interface SeededSpace {
  readonly id: string;
  readonly orgId: string;
  /** Carried by reference so `docs.content` reaches the org and its members
   * without re-requiring `tenancy.orgs` — the arrangement `SeededChannel`
   * makes for its org and `SeededBoard` for its project. */
  readonly org: SeededOrg;
  readonly name: string;
  readonly plan: SpacePlan;
  readonly creator: SeededMembership;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export interface SeededPage {
  readonly id: string;
  readonly orgId: string;
  readonly space: SeededSpace;
  readonly parentPageId: string | null;
  /** Nearest-first: `[parent, grandparent, ..., root]`. Empty for a root page. */
  readonly ancestorIds: readonly string[];
  readonly title: string;
  /** 1 for a root page. */
  readonly depth: number;
  readonly author: SeededMembership;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export interface SpacesOutput {
  readonly spaces: readonly SeededSpace[];
  readonly pages: readonly SeededPage[];
}

/** A page under construction — `rank` is assigned per sibling group at the end. */
interface DraftPage {
  readonly id: string;
  readonly parent: DraftPage | null;
  readonly ancestorIds: readonly string[];
  readonly depth: number;
  readonly title: string;
  readonly author: SeededMembership;
  readonly createdAt: Date;
  archivedAt: Date | null;
  rank: string;
  readonly children: DraftPage[];
}

export const spacesModule = defineSeedModule({
  name: 'docs.spaces',
  requires: [orgsModule],
  tables: ['docs.spaces', 'docs.pages', 'authz.relationship_tuples'],

  async seed(ctx): Promise<SpacesOutput> {
    const rng = ctx.rng.fork('docs.spaces');
    const { orgs } = ctx.use(orgsModule);
    const mix = ctx.profile.page;

    const spaces: SeededSpace[] = [];
    const pages: SeededPage[] = [];

    for (const org of orgs) {
      if (org.plan.spaces.length === 0) continue;

      const spaceRows: unknown[][] = [];
      const pageRows: unknown[][] = [];
      const tupleRows: unknown[][] = [];
      let pageCount = 0;

      for (const plan of org.plan.spaces) {
        const creator = pickBy(rng, org, 'space:create');
        if (creator === null) {
          throw new Error(
            `docs.spaces: org "${org.slug}" has nobody holding space:create, so its spaces ` +
              'could not have been created by anyone in it. Give the org an owner or an admin.',
          );
        }

        const spaceId = rng.uuid(ctx.now);
        const createdAt = latest(org.createdAt, daysBefore(ctx.now, rng.int(30, 300)));
        const archivedAt = plan.archived
          ? latest(createdAt, daysBefore(ctx.now, rng.int(2, 20)))
          : null;

        const space: SeededSpace = {
          id: spaceId,
          orgId: org.id,
          org,
          name: plan.name,
          plan,
          creator,
          createdAt,
          archivedAt,
        };
        spaces.push(space);

        spaceRows.push([
          spaceId,
          org.id,
          plan.name,
          archivedAt,
          creator.user.id,
          createdAt,
          archivedAt ?? createdAt,
        ]);

        const envelope = envelopeFor(org.id, creator.user.id, createdAt);
        ctx.emit(createEvent(spaceCreated, { spaceId, name: plan.name }, envelope));
        if (archivedAt !== null) {
          ctx.emit(
            createEvent(
              spaceArchived,
              { spaceId, restored: false },
              envelopeFor(org.id, creator.user.id, archivedAt),
            ),
          );
        }

        const drafts = buildTree(rng, ctx.now, org, space);
        applyArchiving(rng, ctx.now, mix, plan, drafts, org);

        for (const draft of drafts) {
          pageRows.push([
            draft.id,
            org.id,
            spaceId,
            draft.parent?.id ?? null,
            draft.title,
            draft.rank,
            draft.ancestorIds,
            draft.archivedAt,
            draft.author.user.id,
            draft.createdAt,
            draft.archivedAt ?? draft.createdAt,
          ]);

          pages.push({
            id: draft.id,
            orgId: org.id,
            space,
            parentPageId: draft.parent?.id ?? null,
            ancestorIds: draft.ancestorIds,
            title: draft.title,
            depth: draft.depth,
            author: draft.author,
            createdAt: draft.createdAt,
            archivedAt: draft.archivedAt,
          });

          emitPageHistory(ctx, rng, mix, org, space, draft);
        }

        pageCount += drafts.length;
        tupleRows.push(...buildGrants(ctx, rng, org, space, drafts));
      }

      await ctx.orgScope(org.id, async () => {
        await ctx.db.insert(
          'docs.spaces',
          ['id', 'org_id', 'name', 'archived_at', 'created_by', 'created_at', 'updated_at'],
          spaceRows,
        );

        /* Parents precede children in `pageRows` by construction — every page
           is attached to one that already exists — and that ordering is load
           bearing rather than tidy: `pages_parent_fk` is not DEFERRABLE, so a
           child inserted before its parent is refused by the database even
           though both rows are in the same statement. */
        await ctx.db.insert(
          'docs.pages',
          [
            'id',
            'org_id',
            'space_id',
            'parent_page_id',
            'title',
            'rank',
            // Without the cast the driver cannot tell an empty JS array (a root
            // page's ancestors) from an empty string — the same reason
            // `cards.assignee_ids` carries one.
            'ancestor_ids::uuid[]',
            'archived_at',
            'created_by',
            'created_at',
            'updated_at',
          ],
          pageRows,
        );

        await ctx.db.insert(
          'authz.relationship_tuples',
          [
            'id',
            'org_id',
            'subject_type',
            'subject_id',
            'relation',
            'object_type',
            'object_id',
            'granted_by',
            'expires_at',
            'created_at',
          ],
          tupleRows,
        );
      });

      ctx.log(
        `docs.spaces: ${org.slug} — ${String(spaceRows.length)} spaces, ` +
          `${String(pageCount)} pages, ${String(tupleRows.length)} grants`,
      );
    }

    return { spaces, pages };
  },
});

/**
 * Someone whose ROLE holds `permission`, or null.
 *
 * Asked as a capability rather than by role name, for the reason the file
 * header gives. Returns the first match rather than a random one for space
 * creation-style questions where a stable answer reads better in a fixture;
 * callers wanting variety draw from `membershipsWith` instead.
 */
export function pickBy(rng: Rng, org: SeededOrg, permission: Permission): SeededMembership | null {
  const candidates = membershipsWith(org, permission);
  return candidates.length === 0 ? null : rng.pick(candidates);
}

/** Exported for `docs.comments`/`docs.suggestions` — same capability-not-role-name
 * discipline this file's own header describes, for the identical reason. */
export function membershipsWith(
  org: SeededOrg,
  permission: Permission,
): readonly SeededMembership[] {
  return org.memberships.filter((membership) => roleGrants(membership.role, permission));
}

/**
 * The tree for one space, in insertion order — parents always before children.
 *
 * Three phases, in this order and for the reasons `SpacePlan` documents: the
 * guaranteed spine, the guaranteed wide sibling set, then filler attached to
 * whatever already exists. Ranks are assigned last, per sibling group, because
 * `rankSequence` produces an ordered run and a group is not complete until the
 * filler phase has stopped adding to it.
 */
function buildTree(rng: Rng, now: Date, org: SeededOrg, space: SeededSpace): DraftPage[] {
  const plan = space.plan;
  if (plan.pages === 0) return [];

  const authors = membershipsWith(org, 'page:create');
  if (authors.length === 0) {
    throw new Error(
      `docs.spaces: org "${org.slug}" has nobody holding page:create, so the pages in ` +
        `"${plan.name}" could not have been written by anyone in it.`,
    );
  }

  const guaranteed = plan.depth + (plan.wide ?? 0);
  if (plan.pages < guaranteed) {
    throw new Error(
      `docs.spaces: space "${plan.name}" plans ${String(plan.pages)} pages but its depth ` +
        `(${String(plan.depth)}) and wide sibling set (${String(plan.wide ?? 0)}) already need ` +
        `${String(guaranteed)}. Raise \`pages\`, or lower \`depth\`/\`wide\`, in profiles.ts.`,
    );
  }

  const all: DraftPage[] = [];

  /* Titles are unique per sibling group. `pageTitle` draws from a 20-entry
     topic pool and returns a BARE topic 70% of the time, so without this a
     46-page space lands four pages named "Support escalation paths" under the
     same parent — which reads as a seeder bug even though each title is a
     legitimate draw (it is exactly what a real wiki with a clichéd corpus
     produces, and the sidebar showed it: repeated titles everywhere).

     Repeats across DIFFERENT parents are still allowed, deliberately — that
     is corpus.ts's own "Overview under three different parents" ambiguity a
     breadcrumb has to be able to show. Bounded retries rather than a
     guaranteed-unique contract: a sibling group larger than the 180-title
     space would otherwise spin forever, and 40 draws from 180 possibilities
     misses with probability that rounds to zero at the sizes profiles.ts
     plans. */
  const usedTitlesByParent = new Map<DraftPage | null, Set<string>>();

  const add = (parent: DraftPage | null): DraftPage => {
    const author = rng.pick(authors);
    /* A child can never predate its parent: the ancestors are what a reader
       reaches it through, so a page created before the page containing it is a
       row the product could not have produced. */
    const floor = parent?.createdAt ?? space.createdAt;

    const usedTitles = usedTitlesByParent.get(parent) ?? new Set<string>();
    let title = pageTitle(rng);
    for (let attempt = 0; attempt < 40 && usedTitles.has(title); attempt += 1) {
      title = pageTitle(rng);
    }
    usedTitles.add(title);
    usedTitlesByParent.set(parent, usedTitles);

    const draft: DraftPage = {
      id: rng.uuid(now),
      parent,
      ancestorIds: parent === null ? [] : [parent.id, ...parent.ancestorIds],
      depth: (parent?.depth ?? 0) + 1,
      title,
      author,
      createdAt: latest(floor, daysBefore(now, rng.int(1, 240))),
      archivedAt: null,
      rank: '',
      children: [],
    };
    parent?.children.push(draft);
    all.push(draft);
    return draft;
  };

  // 1. The spine — one root-to-leaf chain of exactly `depth` pages.
  let cursor: DraftPage | null = null;
  for (let level = 0; level < plan.depth; level += 1) {
    cursor = add(cursor);
  }

  // 2. The wide sibling set, hung off the spine's second level where one
  //    exists — a wide set of ROOTS would be a different (and less
  //    interesting) shape, since roots have no ancestors to resolve through.
  if (plan.wide !== undefined && plan.wide > 0) {
    const wideParent = all[Math.min(1, all.length - 1)] ?? null;
    for (let i = 0; i < plan.wide; i += 1) add(wideParent);
  }

  // 3. Filler. A quarter of it lands at the root so a space has several
  //    top-level entries rather than one; the rest attaches to any page that
  //    is not already at the depth limit.
  while (all.length < plan.pages) {
    const attachable = all.filter((page) => page.depth < plan.depth);
    const parent = attachable.length === 0 || rng.chance(0.25) ? null : rng.pick(attachable);
    add(parent);
  }

  assignRanks(all);
  return all;
}

/**
 * Fractional-index ranks, per sibling group, in creation order.
 *
 * `rankSequence` used exactly as `work.boards` uses it — one ordered run per
 * container, rather than a rank invented per row. Siblings share a parent, and
 * a space's roots share the null parent, which is one more group.
 */
function assignRanks(all: readonly DraftPage[]): void {
  const groups = new Map<string, DraftPage[]>();
  for (const page of all) {
    const key = page.parent?.id ?? 'root';
    const group = groups.get(key) ?? [];
    group.push(page);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const ranks = rankSequence(group.length);
    group.forEach((page, index) => {
      const rank = ranks[index];
      if (rank === undefined) {
        throw new Error('rankSequence produced fewer ranks than siblings — a bug here.');
      }
      page.rank = rank;
    });
  }
}

/**
 * Archives what the plan and the mix ask for.
 *
 * Two mechanisms, deliberately not merged. `archivedSubtree` archives a branch
 * AND everything under it, because that is what archiving a page with children
 * does in the product; the mix's `archivedRate` only ever touches LEAVES, so an
 * individually archived page never leaves live children dangling under an
 * archived parent. Seeding that state would be inventing a row the product
 * cannot produce, and it is exactly the row that makes a tree query which
 * filters `archived_at` on the page but not on its ancestors look correct.
 *
 * Nothing is archived inside an archived SPACE: the space carries the
 * archival, and its pages stay live underneath it (0023: "an archived space's
 * pages are not purged").
 */
function applyArchiving(
  rng: Rng,
  now: Date,
  mix: PageMix,
  plan: SpacePlan,
  drafts: readonly DraftPage[],
  org: SeededOrg,
): void {
  if (drafts.length === 0 || plan.archived === true) return;

  // Someone who could actually have done it — `page:delete` is admin-and-owner,
  // never a member permission.
  if (membershipsWith(org, 'page:delete').length === 0) return;

  const archiveAt = (page: DraftPage): void => {
    page.archivedAt = latest(page.createdAt, daysBefore(now, rng.int(1, 30)));
  };

  if (plan.archivedSubtree === true) {
    const branches = drafts.filter((page) => page.parent !== null && page.children.length > 0);
    const root = branches.length === 0 ? null : rng.pick(branches);
    if (root !== null) {
      /* Breadth-first, and the queue is appended to WHILE it is iterated —
         an array iterator visits entries pushed during the loop, which is what
         makes this reach the whole subtree rather than only the first level. */
      const subtree: DraftPage[] = [root];
      for (const page of subtree) {
        archiveAt(page);
        subtree.push(...page.children);
      }
    }
  }

  for (const page of drafts) {
    if (page.archivedAt !== null || page.children.length > 0) continue;
    if (rng.chance(mix.archivedRate)) archiveAt(page);
  }
}

/**
 * The lifecycle events one page contributes to the outbox.
 *
 * Sampled per PAGE rather than per event, so a page either has a history or has
 * none — a page that emits a rename it never was created for reads as a gap in
 * the audit log rather than as sampling.
 */
function emitPageHistory(
  ctx: SeedContext,
  rng: Rng,
  mix: PageMix,
  org: SeededOrg,
  space: SeededSpace,
  draft: DraftPage,
): void {
  if (!rng.chance(ctx.profile.docEventSampleRate)) return;

  const envelope = envelopeFor(org.id, draft.author.user.id, draft.createdAt);

  ctx.emit(
    createEvent(
      pageCreated,
      {
        pageId: draft.id,
        spaceId: space.id,
        parentPageId: draft.parent?.id ?? null,
        title: draft.title,
      },
      envelope,
    ),
  );

  if (rng.chance(mix.renamedRate)) {
    ctx.emit(
      createEvent(
        pageUpdated,
        { pageId: draft.id, before: { title: pageTitle(rng) }, after: { title: draft.title } },
        envelope,
      ),
    );
  }

  /* A move whose from/to are the SAME parent is a pure reorder, which is a real
     and common event — `page.moved` carries both parents precisely so a
     consumer can tell the two apart, and a fixture that only ever emitted
     reparenting would leave that distinction untested. */
  if (rng.chance(mix.movedRate)) {
    ctx.emit(
      createEvent(
        pageMoved,
        {
          pageId: draft.id,
          spaceId: space.id,
          fromParentPageId: draft.parent?.id ?? null,
          toParentPageId: draft.parent?.id ?? null,
          rank: draft.rank,
        },
        envelope,
      ),
    );
  }

  if (draft.archivedAt !== null) {
    ctx.emit(
      createEvent(
        pageArchived,
        { pageId: draft.id, restored: false },
        envelopeFor(org.id, draft.author.user.id, draft.archivedAt),
      ),
    );
  }
}

/**
 * The grants on a space and its pages.
 *
 * Three shapes are placed deliberately before the budget is spent randomly,
 * because each is a case the §3.4 resolver has to get right and none of them
 * occurs reliably in a random draw:
 *
 *   1. A grant on an ANCESTOR that a descendant inherits — the mechanism
 *      itself. Placed on the shallowest page that has children.
 *   2. A RESTRICTIVE viewer deep in the tree, under an editor grant higher up.
 *      `nearestApplicable` is what makes the closer tuple win, and getting that
 *      backwards means narrowing a grant silently does nothing.
 *   3. The guest, whose role grants nothing at all, on one subtree.
 *
 * A team-subject grant on the space itself takes the fourth slot where the
 * budget and the org's teams allow.
 */
function buildGrants(
  ctx: SeedContext,
  rng: Rng,
  org: SeededOrg,
  space: SeededSpace,
  drafts: readonly DraftPage[],
): unknown[][] {
  let remaining = space.plan.grants;
  if (remaining === 0 && space.plan.withGuest !== true) return [];

  const rows: unknown[][] = [];
  const seen = new Set<string>();

  const grant = (
    subjectType: 'user' | 'team',
    subjectId: string,
    relation: Relation,
    objectType: ResourceType,
    objectId: string,
    at: Date,
  ): boolean => {
    const key = `${subjectType}:${subjectId}:${relation}:${objectType}:${objectId}`;
    if (seen.has(key)) return false;
    seen.add(key);

    const id = rng.uuid(ctx.now);
    const createdAt = latest(at, daysBefore(ctx.now, rng.int(1, 40)));
    rows.push([
      id,
      org.id,
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId,
      org.owner.id,
      /* No expiry, for the reason chat.channels gives: a tuple that expired
         between two runs would make the guest case reproduce differently on
         different days. */
      null,
      createdAt,
    ]);

    ctx.emit(
      createEvent(
        grantCreated,
        {
          tupleId: id,
          subjectType,
          subjectId,
          relation,
          objectType,
          objectId,
          expiresAt: null,
        },
        envelopeFor(org.id, org.owner.id, createdAt),
      ),
    );
    return true;
  };

  const branches = drafts.filter((page) => page.children.length > 0);
  const shallowest = [...branches].sort((a, b) => a.depth - b.depth)[0] ?? null;
  const deepest = [...drafts].sort((a, b) => b.depth - a.depth)[0] ?? null;

  /* The guest first, and OUTSIDE the budget: `withGuest` is a promise about
     what signing in as that account reaches, and letting a `grants: 0` space
     silently drop it would break the one case this fixture exists to make. */
  if (space.plan.withGuest === true) {
    const guest = org.memberships.find((membership) => !roleGrants(membership.role, 'page:read'));
    if (guest === undefined) {
      throw new Error(
        `docs.spaces: space "${space.plan.name}" in "${org.slug}" asks for a guest, but no ` +
          'member of that org holds a role granting no page access. Add a guest to the org plan.',
      );
    }
    const target = shallowest ?? deepest;
    if (target !== null) {
      grant('user', guest.user.id, 'viewer', PAGE_OBJECT_TYPE, target.id, target.createdAt);
    }
  }

  if (remaining > 0 && shallowest !== null) {
    const editor = org.memberships.find((membership) => roleGrants(membership.role, 'page:update'));
    if (
      editor !== undefined &&
      grant('user', editor.user.id, 'editor', PAGE_OBJECT_TYPE, shallowest.id, shallowest.createdAt)
    ) {
      remaining -= 1;
    }
  }

  if (remaining > 0 && deepest !== null && deepest.depth > 1) {
    // Whoever would hold page:update through their ROLE alone — the subject a
    // restrictive viewer tuple actually takes something away from.
    const capped = org.memberships.find((membership) => roleGrants(membership.role, 'page:update'));
    if (
      capped !== undefined &&
      grant('user', capped.user.id, 'viewer', PAGE_OBJECT_TYPE, deepest.id, deepest.createdAt)
    ) {
      remaining -= 1;
    }
  }

  if (remaining > 0 && org.teams.length > 0) {
    const team = rng.pick(org.teams);
    if (grant('team', team.id, 'editor', SPACE_OBJECT_TYPE, space.id, space.createdAt)) {
      remaining -= 1;
    }
  }

  /* Bounded rather than unconditional — the same discipline `authz.tuples` and
     `chat.channels` use. A space asking for more distinct grants than its own
     pages and members can express should say so rather than spin. */
  const maxAttempts = remaining * 40 + 40;
  for (let attempt = 0; remaining > 0 && attempt < maxAttempts; attempt += 1) {
    const member = rng.pick(org.memberships);
    const relation = rng.weighted(RELATION_WEIGHTS);
    const onSpace = drafts.length === 0 || rng.chance(0.2);
    const target = onSpace ? null : rng.pick(drafts);

    const placed =
      target === null
        ? grant('user', member.user.id, relation, SPACE_OBJECT_TYPE, space.id, space.createdAt)
        : grant('user', member.user.id, relation, PAGE_OBJECT_TYPE, target.id, target.createdAt);

    if (placed) remaining -= 1;
  }

  if (remaining > 0) {
    throw new Error(
      `docs.spaces: space "${space.plan.name}" in "${org.slug}" asked for ` +
        `${String(space.plan.grants)} grants but only ${String(space.plan.grants - remaining)} ` +
        'distinct (subject, relation, object) combinations were available. Add pages or ' +
        'members, or lower `grants` in profiles.ts.',
    );
  }

  return rows;
}
