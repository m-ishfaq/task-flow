import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Sprints (`ai/phase-14-mobile.md` roadmap row: "Sprints — view, assign,
 * project sprint management"). A sprint belongs to a PROJECT, not a board
 * (`packages/db/migrations/0054_sprints.up.sql`'s own tier — same as
 * statuses/labels/custom fields), and a card's `sprintId` is nullable: no
 * sprint means the backlog, which is not a row anywhere, just the absence
 * of one. `sprints.list` sorts active-first, then planned by start date,
 * then closed newest-first — the same order the tab strip in
 * `sprints/[projectId].tsx` renders them, unchanged, rather than
 * re-sorting client-side.
 *
 * **No CSV import here, deliberately** — `work.cards.import` needs a file
 * PICKER (a new native dependency; nothing in this app can currently open
 * a document picker) plus a dry-run preview and a per-row error list, which
 * is real, separate work at the size of this increment's other five new
 * screens combined, not a corner to cut silently inside a sprints port.
 * `work.cards.export` needs none of that — its output is a plain string —
 * so CSV EXPORT ships in this increment via `Share.share`, the same
 * pattern `export-data-section.tsx`'s DSAR export already established.
 */
export type SprintSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['work']['sprints']['list']['query']>>
>[number];

export type SprintStatus = SprintSummary['status'];

export const SPRINT_STATUS_LABEL: Readonly<Record<SprintStatus, string>> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export function sprintsQueryKey(projectId: string): readonly ['work.sprints.list', string] {
  return ['work.sprints.list', projectId];
}

/** A sprint is `planned`/`active` — the only statuses a card may be assigned into (§ the service's own closed-sprint refusal). */
export function isOpenSprint(sprint: SprintSummary): boolean {
  return sprint.status === 'planned' || sprint.status === 'active';
}
