import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban, LayoutGrid, Settings, Copy, Plus } from 'lucide-react';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import {
  Button,
  Empty,
  Field,
  FocusOnMountInput,
  Input,
  PageHeader,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { boardsQuery, projectsQuery } from './api.js';
import { orgDetailQuery } from '../org/api.js';

/**
 * Projects, and the boards inside them.
 *
 * Nothing here compares a role before rendering a button — that would be the
 * UI REIMPLEMENTING `can()`, producing a second authorization model that
 * drifts from the tested one (§8.2). Instead every control keys off a
 * `capabilities` object the SERVER already computed with the real `can()`:
 * `createProject`/`duplicate` from `orgs.get` (role-only — creating has no
 * existing resource to hold a tuple), and each project/board's own
 * `capabilities.update`/`.delete` from `projects.list`/`boards.list`
 * (per-resource — `share-board.tsx` can grant `board:update` on one board
 * independent of the project's own access). The client hides a control it is
 * told it cannot use; the server is still what actually refuses the mutation.
 *
 * ## Archived projects are reachable from here
 *
 * `projects.list` takes `includeArchived` and archiving is what this product
 * offers instead of deletion (§7.1) — so a list that always filtered them out
 * made the archive a one-way door with no door. The toggle only appears once
 * something is actually archived, because a filter with nothing to reveal looks
 * identical to a broken one.
 */

/**
 * Derive a stable hue from a project key so each project gets a distinct
 * accent colour. Uses the same hash technique as Avatar but over the key
 * string instead of a user id.
 */
function projectHue(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function ProjectsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery(projectsQuery(orgId, showArchived));
  const orgDetail = useQuery(orgDetailQuery(orgId));
  const canCreateProject = orgDetail.data?.capabilities.createProject ?? false;
  const [creating, setCreating] = useState(false);

  if (projects.isPending) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <SkeletonRows rows={4} className="*:h-24" />
      </div>
    );
  }

  if (projects.isError) {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <ErrorView error={projects.error} title="Could not load projects" />
      </div>
    );
  }

  const live = projects.data.filter((project) => project.archivedAt === null);
  const archived = projects.data.filter((project) => project.archivedAt !== null);
  const shown = showArchived ? projects.data : live;

  return (
    <div className="h-full min-h-0 overflow-y-auto mx-auto flex max-w-6xl flex-col gap-6 p-8">
      <PageHeader
        title="Projects"
        description="A project owns its boards, labels, statuses and card numbering."
        actions={
          canCreateProject ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setCreating((open) => !open);
              }}
            >
              {creating ? 'Cancel' : 'New project'}
            </Button>
          ) : undefined
        }
      />

      {creating && canCreateProject && (
        <CreateProjectForm
          orgId={orgId}
          onDone={() => {
            setCreating(false);
          }}
        />
      )}

      {live.length === 0 && !showArchived ? (
        <Empty
          icon={<FolderKanban aria-hidden="true" className="size-5" strokeWidth={1.75} />}
          title="No projects yet"
          description="A project holds boards, labels and fields. Create one to get started."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {shown.map((project) => (
            <ProjectCard
              key={project.projectId}
              orgId={orgId}
              project={project}
              showArchived={showArchived}
              canDuplicate={canCreateProject}
            />
          ))}
        </div>
      )}

      {(archived.length > 0 || showArchived) && (
        <button
          type="button"
          onClick={() => {
            setShowArchived((value) => !value);
          }}
          className="self-start rounded-md px-2 py-1 text-xs text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink-muted"
        >
          {showArchived ? 'Hide archived' : `Show archived (${String(archived.length)})`}
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
    readonly capabilities: { readonly update: boolean; readonly delete: boolean };
  };
  readonly showArchived: boolean;
  /** project:create, role-only — same flag "New project" uses, not this project's own capabilities. */
  readonly canDuplicate: boolean;
}

function ProjectCard({ orgId, project, showArchived, canDuplicate }: ProjectCardProps) {
  const isArchived = project.archivedAt !== null;
  const [duplicating, setDuplicating] = useState(false);
  const hue = projectHue(project.key);
  const hasDescription = project.description !== null && project.description !== '';

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-line/50 bg-surface-raised transition-all duration-[var(--motion-base)] hover:border-line-strong hover:shadow-md">
      {/* Subtle top accent — the project's identity stripe */}
      <div className="h-1 w-full" style={{ backgroundColor: `oklch(58% 0.14 ${String(hue)})` }} />

      <div className="flex flex-1 flex-col p-5">
        {/* Header: key badge + name */}
        <div className="flex items-center gap-3">
          <span
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold text-white shadow-sm"
            style={{ backgroundColor: `oklch(50% 0.14 ${String(hue)})` }}
          >
            {project.key}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold leading-snug text-ink">
                {project.name}
              </h2>
              {isArchived && (
                <span className="inline-flex shrink-0 items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-faint">
                  archived
                </span>
              )}
            </div>
          </div>

          {/* Actions — icon buttons, visible on hover */}
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {!isArchived && canDuplicate && (
              <button
                type="button"
                onClick={() => {
                  setDuplicating((open) => !open);
                }}
                className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
                title="Duplicate project"
              >
                <Copy aria-hidden="true" className="size-3.5" />
              </button>
            )}
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.projectId as ProjectId }}
              className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
              title="Project settings"
            >
              <Settings aria-hidden="true" className="size-3.5" />
            </Link>
          </div>
        </div>

        {/* Description */}
        <div className="mt-3 min-h-[2.5rem]">
          {hasDescription ? (
            <p className="line-clamp-2 text-[13px] leading-relaxed text-ink-muted">
              {project.description}
            </p>
          ) : (
            <p className="text-[13px] text-ink-faint/50">No description</p>
          )}
        </div>

        {duplicating && (
          <div className="mt-3">
            <DuplicateProjectForm
              orgId={orgId}
              projectId={project.projectId as ProjectId}
              sourceName={project.name}
              onDone={() => {
                setDuplicating(false);
              }}
            />
          </div>
        )}

        {/* Boards section */}
        <div className="mt-auto pt-4">
          <BoardList
            orgId={orgId}
            projectId={project.projectId as ProjectId}
            boardCount={project.boardCount}
            showArchived={showArchived}
            canCreateBoard={project.capabilities.update}
            hue={hue}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Copying a project into a new one (`duplicate.service.ts`).
 *
 * Deliberately NOT the import/export dialog. That moves cards through a file
 * and cannot carry rank ordering, checklists or custom field values; this
 * copies rows, so the new project is the old one's shape exactly. The two look
 * adjacent and answer different questions — "give this to another system" and
 * "give me another one of these".
 *
 * The key is the only field with no sensible default: it is a namespace, it
 * appears in every card reference, and it is immutable once set. So the name
 * is pre-filled and the key is not.
 */
function DuplicateProjectForm({
  orgId,
  projectId,
  sourceName,
  onDone,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly sourceName: string;
  readonly onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(`${sourceName} (copy)`);
  const [key, setKey] = useState('');
  const [includeCards, setIncludeCards] = useState(true);

  const duplicate = useMutation({
    mutationFn: () =>
      api.work.projects.duplicate.mutate({
        sourceProjectId: projectId,
        name: name.trim(),
        key: key.trim(),
        includeCards,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });
      onDone();
    },
  });

  return (
    <form
      className="space-y-3 rounded-lg border border-line/40 bg-surface-sunken/80 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        duplicate.mutate();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <div className="min-w-0 flex-1 basis-40">
          <Field label="New name" htmlFor={`dup-name-${projectId}`}>
            <Input
              id={`dup-name-${projectId}`}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
        </div>
        <div className="w-28 shrink-0">
          <Field label="Key" htmlFor={`dup-key-${projectId}`}>
            <Input
              id={`dup-key-${projectId}`}
              value={key}
              placeholder="WEB2"
              onChange={(event) => {
                setKey(event.target.value.toUpperCase());
              }}
              className="font-mono"
            />
          </Field>
        </div>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={includeCards}
          onChange={(event) => {
            setIncludeCards(event.target.checked);
          }}
          className="mt-0.5"
        />
        <span className="text-xs text-ink-muted">
          Copy the cards too
          <span className="block text-ink-faint">
            Unticked copies only the shape — boards, lists, statuses, labels and custom fields —
            which is what makes it a template. Comments, attachments and sprints are never copied.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={duplicate.isPending || name.trim() === '' || key.trim() === ''}
        >
          {duplicate.isPending ? 'Copying…' : 'Duplicate'}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {duplicate.isError && <ErrorText error={duplicate.error} />}
    </form>
  );
}

function BoardList({
  orgId,
  projectId,
  boardCount,
  showArchived,
  canCreateBoard,
  hue,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly boardCount: number;
  readonly showArchived: boolean;
  /** project:update on THIS project — createBoard enforces it on the parent, not board:create. */
  readonly canCreateBoard: boolean;
  readonly hue: number;
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

  const live = boards.data?.filter((board) => board.archivedAt === null) ?? [];
  const totalBoards = boards.data?.length ?? boardCount;
  const archivedCount = totalBoards - live.length;

  return (
    <div className="flex flex-col gap-2.5">
      {/* Section header */}
      <div className="flex items-center gap-1.5">
        <LayoutGrid aria-hidden="true" className="size-3.5 text-ink-faint" strokeWidth={1.75} />
        <span className="text-xs font-medium text-ink-faint">
          Boards
          {boards.data !== undefined && (
            <span
              className="ml-1.5 inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
              style={{
                backgroundColor: `oklch(58% 0.14 ${String(hue)} / 10%)`,
                color: `oklch(65% 0.12 ${String(hue)})`,
              }}
            >
              {live.length}
            </span>
          )}
          {showArchived && archivedCount > 0 && (
            <span className="ml-1 text-[10px] text-ink-faint">+{archivedCount} archived</span>
          )}
        </span>
      </div>

      {/* Board chips */}
      <div className="flex flex-wrap gap-1.5">
        {live.map((board) => (
          <Link
            key={board.boardId}
            to="/boards/$boardId"
            params={{ boardId: board.boardId as BoardId }}
            search={{ view: 'board', project: projectId }}
            className="inline-flex items-center gap-1.5 rounded-md bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors duration-[var(--motion-fast)] hover:bg-surface-hover hover:text-ink"
          >
            <LayoutGrid aria-hidden="true" className="size-3 text-ink-faint" strokeWidth={1.75} />
            {board.name}
          </Link>
        ))}

        {boards.data !== undefined && live.length === 0 && !adding && (
          <span className="text-xs text-ink-faint">No boards yet</span>
        )}

        {canCreateBoard &&
          (adding ? (
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim() !== '') create.mutate(name.trim());
              }}
            >
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
              className="inline-flex items-center gap-1 rounded-md border border-dashed border-line/40 px-2.5 py-1 text-xs text-ink-faint transition-colors hover:border-line hover:bg-surface-hover hover:text-ink"
            >
              <Plus aria-hidden="true" className="size-3" />
              Board
            </button>
          ))}
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
      className="space-y-4 rounded-xl border border-dashed border-line bg-surface-sunken/60 p-5"
      onSubmit={(event) => {
        void handleSubmit((values) => {
          create.mutate(values);
        })(event);
      }}
    >
      <div className="flex flex-wrap gap-4">
        <div className="min-w-0 flex-1 basis-48">
          <Field label="Name" htmlFor="project-name">
            <Input
              id="project-name"
              placeholder="Web Platform"
              {...register('name', { required: true })}
            />
          </Field>
        </div>

        <div className="w-32 shrink-0">
          <Field
            label="Key"
            htmlFor="project-key"
            hint="2-10 chars, letters & digits. Used in card numbers. Cannot be changed later."
            error={formState.errors.key?.message}
          >
            <Input
              id="project-key"
              className="font-mono uppercase"
              placeholder="WEB"
              maxLength={10}
              {...register('key', {
                required: 'A key is required.',
                pattern: {
                  value: /^[A-Za-z][A-Za-z0-9]{1,9}$/,
                  message: 'Letters and digits only, starting with a letter.',
                },
              })}
            />
          </Field>
        </div>
      </div>

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
