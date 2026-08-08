import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Work domain events — guardrail 11 (PLAN.md §2.1, §10.6).
 *
 * Phase 2's events recorded how ACCESS changed. These record what people did
 * with it, and they are the first events in the system with four consumers
 * waiting rather than one: audit today, then realtime broadcast (Phase 4),
 * search indexing (Phase 8), notifications (Phase 9), and automation triggers
 * (Phase 10).
 *
 * That is why the payloads below carry more than the audit log strictly needs.
 * `card.moved` includes the source list as well as the destination because a
 * socket consumer has to patch two columns, and an automation rule asking "did
 * this card enter Done?" cannot answer from the destination alone — a move
 * WITHIN Done is not an entry into it. Deriving those later would mean reading
 * the card, which is exactly the database round-trip the event exists to avoid.
 *
 * Every payload carries the BEFORE value where one exists, for the same reason
 * as tenancy's: an event saying only what a field became cannot answer whether
 * anything actually changed.
 */

/* -------------------------------------------------------------------------- *
 * Projects
 * -------------------------------------------------------------------------- */

export const projectCreated = defineEvent(
  'project.created',
  z.object({ projectId: z.string(), name: z.string(), key: z.string() }).strict(),
);

export const projectUpdated = defineEvent(
  'project.updated',
  z
    .object({
      projectId: z.string(),
      before: z.object({ name: z.string(), description: z.string().nullable() }).strict(),
      after: z.object({ name: z.string(), description: z.string().nullable() }).strict(),
    })
    .strict(),
);

/**
 * Archive, not delete.
 *
 * §7.1 keeps the three distinct, and the event names follow: archiving is
 * user-visible and restorable, so a consumer that hides the project must be
 * prepared to see it again. Nothing here emits a `project.deleted` yet — the
 * retention purge that would produce one is Phase 12.
 */
export const projectArchived = defineEvent(
  'project.archived',
  z.object({ projectId: z.string(), name: z.string(), restored: z.boolean() }).strict(),
);

/* -------------------------------------------------------------------------- *
 * Boards and lists
 * -------------------------------------------------------------------------- */

export const boardCreated = defineEvent(
  'board.created',
  z.object({ boardId: z.string(), projectId: z.string(), name: z.string() }).strict(),
);

export const boardUpdated = defineEvent(
  'board.updated',
  z
    .object({
      boardId: z.string(),
      before: z.object({ name: z.string() }).strict(),
      after: z.object({ name: z.string() }).strict(),
    })
    .strict(),
);

export const boardArchived = defineEvent(
  'board.archived',
  z.object({ boardId: z.string(), name: z.string(), restored: z.boolean() }).strict(),
);

export const listCreated = defineEvent(
  'list.created',
  z.object({ listId: z.string(), boardId: z.string(), name: z.string() }).strict(),
);

export const listUpdated = defineEvent(
  'list.updated',
  z
    .object({
      listId: z.string(),
      boardId: z.string(),
      before: z.object({ name: z.string(), wipLimit: z.number().nullable() }).strict(),
      after: z.object({ name: z.string(), wipLimit: z.number().nullable() }).strict(),
    })
    .strict(),
);

/**
 * A list changed position on its board.
 *
 * Carries both ranks so a realtime consumer can move one column without
 * refetching the board, and so an audit reader can see the direction of travel.
 */
export const listReordered = defineEvent(
  'list.reordered',
  z
    .object({
      listId: z.string(),
      boardId: z.string(),
      fromRank: z.string(),
      toRank: z.string(),
    })
    .strict(),
);

/**
 * Covers restoring as well as archiving, carrying `restored` to say which —
 * the same shape as `card.archived` below.
 *
 * One event rather than two because consumers care about the transition, not
 * the verb: a notification, a search index and an activity feed each need to
 * know a column left or rejoined the board, and splitting it would make every
 * one of them subscribe twice to reconstruct a boolean.
 */
export const listArchived = defineEvent(
  'list.archived',
  z
    .object({
      listId: z.string(),
      boardId: z.string(),
      name: z.string(),
      restored: z.boolean(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Cards
 * -------------------------------------------------------------------------- */

export const cardCreated = defineEvent(
  'card.created',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      listId: z.string(),
      projectId: z.string(),
      /** `WEB-142` — the human-facing identity, resolved once at creation. */
      reference: z.string(),
      title: z.string(),
    })
    .strict(),
);

export const cardUpdated = defineEvent(
  'card.updated',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      /**
       * Which fields actually changed.
       *
       * Notifications and automation both filter on this, and neither should
       * have to diff `before` against `after` to discover that a save touched
       * only the description. Derived by the service from the same comparison
       * that decided whether to write at all.
       */
      changed: z.array(z.string()).readonly(),
      before: z
        .object({
          title: z.string(),
          dueDate: z.string().nullable(),
          startDate: z.string().nullable(),
          priority: z.string().nullable(),
        })
        .strict(),
      after: z
        .object({
          title: z.string(),
          dueDate: z.string().nullable(),
          startDate: z.string().nullable(),
          priority: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
);

/**
 * A card changed list or position — the event with the most consumers.
 *
 * `fromListId` is present even when it equals `toListId`. A reorder within one
 * list and a move between two lists are the same user gesture and the same
 * write, and collapsing them into two event names would make every consumer
 * subscribe to both; keeping them one event with both endpoints lets each
 * consumer decide whether the distinction matters to it. It matters to
 * automation ("entered Done") and not at all to search.
 */
export const cardMoved = defineEvent(
  'card.moved',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      fromListId: z.string(),
      toListId: z.string(),
      fromRank: z.string(),
      toRank: z.string(),
    })
    .strict(),
);

/**
 * The assignee set changed.
 *
 * Both sets in full rather than a delta. A consumer sending "you were assigned"
 * needs to know who is newly on the card, and a consumer withdrawing a
 * notification needs to know who left — a delta in one direction serves one of
 * them and forces the other to reconstruct state it does not have.
 */
export const cardAssigned = defineEvent(
  'card.assigned',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      before: z.array(z.string()).readonly(),
      after: z.array(z.string()).readonly(),
    })
    .strict(),
);

export const cardArchived = defineEvent(
  'card.archived',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      listId: z.string(),
      reference: z.string(),
      restored: z.boolean(),
    })
    .strict(),
);

/**
 * A list's ranks were renormalized (§10.1).
 *
 * Not a user action, and the only event here that no human caused — which is
 * exactly why it needs to exist. Rebalancing rewrites every card's rank in one
 * list, so a realtime consumer holding the old ranks has a stale ordering for
 * the whole column and must be told to refetch rather than patch. Without this
 * event the repair job would silently desynchronize every open board.
 */
export const listRebalanced = defineEvent(
  'list.rebalanced',
  z.object({ listId: z.string(), boardId: z.string(), cardCount: z.number().int() }).strict(),
);

/* -------------------------------------------------------------------------- *
 * Card detail — labels, checklists, custom fields, comments
 *
 * Naming note: events about a card's RELATIONSHIP to something are named on the
 * card (`card.labeled`, `card.field_set`), while events about the definition
 * itself are named on the definition (`label.updated`). The split matters to
 * consumers: renaming a label affects every card carrying it and a realtime
 * consumer must refetch broadly, whereas attaching one affects exactly one card
 * and can be patched in place.
 * -------------------------------------------------------------------------- */

export const labelCreated = defineEvent(
  'label.created',
  z
    .object({ labelId: z.string(), projectId: z.string(), name: z.string(), color: z.string() })
    .strict(),
);

export const labelUpdated = defineEvent(
  'label.updated',
  z
    .object({
      labelId: z.string(),
      projectId: z.string(),
      before: z.object({ name: z.string(), color: z.string() }).strict(),
      after: z.object({ name: z.string(), color: z.string() }).strict(),
    })
    .strict(),
);

/**
 * A label was deleted outright, not archived.
 *
 * The one destructive operation in this slice. A label carries no content of
 * its own — deleting it removes a tag from some cards and destroys nothing a
 * user wrote — so an archive state would be a restorable nothing, and the
 * cascade from `card_labels` is bounded and exact.
 */
export const labelDeleted = defineEvent(
  'label.deleted',
  z
    .object({
      labelId: z.string(),
      projectId: z.string(),
      name: z.string(),
      cardCount: z.number().int(),
    })
    .strict(),
);

/** A card's label set changed. Both sets in full, as with `card.assigned`. */
export const cardLabeled = defineEvent(
  'card.labeled',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      before: z.array(z.string()).readonly(),
      after: z.array(z.string()).readonly(),
    })
    .strict(),
);

/**
 * `boardId` added for Phase 4 Wave 2 (ai/phase-4-realtime.md §5): the
 * realtime event→room table (`apps/realtime/src/event-rooms.ts`) routes
 * strictly on a fixed payload key, no lookup, so a checklist event needs its
 * board id on the payload the same way `card.labeled` and `card.field_set`
 * already carry theirs — `cardId` alone names a card, not a room. Every
 * caller here already holds the parent card (`loadCard`/`loadItem` +
 * `loadCard`), so this is not a new query, just a field already in hand.
 */
export const checklistCreated = defineEvent(
  'checklist.created',
  z
    .object({ checklistId: z.string(), cardId: z.string(), boardId: z.string(), name: z.string() })
    .strict(),
);

export const checklistDeleted = defineEvent(
  'checklist.deleted',
  z
    .object({
      checklistId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      name: z.string(),
      itemCount: z.number().int(),
    })
    .strict(),
);

export const checklistItemCreated = defineEvent(
  'checklist_item.created',
  z
    .object({
      itemId: z.string(),
      checklistId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      text: z.string(),
    })
    .strict(),
);

/**
 * An item's text or done state changed.
 *
 * One event for both, carrying `done` on each side, because the interesting
 * consumer question is "did this tick complete the checklist?" — which needs
 * the counters that the same transaction updated, not a second event name.
 */
export const checklistItemUpdated = defineEvent(
  'checklist_item.updated',
  z
    .object({
      itemId: z.string(),
      checklistId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      before: z.object({ text: z.string(), done: z.boolean() }).strict(),
      after: z.object({ text: z.string(), done: z.boolean() }).strict(),
    })
    .strict(),
);

export const checklistItemDeleted = defineEvent(
  'checklist_item.deleted',
  z
    .object({
      itemId: z.string(),
      checklistId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      text: z.string(),
    })
    .strict(),
);

export const customFieldCreated = defineEvent(
  'custom_field.created',
  z
    .object({ fieldId: z.string(), projectId: z.string(), name: z.string(), type: z.string() })
    .strict(),
);

export const customFieldUpdated = defineEvent(
  'custom_field.updated',
  z
    .object({
      fieldId: z.string(),
      projectId: z.string(),
      before: z.object({ name: z.string() }).strict(),
      after: z.object({ name: z.string() }).strict(),
    })
    .strict(),
);

/**
 * A field definition was archived or restored.
 *
 * Archived rather than deleted, unlike a label: a custom field's VALUES are
 * data a user entered, and deleting the definition would cascade them away.
 * Archiving hides the field from the card UI and leaves every value intact.
 */
export const customFieldArchived = defineEvent(
  'custom_field.archived',
  z
    .object({ fieldId: z.string(), projectId: z.string(), name: z.string(), restored: z.boolean() })
    .strict(),
);

/**
 * A custom field's value on one card changed.
 *
 * `value` is `unknown` because its shape is decided by the field's `type`,
 * which the payload also carries. A consumer that cares reads the type first —
 * the same thing the renderer does.
 */
export const cardFieldSet = defineEvent(
  'card.field_set',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      fieldId: z.string(),
      fieldType: z.string(),
      before: z.unknown(),
      after: z.unknown(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Status (migration 0011, `ai/phase-3.5-work-ux.md` §5.4)
 *
 * `card.status_changed` is a first-class event, not folded into `card.updated`
 * the way priority rides it. Automation (Phase 10) fires on status TRANSITIONS
 * specifically — "entered Done" — and a consumer that has to diff two
 * `card.updated` payloads to notice one changed is a consumer that will get it
 * wrong. `card.moved` is the existing analogue for list moves and this is its
 * sibling.
 * -------------------------------------------------------------------------- */

export const statusCreated = defineEvent(
  'status.created',
  z
    .object({
      statusId: z.string(),
      projectId: z.string(),
      name: z.string(),
      category: z.string(),
    })
    .strict(),
);

export const statusUpdated = defineEvent(
  'status.updated',
  z
    .object({
      statusId: z.string(),
      projectId: z.string(),
      before: z
        .object({
          name: z.string(),
          category: z.string(),
          color: z.string(),
          isDefault: z.boolean(),
        })
        .strict(),
      after: z
        .object({
          name: z.string(),
          category: z.string(),
          color: z.string(),
          isDefault: z.boolean(),
        })
        .strict(),
    })
    .strict(),
);

/**
 * A status was deleted outright, not archived — the same reasoning as
 * `label.deleted`. A status carries no content of its own; deleting it
 * un-classifies some cards (`ON DELETE SET NULL (status_id)`) and destroys
 * nothing a user wrote, so an archived status would be a restorable nothing.
 */
export const statusDeleted = defineEvent(
  'status.deleted',
  z
    .object({
      statusId: z.string(),
      projectId: z.string(),
      name: z.string(),
      cardCount: z.number().int(),
    })
    .strict(),
);

/** A card's status changed — the trigger Phase 10 automation asks about. */
export const cardStatusChanged = defineEvent(
  'card.status_changed',
  z
    .object({
      cardId: z.string(),
      boardId: z.string(),
      before: z.string().nullable(),
      after: z.string().nullable(),
    })
    .strict(),
);

export const commentCreated = defineEvent(
  'comment.created',
  z
    .object({
      commentId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      /** Flattened text, not the JSON. Notifications need words, not a document. */
      excerpt: z.string(),
      /** Null for a top-level comment, the parent's id for a reply. */
      parentCommentId: z.string().nullable(),
      /**
       * Every user id `@mentioned` in the comment (Phase 9,
       * ai/phase-9-notifications.md §4). Extracted at write time by
       * `work/richtext.ts`'s `mentionedUserIds`, the same pass that already
       * builds `excerpt` — one more field off a walk this event already pays
       * for, not a new one.
       */
      mentionedUserIds: z.array(z.string()).readonly(),
    })
    .strict(),
);

export const commentUpdated = defineEvent(
  'comment.updated',
  z.object({ commentId: z.string(), cardId: z.string(), boardId: z.string() }).strict(),
);

export const commentDeleted = defineEvent(
  'comment.deleted',
  z
    .object({
      commentId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      /** Whether a moderator removed someone else's comment, rather than their own. */
      byAuthor: z.boolean(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Attachments (§8.4)
 * -------------------------------------------------------------------------- */

/** An upload passed magic-byte verification and the virus scan. */
export const attachmentUploaded = defineEvent(
  'attachment.uploaded',
  z
    .object({
      attachmentId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      filename: z.string(),
      contentType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * An upload was refused — infected, mistyped, or unscannable.
 *
 * Emitted for all three, with `status` distinguishing them, because they are
 * one thing to a user ("that file was not accepted") and three very different
 * things to whoever reads the audit log. A malware detection is an incident; a
 * scanner outage is an availability problem that shows up here first, since a
 * run of `rejected` with a scan-failure reason is what a broken clamd looks
 * like before anyone notices.
 */
export const attachmentRejected = defineEvent(
  'attachment.rejected',
  z
    .object({
      attachmentId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      filename: z.string(),
      status: z.enum(['infected', 'rejected']),
      reason: z.string(),
    })
    .strict(),
);

/**
 * A download URL was issued.
 *
 * §8.4 requires every download to be audited, and this is the moment that can
 * be observed — the fetch itself goes browser-to-storage and never touches the
 * API. So the event records the issuing of a capability, not its use, and that
 * distinction is worth keeping in mind when reading the log: a URL that was
 * minted and never followed looks identical here.
 */
export const attachmentDownloaded = defineEvent(
  'attachment.downloaded',
  z
    .object({
      attachmentId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      filename: z.string(),
    })
    .strict(),
);

export const attachmentDeleted = defineEvent(
  'attachment.deleted',
  z
    .object({
      attachmentId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      filename: z.string(),
    })
    .strict(),
);

/**
 * An upload URL was issued.
 *
 * The write-side counterpart to `attachment.downloaded`, and recorded for the
 * same reason: a presigned PUT is a capability to place bytes in this org's
 * bucket, valid for minutes and usable by whoever holds it. Auditing only the
 * successful uploads would leave the grant of that capability invisible.
 *
 * It is also the signal that makes abandoned uploads measurable — a run of
 * presigns with no matching `attachment.uploaded` or `attachment.rejected` is
 * either a broken client or someone probing the endpoint.
 */
export const attachmentPresigned = defineEvent(
  'attachment.presigned',
  z
    .object({
      attachmentId: z.string(),
      cardId: z.string(),
      boardId: z.string(),
      filename: z.string(),
      contentType: z.string(),
      declaredBytes: z.number().int().positive(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Saved views (ai/phase-3.5-work-ux.md §6)
 * -------------------------------------------------------------------------- */

/**
 * `shared` rides on all three because it is the field that decides the
 * AUDIENCE of the change. A consumer deciding whether to notify a board — an
 * activity feed, Phase 9's notifications — needs to distinguish someone
 * rearranging their own bookmark from someone adding a tab everyone will see,
 * and it cannot ask the row afterwards for a deleted view.
 *
 * The filter tree is deliberately NOT in these payloads. It is unbounded in
 * size, every consumer that wants it can read the row, and an outbox entry is
 * replayed into an audit log that keeps it forever.
 */
export const viewCreated = defineEvent(
  'view.created',
  z
    .object({
      viewId: z.string(),
      boardId: z.string(),
      name: z.string(),
      type: z.string(),
      shared: z.boolean(),
    })
    .strict(),
);

export const viewUpdated = defineEvent(
  'view.updated',
  z
    .object({
      viewId: z.string(),
      boardId: z.string(),
      name: z.string(),
      shared: z.boolean(),
    })
    .strict(),
);

export const viewDeleted = defineEvent(
  'view.deleted',
  z
    .object({
      viewId: z.string(),
      boardId: z.string(),
      name: z.string(),
      shared: z.boolean(),
    })
    .strict(),
);
