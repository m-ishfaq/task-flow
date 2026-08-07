import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Docs domain events — guardrail 11 (PLAN.md §10.6; ai/phase-6-docs.md §4).
 *
 * Wave 1's subset of the full catalog: tree and metadata mutations only, since
 * Wave 1 ships no page body content (0023's own note 3). `page.updated` is
 * registered on `content.md`'s promise, not implemented, for the same reason
 * chat's `channel.visibility_changed` note gives — a registered event nothing
 * emits yet is what the Wave 2 debounced-save-boundary write is meant to fill,
 * not a placeholder to build a fake emitter for now. What Wave 1 DOES emit
 * `page.updated` for is a title rename, which is a real, immediate metadata
 * write through the ordinary API — not the debounced content save §4 of the
 * spec describes.
 *
 * `page.siblings_rebalanced` is not in the spec's §4 list. It exists for the
 * identical reason `list.rebalanced` does in Work (CLAUDE.md: "without that
 * event every open board keeps stale ranks for the column and silently
 * desynchronizes") — `movePage` hits the exact same degenerate-rank recovery
 * `moveCard` does, and skipping the event here would be the same silent-drift
 * bug in a different tree.
 *
 * `page.archived` covers both the archive AND the restore transition with a
 * `restored` boolean, reconciling §4's literal "PageArchived · PageRestored"
 * with the convention Work already established for the identical shape —
 * `board.archived` and `list.archived` are both one event, not two, because a
 * consumer cares about the TRANSITION and a boolean says which direction it
 * went. `space.archived` follows the same convention.
 */

/* -------------------------------------------------------------------------- *
 * Spaces
 * -------------------------------------------------------------------------- */

export const spaceCreated = defineEvent(
  'space.created',
  z.object({ spaceId: z.string(), name: z.string() }).strict(),
);

/** One event with a `restored` boolean, matching `board.archived`'s shape. */
export const spaceArchived = defineEvent(
  'space.archived',
  z.object({ spaceId: z.string(), restored: z.boolean() }).strict(),
);

/* -------------------------------------------------------------------------- *
 * Pages
 * -------------------------------------------------------------------------- */

export const pageCreated = defineEvent(
  'page.created',
  z
    .object({
      pageId: z.string(),
      spaceId: z.string(),
      parentPageId: z.string().nullable(),
      title: z.string(),
    })
    .strict(),
);

/**
 * A page was reparented and/or reordered.
 *
 * Carries both parents (nullable — a space root has none) so a consumer can
 * tell a pure reorder from a real move without a second query, the same
 * distinction `card.moved` draws with `listId`.
 */
export const pageMoved = defineEvent(
  'page.moved',
  z
    .object({
      pageId: z.string(),
      spaceId: z.string(),
      fromParentPageId: z.string().nullable(),
      toParentPageId: z.string().nullable(),
      rank: z.string(),
    })
    .strict(),
);

/** Metadata changed — Wave 1: a title rename. See the file header on why. */
export const pageUpdated = defineEvent(
  'page.updated',
  z
    .object({
      pageId: z.string(),
      before: z.object({ title: z.string() }).strict(),
      after: z.object({ title: z.string() }).strict(),
    })
    .strict(),
);

export const pageArchived = defineEvent(
  'page.archived',
  z.object({ pageId: z.string(), restored: z.boolean() }).strict(),
);

/** See the file header — mirrors `list.rebalanced`, not in the spec's own §4 list. */
export const pageSiblingsRebalanced = defineEvent(
  'page.siblings_rebalanced',
  z
    .object({
      spaceId: z.string(),
      parentPageId: z.string().nullable(),
      count: z.number().int().nonnegative(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Page content — Wave 2 (§3.7's third recovery path: docs.page_versions)
 * -------------------------------------------------------------------------- */

/**
 * An on-demand "save a version", through the ordinary API path.
 *
 * Not `page.updated` restated: that event's payload is title-shaped
 * (Wave 1's rename), and a content version has no honest before/after text
 * diff to carry — the state is a materialized Yjs snapshot, not a string.
 * Compaction's own periodic 'autosave' writes do NOT emit this — see
 * `apps/collab/src/compaction.ts`'s header on why it is exempt from
 * guardrail 11 the same way `work/rebalance.ts` is, and why wiring
 * `page.updated` out of autosave (for Phase 8's search index, per this
 * phase's own §2) is a named, deliberate gap rather than built speculatively
 * ahead of the phase that consumes it.
 */
export const pageVersionSaved = defineEvent(
  'page.version_saved',
  z.object({ pageId: z.string(), versionId: z.string() }).strict(),
);

/** A page's live content was reset to an earlier saved version. */
export const pageVersionRestored = defineEvent(
  'page.version_restored',
  z.object({ pageId: z.string(), versionId: z.string() }).strict(),
);

/**
 * The debounced save-boundary event §4 names as `PageUpdated`, emitted by
 * the backlinks relay (`apps/api/src/docs/backlinks.relay.ts`, Wave 3) —
 * never `page.updated` itself, which Wave 1 already claimed for a
 * title-shaped rename payload (this file's own note on `pageVersionSaved`
 * says so explicitly). A consumer that wants "this page's content changed,
 * go re-read it" subscribes to this event, not the title one.
 */
export const pageContentUpdated = defineEvent(
  'page.content_updated',
  z.object({ pageId: z.string() }).strict(),
);

/* -------------------------------------------------------------------------- *
 * Comments and suggestions — Wave 3 (§3.6). Named `page.comment_*` /
 * `page.suggestion_*` rather than the bare `comment.*` Work's card comments
 * already claim (`apps/api/src/work/events.ts`) — `defineEvent` throws at
 * import time on a second registration under one name, and Work's
 * `comment.created`/`comment.updated`/`comment.deleted` carry a
 * card/board-shaped payload that has no `pageId`. Reusing the name would
 * not merely be confusing, it would crash `apps/api`'s boot the moment both
 * routers are wired into the same process, which they already are.
 * -------------------------------------------------------------------------- */

export const pageCommentCreated = defineEvent(
  'page.comment_created',
  z.object({ commentId: z.string(), pageId: z.string() }).strict(),
);

/** Not in §4's own event list, added because guardrail 11 requires it — `updateComment` mutates state and Work's identical `comment.updated` sets the precedent. */
export const pageCommentUpdated = defineEvent(
  'page.comment_updated',
  z.object({ commentId: z.string(), pageId: z.string() }).strict(),
);

/** Covers both resolve and reopen, with a `resolved` boolean — the identical shape `page.archived` uses for archive/restore. */
export const pageCommentResolved = defineEvent(
  'page.comment_resolved',
  z.object({ commentId: z.string(), pageId: z.string(), resolved: z.boolean() }).strict(),
);

export const pageCommentDeleted = defineEvent(
  'page.comment_deleted',
  z.object({ commentId: z.string(), pageId: z.string() }).strict(),
);

export const pageSuggestionCreated = defineEvent(
  'page.suggestion_created',
  z.object({ suggestionId: z.string(), pageId: z.string() }).strict(),
);

/**
 * Covers both accept and reject, with a `status` field — the two are one
 * transition (a pending suggestion decided) for the same reason `resolved`
 * on `page.comment_resolved` is a boolean rather than two events: a
 * consumer cares which way the decision went, not that two unrelated things
 * happened.
 */
export const pageSuggestionDecided = defineEvent(
  'page.suggestion_decided',
  z
    .object({
      suggestionId: z.string(),
      pageId: z.string(),
      status: z.enum(['accepted', 'rejected']),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Publish and templates — Wave 4 (§3.9, §5).
 * -------------------------------------------------------------------------- */

/** `versionId` names the new 'publish'-kind snapshot §3.9 requires re-publishing to create. */
export const pagePublished = defineEvent(
  'page.published',
  z.object({ pageId: z.string(), versionId: z.string() }).strict(),
);

/**
 * The pointer was cleared — NOT that the snapshot row was deleted. See
 * migration 0026's own header: an old 'publish'-kind row is left alone as
 * ordinary version history once this fires, it just stops being the one
 * `pages_public_read`/`page_versions_public_read` can find.
 */
export const pageUnpublished = defineEvent(
  'page.unpublished',
  z.object({ pageId: z.string() }).strict(),
);

export const templateCreated = defineEvent(
  'docs.template_created',
  z.object({ templateId: z.string(), name: z.string() }).strict(),
);

/** Covers both archive and restore, the same `restored` boolean shape `page.archived` uses. */
export const templateArchived = defineEvent(
  'docs.template_archived',
  z.object({ templateId: z.string(), restored: z.boolean() }).strict(),
);
