import {
  claimPending,
  insertAuditEntry,
  markPublished,
  withAuditScope,
  type OutboxRow,
} from '@taskflow/db';

/**
 * The audit projection — outbox in, hash-chained log out (PLAN.md §8.6, §10.6).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): this is the only writer of the compliance
 * record.
 *
 * ## Exactly-once, not at-least-once
 *
 * Claiming events, writing their audit entries, and marking them published all
 * happen in ONE transaction as `taskflow_audit`. That is why this consumer does
 * not need to be idempotent, and it is the reason the relay and the audit
 * writer are the same role in this phase: a crash mid-batch rolls back the
 * audit rows along with the claim, so the next run redoes the whole batch and
 * duplicates nothing.
 *
 * Consumers added later — notifications, realtime, search, automation — do NOT
 * get this property. They will be dispatched by pg-boss after the relay commits
 * and must be idempotent, which is the normal outbox contract. Audit is treated
 * differently because a duplicated audit entry is not a cosmetic problem: it
 * breaks the hash chain's meaning, since the chain would then attest to
 * something that happened once as though it happened twice.
 *
 * ## Where this will live
 *
 * In `apps/worker`, on a pg-boss schedule, once that app exists (Phase 4). It
 * is here now because the outbox has real traffic from Phase 2 and an audit log
 * that nothing writes to is not a control. `drainOutbox` takes no ambient state
 * so moving it is a change of caller, not of code.
 */

/**
 * How a domain event names the thing it happened to.
 *
 * An explicit table rather than guessing from the payload. Inferring "the first
 * key ending in Id" would work for most events and quietly mis-attribute the
 * ones where it does not — `member.added` carries both a membershipId and a
 * userId, and an audit trail that attributes a role change to the wrong subject
 * is worse than one that attributes it to nothing.
 */
const RESOURCE_OF: Readonly<Record<string, { type: string; key: string }>> = {
  'org.created': { type: 'org', key: 'orgId' },
  'org.updated': { type: 'org', key: 'orgId' },
  'member.added': { type: 'member', key: 'userId' },
  'member.role_changed': { type: 'member', key: 'userId' },
  'member.removed': { type: 'member', key: 'userId' },
  'team.created': { type: 'team', key: 'teamId' },
  'team.member_added': { type: 'team', key: 'teamId' },
  'team.member_removed': { type: 'team', key: 'teamId' },
  'grant.created': { type: 'member', key: 'subjectId' },
  'grant.revoked': { type: 'member', key: 'subjectId' },

  /* Work (Phase 3). Lists resolve to their BOARD, matching the authorization
     model: there is no `list` resource type, because a list is not
     independently grantable and no tuple can point at one. An audit entry
     naming a resource type the policy engine has never heard of would be
     unusable by the permission debug endpoint that reads the same vocabulary. */
  'project.created': { type: 'project', key: 'projectId' },
  'project.updated': { type: 'project', key: 'projectId' },
  'project.archived': { type: 'project', key: 'projectId' },
  'board.created': { type: 'board', key: 'boardId' },
  'board.updated': { type: 'board', key: 'boardId' },
  'board.archived': { type: 'board', key: 'boardId' },
  'list.created': { type: 'board', key: 'boardId' },
  'list.updated': { type: 'board', key: 'boardId' },
  'list.reordered': { type: 'board', key: 'boardId' },
  'list.archived': { type: 'board', key: 'boardId' },
  'list.rebalanced': { type: 'board', key: 'boardId' },
  'card.created': { type: 'card', key: 'cardId' },
  'card.updated': { type: 'card', key: 'cardId' },
  'card.moved': { type: 'card', key: 'cardId' },
  'card.assigned': { type: 'card', key: 'cardId' },
  'card.archived': { type: 'card', key: 'cardId' },

  /* Card detail. Labels and custom field DEFINITIONS resolve to their project,
     because that is what they belong to and what a grant could name; the
     per-card events resolve to the card. Checklists and their items have no
     resource type of their own for the same reason lists do not — nobody shares
     one checklist — so they resolve to the card that owns them. */
  'label.created': { type: 'project', key: 'projectId' },
  'label.updated': { type: 'project', key: 'projectId' },
  'label.deleted': { type: 'project', key: 'projectId' },
  'card.labeled': { type: 'card', key: 'cardId' },
  'checklist.created': { type: 'card', key: 'cardId' },
  'checklist.deleted': { type: 'card', key: 'cardId' },
  'checklist_item.created': { type: 'card', key: 'cardId' },
  'checklist_item.updated': { type: 'card', key: 'cardId' },
  'checklist_item.deleted': { type: 'card', key: 'cardId' },
  'custom_field.created': { type: 'project', key: 'projectId' },
  'custom_field.updated': { type: 'project', key: 'projectId' },
  'custom_field.archived': { type: 'project', key: 'projectId' },
  'card.field_set': { type: 'card', key: 'cardId' },
  'comment.created': { type: 'comment', key: 'commentId' },
  'comment.updated': { type: 'comment', key: 'commentId' },
  'comment.deleted': { type: 'comment', key: 'commentId' },
};

interface Resource {
  readonly type: string | null;
  readonly id: string | null;
}

/** UUID shape, so a payload field that is not an id never lands in `resource_id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resourceOf(row: OutboxRow): Resource {
  const mapping = RESOURCE_OF[row.name];
  if (!mapping) return { type: null, id: null };

  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return { type: mapping.type, id: null };

  const value = (payload as Record<string, unknown>)[mapping.key];
  if (typeof value !== 'string' || !UUID.test(value)) return { type: mapping.type, id: null };

  return { type: mapping.type, id: value };
}

export interface DrainResult {
  readonly processed: number;
}

/**
 * Moves one batch from the outbox into the audit log.
 *
 * Returns how many were processed, so a caller can loop until the backlog is
 * empty without this function owning a scheduling policy.
 */
export async function drainOutbox(limit = 100): Promise<DrainResult> {
  return withAuditScope(async (tx) => {
    const pending = await claimPending(tx, limit);
    if (pending.length === 0) return { processed: 0 };

    for (const row of pending) {
      const resource = resourceOf(row);

      /* `id` is the EVENT's id, reused as the audit entry's id. One event
         produces one entry, so sharing the identifier makes "which event is
         this entry?" answerable by equality rather than by correlation — and
         makes a double insert a primary key violation rather than a silent
         duplicate.

         seq, prev_hash and hash are absent: the trigger assigns all three under
         the chain-head lock, which is what stops a writer choosing its own
         position in the chain. */
      await insertAuditEntry(tx, {
        id: row.id,
        orgId: row.orgId,
        occurredAt: row.occurredAt,
        actorId: row.actorId,
        action: row.name,
        resourceType: resource.type,
        resourceId: resource.id,
        changes: row.payload,
        requestId: row.requestId,
      });
    }

    await markPublished(
      tx,
      pending.map((row) => row.id),
    );

    return { processed: pending.length };
  });
}

/**
 * Drains until the backlog is empty.
 *
 * Bounded by `maxBatches` rather than looping until clear. An unbounded drain
 * competing with live traffic is a job that never returns, and the caller — a
 * scheduled tick — would then never run its next iteration.
 */
export async function drainOutboxFully(batchSize = 100, maxBatches = 50): Promise<DrainResult> {
  let processed = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainOutbox(batchSize);
    processed += result.processed;
    if (result.processed < batchSize) break;
  }

  return { processed };
}
