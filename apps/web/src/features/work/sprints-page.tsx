import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { Button, Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { boardsQuery, projectsQuery, sprintsQuery } from './api.js';
import { SprintsManagerDialog } from './sprints.js';
import { SprintPlanning } from './sprint-planning.js';

/**
 * A project's sprints, at an address (ai/phase-10.6-sprint-flow.md D2).
 *
 * Phase 10.5 decided the sprint is "a dimension on the existing board rather
 * than a new layout", and shipped it as a `sprint=` param plus a manager behind
 * the board's picker. That decision holds — the board is still where a sprint's
 * cards live, and this page links into it rather than re-rendering them. What
 * it adds is the thing the decision left out: a sprint had NO URL, so nobody
 * could link to one, bookmark one, or reach one without first opening a board
 * and noticing a dropdown.
 *
 * Each sprint links to the project's first board filtered by that sprint, which
 * is exactly what the picker writes. A project with no board yet renders the
 * row without a link rather than a dead one — there is nowhere for cards to be.
 */
export function SprintsPage() {
  const { projectId } = useParams({ from: '/projects/$projectId/sprints' });
  const orgId = useSession((state) => state.orgId) ?? '';
  const [managing, setManaging] = useState(false);

  const projects = useQuery({ ...projectsQuery(orgId), enabled: orgId !== '' });
  const sprints = useQuery({ ...sprintsQuery(orgId, projectId), enabled: orgId !== '' });
  const boards = useQuery({ ...boardsQuery(orgId, projectId), enabled: orgId !== '' });

  const project = (projects.data ?? []).find((entry) => entry.projectId === projectId);
  /* The board a sprint's cards are shown on. First live board, deliberately
     not a picker: this page is a way IN to the board, and a board chooser here
     would be a second navigation decision on a screen whose job is the list. */
  const board = (boards.data ?? []).find((entry) => entry.archivedAt === null);

  if (sprints.isError) return <ErrorText error={sprints.error} />;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-ink">Sprints</h1>
          <p className="mt-0.5 truncate text-xs text-ink-faint">
            {project?.name ?? 'This project'} — planning units. Completing one keeps its done cards
            and returns the rest to the backlog.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            to="/projects/$projectId"
            params={{ projectId }}
            className="text-xs text-accent underline"
          >
            Project settings
          </Link>
          {/* The manager is the SAME dialog the board's picker opens — one
              implementation of create/start/complete/cancel, reached from two
              places. It needs a board because completing a sprint invalidates
              that board's card caches, so it is offered only once one exists. */}
          {board !== undefined && (
            <Button
              size="sm"
              onClick={() => {
                setManaging(true);
              }}
            >
              Manage
            </Button>
          )}
        </div>
      </div>

      {managing && board !== undefined && (
        <SprintsManagerDialog
          orgId={orgId}
          projectId={projectId}
          boardId={board.boardId as BoardId}
          onClose={() => {
            setManaging(false);
          }}
        />
      )}

      <div className="mt-4">
        {sprints.isPending ? (
          <SkeletonRows rows={3} />
        ) : sprints.data.length === 0 ? (
          <Empty
            title="No sprints yet"
            description="Create one to plan a block of work. Cards join a sprint from the board's Sprint picker or the card detail panel."
          />
        ) : (
          <ul className="space-y-1.5">
            {sprints.data.map((sprint) => {
              const row = (
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 transition-colors hover:border-accent">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">{sprint.name}</span>
                      <StatusChip status={sprint.status} />
                    </p>
                    <p className="truncate text-[11px] text-ink-faint">
                      {sprint.startsOn} → {sprint.endsOn}
                      {sprint.goal !== null && sprint.goal !== '' && ` · ${sprint.goal}`}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-ink-faint">
                    {sprint.cardCount} {sprint.cardCount === 1 ? 'card' : 'cards'}
                  </span>
                </div>
              );

              return (
                <li key={sprint.sprintId}>
                  {board === undefined ? (
                    row
                  ) : (
                    <Link
                      to="/boards/$boardId"
                      params={{ boardId: board.boardId as BoardId }}
                      /* `project` travels along for the same reason the
                         sidebar's BoardLink sends it: the card detail panel
                         needs it for the project-scoped label and custom-field
                         vocabulary, and a board reached without it renders a
                         panel missing both. */
                      search={{ view: 'board', project: projectId, sprint: sprint.sprintId }}
                      className="block"
                    >
                      {row}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The planning surface, below the list rather than on its own route:
          choosing WHICH sprint to plan is the list's job, and splitting them
          would mean navigating away from the thing you just decided on. */}
      <SprintPlanning orgId={orgId} projectId={projectId} />
    </div>
  );
}

/* The four lifecycle values, coloured so the running one is findable at a
   glance — the reason this page exists is that a running sprint was hard to
   see. `cancelled` and `completed` are deliberately quiet: they are a record. */
function StatusChip({ status }: { readonly status: string }) {
  const tone =
    status === 'active'
      ? 'bg-success/10 text-success'
      : status === 'planned'
        ? 'bg-accent/10 text-accent'
        : 'bg-surface-raised text-ink-faint';

  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${tone}`}>
      {status}
    </span>
  );
}
