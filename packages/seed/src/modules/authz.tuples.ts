import { createEvent } from '@taskflow/events';
import { grantCreated } from '@taskflow/api/events/tenancy';
import { roleGrants, type Relation } from '@taskflow/policy';
import { defineSeedModule } from '../registry.js';
import { daysBefore, envelopeFor, latest } from '../support.js';
import { boardsModule, type SeededBoard } from './work.boards.js';
import type { SeededOrg } from './tenancy.orgs.js';

/**
 * Relationship tuples — per-resource grants on top of the role (PLAN.md §8.2).
 *
 * Depends on `work.boards`, not on `tenancy.orgs` directly, and that ordering
 * is load-bearing rather than incidental: every grant here names a BOARD, and a
 * grant naming a resource that does not exist yet is not a smaller version of
 * this module, it is a different bug — a dangling tuple that could only ever
 * matter retroactively, once something happened to be created with the id it
 * guessed.
 *
 * Two illustrations from CLAUDE.md are placed deliberately rather than left to
 * chance, budget permitting: one TEAM-subject tuple (a team owns a board), and
 * one RESTRICTIVE viewer — an admin or member who would otherwise hold
 * `board:update` through their role, capped to read-only on one specific
 * board. That second one is the case the decision trace exists to explain:
 * sharing a board read-only with a colleague must not silently upgrade them.
 */

export interface AuthzTuplesOutput {
  readonly tupleCount: number;
}

/** Weighted toward editor/commenter — a demo where nobody can touch anything
 * they were granted access to would not demonstrate much. */
const RELATION_WEIGHTS: readonly (readonly [Relation, number])[] = [
  ['editor', 4],
  ['commenter', 3],
  ['viewer', 3],
];

interface PlannedGrant {
  readonly id: string;
  readonly subjectType: 'user' | 'team';
  readonly subjectId: string;
  readonly relation: Relation;
  readonly board: SeededBoard;
  readonly createdAt: Date;
}

export const tuplesModule = defineSeedModule({
  name: 'authz.tuples',
  requires: [boardsModule],
  tables: ['authz.relationship_tuples'],

  async seed(ctx): Promise<AuthzTuplesOutput> {
    const rng = ctx.rng.fork('authz.tuples');
    const { boards } = ctx.use(boardsModule);

    const byOrg = new Map<string, { org: SeededOrg; boards: SeededBoard[] }>();
    for (const board of boards) {
      const entry = byOrg.get(board.orgId) ?? { org: board.project.org, boards: [] };
      entry.boards.push(board);
      byOrg.set(board.orgId, entry);
    }

    let tupleCount = 0;

    for (const { org, boards: orgBoards } of byOrg.values()) {
      if (orgBoards.length === 0 || org.plan.grants === 0) continue;

      const seen = new Set<string>();
      const grants: PlannedGrant[] = [];

      const plan = (
        subjectType: 'user' | 'team',
        subjectId: string,
        relation: Relation,
        board: SeededBoard,
      ): boolean => {
        const key = `${subjectType}:${subjectId}:${relation}:${board.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        grants.push({
          id: rng.uuid(ctx.now),
          subjectType,
          subjectId,
          relation,
          board,
          createdAt: latest(board.createdAt, daysBefore(ctx.now, rng.int(1, 45))),
        });
        return true;
      };

      let remaining = org.plan.grants;

      if (remaining > 0 && org.teams.length > 0) {
        const team = rng.pick(org.teams);
        if (plan('team', team.id, 'editor', rng.pick(orgBoards))) remaining -= 1;
      }

      if (remaining > 0) {
        // Whoever would have `board:update` through their ROLE alone — the
        // subject a restrictive `viewer` tuple actually takes something away
        // from. `roleGrants` (not an inline `role === ...`) is what guardrail
        // 7 requires for that question outside packages/policy.
        const capped = org.memberships.find((membership) =>
          roleGrants(membership.role, 'board:update'),
        );
        if (capped && plan('user', capped.user.id, 'viewer', rng.pick(orgBoards))) {
          remaining -= 1;
        }
      }

      // Bounded rather than unconditional: the (member, board, relation) space
      // is finite, and a profile whose grant count outgrows it should fail
      // loudly instead of spinning — same discipline as `people()` in corpus.ts.
      const maxAttempts = remaining * 40 + 40;
      for (let attempt = 0; remaining > 0 && attempt < maxAttempts; attempt += 1) {
        const member = rng.pick(org.members);
        const board = rng.pick(orgBoards);
        const relation = rng.weighted(RELATION_WEIGHTS);
        if (plan('user', member.id, relation, board)) remaining -= 1;
      }
      if (remaining > 0) {
        throw new Error(
          `authz.tuples: org "${org.slug}" asked for ${String(org.plan.grants)} grants but only ` +
            `${String(org.plan.grants - remaining)} distinct (subject, relation, board) combinations ` +
            'were available. Add more boards or members, or lower `grants` on the profile.',
        );
      }

      await ctx.orgScope(org.id, async () => {
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
          grants.map((grant) => [
            grant.id,
            org.id,
            grant.subjectType,
            grant.subjectId,
            grant.relation,
            'board',
            grant.board.id,
            org.owner.id,
            null,
            grant.createdAt,
          ]),
        );
      });

      for (const grant of grants) {
        ctx.emit(
          createEvent(
            grantCreated,
            {
              tupleId: grant.id,
              subjectType: grant.subjectType,
              subjectId: grant.subjectId,
              relation: grant.relation,
              objectType: 'board',
              objectId: grant.board.id,
              expiresAt: null,
            },
            envelopeFor(org.id, org.owner.id, grant.createdAt),
          ),
        );
      }

      tupleCount += grants.length;
      ctx.log(`authz.tuples: ${org.slug} — ${String(grants.length)} grants`);
    }

    return { tupleCount };
  },
});
