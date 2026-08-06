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
