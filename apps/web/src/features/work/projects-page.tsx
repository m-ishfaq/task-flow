import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import {
  Badge,
  Button,
  Empty,
  Field,
  FocusOnMountInput,
  Input,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { boardsQuery, projectsQuery } from './api.js';

/**
 * Projects, and the boards inside them.
 *
 * Nothing here checks a role before rendering a button. A member who cannot
 * create a project sees the form, and the API answers FORBIDDEN — which is the
 * deliberate choice §8.2 describes: the UI consuming `can()` is fine, but the UI
 * REIMPLEMENTING it produces two authorization models that drift, and the one
 * users see is the one that is never tested. Phase 4 wires the decision trace
 * into affordances; until then the server is the only authority and the error is
 * honest.
 *
 * ## Archived projects are reachable from here
 *
 * `projects.list` takes `includeArchived` and archiving is what this product
 * offers instead of deletion (§7.1) — so a list that always filtered them out
 * made the archive a one-way door with no door. The toggle only appears once
 * something is actually archived, because a filter with nothing to reveal looks
 * identical to a broken one.
 */

export function ProjectsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery(projectsQuery(orgId, showArchived));
  const [creating, setCreating] = useState(false);

  if (projects.isPending) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <SkeletonRows rows={4} className="*:h-24" />
      </div>
    );
  }

  if (projects.isError) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <ErrorView error={projects.error} title="Could not load projects" />
      </div>
    );
  }

  const live = projects.data.filter((project) => project.archivedAt === null);
  const archived = projects.data.filter((project) => project.archivedAt !== null);
  const shown = showArchived ? projects.data : live;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
            Projects
            {live.length > 0 && <Badge>{live.length}</Badge>}
          </h1>
          <p className="text-xs text-ink-muted">
            A project owns its boards, labels, statuses and card numbering.
          </p>
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setCreating((open) => !open);
          }}
        >
          {creating ? 'Cancel' : 'New project'}
        </Button>
      </div>

      {creating && (
        <CreateProjectForm
          orgId={orgId}
          onDone={() => {
            setCreating(false);
          }}
        />
      )}

      {live.length === 0 && !showArchived ? (
        <Empty
          title="No projects yet"
          description="A project holds boards, labels and fields. Create one to get started."
        />
      ) : (
        <ul className="space-y-3">
          {shown.map((project) => (
            <ProjectCard
              key={project.projectId}
              orgId={orgId}
              project={project}
              showArchived={showArchived}
            />
          ))}
        </ul>
      )}

      {/* Only offered once there is something behind it. */}
      {(archived.length > 0 || showArchived) && (
        <button
          type="button"
          onClick={() => {
            setShowArchived((value) => !value);
          }}
          className="self-start text-xs text-ink-faint underline hover:text-ink-muted"
        >
          {showArchived ? 'Hide archived projects' : `Show archived (${String(archived.length)})`}
        </button>
      )}
    </div>
  );
}

interface ProjectCardProps {
  readonly orgId: string;
  readonly project: {
    readonly projectId: string;
    readonly name: string;
    readonly key: string;
    readonly description: string | null;
    readonly archivedAt: string | null;
    readonly boardCount: number;
  };
  readonly showArchived: boolean;
}

function ProjectCard({ orgId, project, showArchived }: ProjectCardProps) {
  const isArchived = project.archivedAt !== null;

  return (
    <li
      className={cardClass(isArchived)}
      // Archived projects stay legible rather than being dimmed into
      // unreadability: they are restorable, so they have to be readable enough
      // to decide whether to restore them.
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-muted">
          {project.key}
        </span>
        <h2 className="truncate text-sm font-medium text-ink">{project.name}</h2>
        {isArchived && <Badge className="text-warning">archived</Badge>}

        <Link
          to="/projects/$projectId"
          params={{ projectId: project.projectId as ProjectId }}
          className="ml-auto shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          Settings
        </Link>
      </div>

      {project.description !== null && project.description !== '' && (
        <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{project.description}</p>
      )}

      <BoardList
        orgId={orgId}
        projectId={project.projectId as ProjectId}
        showArchived={showArchived}
      />
    </li>
  );
}

function cardClass(isArchived: boolean): string {
  return isArchived
    ? 'rounded-lg border border-dashed border-line bg-surface-sunken/50 p-3'
    : 'rounded-lg border border-line bg-surface-raised p-3';
}

function BoardList({
  orgId,
  projectId,
  showArchived,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly showArchived: boolean;
}) {
  const boards = useQuery(boardsQuery(orgId, projectId));
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);

  const create = useMutation({
    mutationFn: (boardName: string) =>
      api.work.boards.create.mutate({ projectId, name: boardName }),
    onSuccess: async () => {
      setName('');
      setAdding(false);
      await queryClient.invalidateQueries({ queryKey: keys.boards(orgId, projectId) });
    },
  });

  if (boards.data === undefined) {
    return <div className="mt-3 h-7 border-t border-line pt-3" />;
  }

  const live = boards.data.filter((board) => board.archivedAt === null);

  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {live.map((board) => (
          <Link
            key={board.boardId}
            to="/boards/$boardId"
            params={{ boardId: board.boardId as BoardId }}
            search={{ view: 'board', project: projectId }}
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink transition-colors hover:border-accent/40 hover:bg-surface-hover"
          >
            {board.name}
          </Link>
        ))}

        {live.length === 0 && !adding && (
          <span className="text-xs text-ink-faint">
            No boards yet — a project without one has nowhere to put cards.
          </span>
        )}

        {adding ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() !== '') create.mutate(name.trim());
            }}
          >
            {/* `FocusOnMountInput`, not `autoFocus`: the attribute is banned by
                jsx-a11y because it steals focus on page load. This input is
                mounted by a click, so focusing it is following the user rather
                than surprising them. */}
            <FocusOnMountInput
              aria-label="New board name"
              placeholder="Board name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setName('');
                  setAdding(false);
                }
              }}
              className="h-7 w-40 text-xs"
            />
            <Button type="submit" size="sm" disabled={create.isPending || name.trim() === ''}>
              Add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setName('');
                setAdding(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
            }}
            className="rounded border border-dashed border-line px-2 py-1 text-xs text-ink-faint hover:border-line hover:bg-surface-hover hover:text-ink"
          >
            + Board
          </button>
        )}

        {/* The count is only interesting when it disagrees with what is shown —
            which is exactly the archived case, and otherwise it is noise. */}
        {showArchived && boards.data.length > live.length && (
          <span className="text-[11px] text-ink-faint">
            {boards.data.length - live.length} archived
          </span>
        )}
      </div>

      {create.isError && <ErrorView error={create.error} />}
    </div>
  );
}

interface ProjectValues {
  name: string;
  key: string;
  description: string;
}

function CreateProjectForm({
  orgId,
  onDone,
}: {
  readonly orgId: string;
  readonly onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { register, handleSubmit, formState } = useForm<ProjectValues>({
    defaultValues: { name: '', key: '', description: '' },
  });

  const create = useMutation({
    mutationFn: (values: ProjectValues) =>
      api.work.projects.create.mutate({
        name: values.name,
        key: values.key.toUpperCase(),
        description: values.description === '' ? null : values.description,
      }),
    onSuccess: async () => {
      // The prefix, so the live list and the archived list both refetch.
      await queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });
      onDone();
    },
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-dashed border-line bg-surface-sunken/60 p-3"
      onSubmit={(event) => {
        void handleSubmit((values) => {
          create.mutate(values);
        })(event);
      }}
    >
      <Field label="Name" htmlFor="project-name">
        <Input id="project-name" placeholder="Web Platform" {...register('name', { required: true })} />
      </Field>

      {/**
       * No hyphen appears anywhere near this field, and that is the whole point.
       *
       * The hint used to read "Prefixes every card number, e.g. WEB-142", which
       * is an example of the RESULT and reads as an example of the INPUT — so
       * `WEB-142` went into the box and came back rejected for the hyphen. The
       * obvious repair, spelling out "enter WEB and cards become WEB-1", failed
       * the same way for the same reason: `WEB-1` was the last thing on the line
       * and got typed too.
       *
       * A form field cannot show a worked example of a value it will not accept.
       * Whatever the sentence says, the token nearest the input is what people
       * copy — so the only reliable fix is that every token here is a legal key.
       */}
      <Field
        label="Key"
        htmlFor="project-key"
        hint="Letters and digits only, 2-10 characters — no spaces, no dashes. Card numbers are built from it automatically. Cannot be changed later."
        error={formState.errors.key?.message}
      >
        <Input
          id="project-key"
          className="w-32 font-mono uppercase"
          placeholder="WEB"
          /* Stops the over-long case at the keyboard. The server still trims,
             uppercases and re-validates — neither this nor the pattern below is
             the check, they only move the answer to where it is useful. */
          maxLength={10}
          {...register('key', {
            required: 'A key is required.',
            /* The same shape as `ProjectKey` in apps/api/src/work/router.ts,
               relaxed to accept lowercase because the value is uppercased on the
               way out. Restated rather than imported: it is a message, and the
               server's identical rejection is what actually decides. */
            pattern: {
              value: /^[A-Za-z][A-Za-z0-9]{1,9}$/,
              message: 'Letters and digits only, starting with a letter. No spaces or dashes.',
            },
          })}
        />
      </Field>

      <Field label="Description" htmlFor="project-description">
        <Input
          id="project-description"
          placeholder="Optional — what this project is for."
          {...register('description')}
        />
      </Field>

      {create.isError && <ErrorView error={create.error} />}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
