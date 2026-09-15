import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleDot,
  FolderKanban,
  LayoutGrid,
  SlidersHorizontal,
  Tag,
} from 'lucide-react';
import type {
  BoardId,
  CustomFieldId,
  LabelId,
  ProjectId,
  StatusCategory,
  StatusId,
} from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import {
  AddPanel,
  Button,
  ConfirmButton,
  Empty,
  Field,
  Input,
  SkeletonRows,
  Spinner,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { boardsQuery, labelsQuery, projectsQuery, statusesQuery } from './api.js';
import { GuestAccessSection } from './guest-access-section.js';

/**
 * Everything about a project that is not a card.
 *
 * The permission split this page makes visible: all of it is `project:update`,
 * because every control here changes the vocabulary or structure that every card
 * in the project is expressed in. Filling any of it in on a card is
 * `card:update` and lives in the detail panel.
 *
 * Archiving rather than deleting, throughout — except labels, which are the one
 * thing genuinely deleted. A label holds no content of its own: removing it
 * un-tags some cards and destroys nothing anybody wrote, so an archived label
 * would be a restorable nothing permanently cluttering the project's vocabulary.
 */
export function ProjectSettingsPage() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  const orgId = useSession((state) => state.orgId) ?? '';
  const projects = useQuery(projectsQuery(orgId));

  const project = projects.data?.find((entry) => entry.projectId === projectId);

  if (projects.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (projects.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorView error={projects.error} title="Could not load this project" />
      </div>
    );
  }

  if (project === undefined) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Empty
          title="No such project"
          description="It may have been archived, or belong to another organization."
          action={
            <Link to="/projects" className="text-sm text-accent underline">
              Back to projects
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col p-6">
      {/* Pinned breadcrumb — stays visible while settings sections scroll. */}
      <div className="flex shrink-0 items-center gap-3">
        <Link to="/projects" className="text-sm text-accent underline">
          Projects
        </Link>
        <span className="text-ink-faint">/</span>
        <div className="flex items-center gap-2.5">
          <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
            {project.name}
          </h1>
          <span className="rounded-lg bg-accent/10 px-2 py-0.5 font-mono text-xs font-medium text-accent">
            {project.key}
          </span>
        </div>
      </div>

      {/* Scrollable settings sections */}
      <div className="mt-8 min-h-0 flex-1 space-y-6 overflow-y-auto">
        <ProjectDetails orgId={orgId} project={project} />
        <BoardSection
          orgId={orgId}
          projectId={projectId}
          canCreateBoard={project.capabilities.update}
        />
        <LabelSettings orgId={orgId} projectId={projectId} />
        <StatusSettings orgId={orgId} projectId={projectId} />
        <FieldSettings orgId={orgId} projectId={projectId} />
        {/* Hidden entirely rather than disabled — Phase 15 §1's "hide, don't
            disable" rule: `work.guests.*` routes are `project:update`-gated the
            same as everything else on this page, and a viewer who cannot
            manage the project has no use for a control that would just be
            refused. */}
        {project.capabilities.update && (
          <GuestAccessSection orgId={orgId} projectId={projectId} />
        )}
      </div>
    </div>
  );
}

function ProjectDetails({
  orgId,
  project,
}: {
  readonly orgId: string;
  readonly project: {
    projectId: string;
    name: string;
    description: string | null;
    capabilities: { readonly update: boolean; readonly delete: boolean };
  };
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });

  const update = useMutation({
    mutationFn: () =>
      api.work.projects.update.mutate({
        projectId: project.projectId,
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
      }),
    onSuccess: refresh,
  });

  const archive = useMutation({
    mutationFn: () =>
      api.work.projects.archive.mutate({
        projectId: project.projectId,
        archived: true,
      }),
    onSuccess: async () => {
      await refresh();
      await navigate({ to: '/projects' });
    },
  });

  return (
    <div className="rounded-2xl border border-line/40 bg-surface-raised p-5">
      <div className="mb-4 flex items-center gap-2">
        <FolderKanban className="size-4 text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Project</h2>
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') update.mutate();
        }}
      >
        <Field label="Name" htmlFor="project-name">
          <Input
            id="project-name"
            value={name}
            disabled={!project.capabilities.update}
            title={
              project.capabilities.update
                ? undefined
                : 'You do not have permission to edit this project.'
            }
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field label="Description" htmlFor="project-description">
          <Input
            id="project-description"
            value={description}
            disabled={!project.capabilities.update}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={!project.capabilities.update || update.isPending}
          >
            Save
          </Button>
          {/* Confirmed despite being restorable, unlike the other archive
              buttons on this page: this one also NAVIGATES AWAY, so a stray
              click loses the page you were working on as well as hiding the
              project from everyone else. */}
          {project.capabilities.delete && (
            <div className="ml-auto">
              <ConfirmButton
                label="Archive project"
                confirmLabel="Archive and leave"
                size="md"
                disabled={archive.isPending}
                onConfirm={() => {
                  archive.mutate();
                }}
              />
            </div>
          )}
        </div>
      </form>

      {/* The KEY is not editable, and that is not an oversight: it is baked into
          every card reference ever issued (`WEB-142`), including ones already
          pasted into chat messages and commit titles. Changing it would silently
          orphan all of them. */}
      <p className="mt-3 text-xs text-ink-faint">
        The project key cannot be changed — it is part of every card number already issued.
      </p>

      {update.isError && <ErrorText error={update.error} />}
      {archive.isError && <ErrorText error={archive.error} />}
    </div>
  );
}

function BoardSection({
  orgId,
  projectId,
  canCreateBoard,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  /** project:update on the PARENT project — createBoard enforces it there, not board:create. */
  readonly canCreateBoard: boolean;
}) {
  const queryClient = useQueryClient();
  const boards = useQuery(boardsQuery(orgId, projectId));
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.boards(orgId, projectId) });

  const rename = useMutation({
    mutationFn: (input: { boardId: BoardId; name: string }) => api.work.boards.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const archive = useMutation({
    mutationFn: (boardId: BoardId) => api.work.boards.archive.mutate({ boardId, archived: true }),
    onSuccess: refresh,
  });

  const create = useMutation({
    mutationFn: (boardName: string) =>
      api.work.boards.create.mutate({ projectId, name: boardName }),
    onSuccess: async () => {
      setNewName('');
      await refresh();
    },
  });

  const live = (boards.data ?? []).filter((board) => board.archivedAt === null);

  return (
    <div className="rounded-2xl border border-line/40 bg-surface-raised p-5">
      <div className="mb-4 flex items-center gap-2">
        <LayoutGrid className="size-4 text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Boards</h2>
        {boards.data !== undefined && (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
            {live.length}
          </span>
        )}
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        Rename, create, or archive. Archiving hides a board without touching its cards.
      </p>

      {boards.isPending && <SkeletonRows rows={2} className="*:h-10" />}

      {boards.data !== undefined && live.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line/50 py-8 text-center">
          <LayoutGrid className="size-8 text-ink-faint/50" />
          <p className="text-sm font-medium text-ink">No boards in this project</p>
          <p className="text-xs text-ink-muted">A project without a board has nowhere to put cards.</p>
        </div>
      ) : (
        <ul className="space-y-1">
          {live.map((board) => (
            <li
              key={board.boardId}
              className="group flex items-center gap-2 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-hover"
            >
              {editing === board.boardId ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim() !== '') {
                      rename.mutate({ boardId: board.boardId as BoardId, name: name.trim() });
                    }
                  }}
                >
                  <Input
                    aria-label="Board name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                    className="h-8 text-xs"
                  />
                  <Button type="submit" size="sm" variant="primary" disabled={rename.isPending}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <Link
                    to="/boards/$boardId"
                    params={{ boardId: board.boardId as BoardId }}
                    search={{ view: 'board', project: projectId }}
                    className="flex-1 truncate text-sm text-ink transition-colors group-hover:text-accent"
                  >
                    {board.name}
                  </Link>
                  {/* Per-board, not the project's own capability — a board
                      can carry its own share grant (share-board.tsx)
                      independent of project-level access. */}
                  {board.capabilities.update && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => {
                        setEditing(board.boardId);
                        setName(board.name);
                      }}
                    >
                      Rename
                    </Button>
                  )}
                  {/* No confirm: archiving is reversible and the board's cards
                      are untouched. Guarding an undoable action is the noise
                      that trains people to click through the confirms that
                      matter — the Delete buttons further down this page. */}
                  {board.capabilities.delete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => {
                        archive.mutate(board.boardId as BoardId);
                      }}
                    >
                      Archive
                    </Button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Creation, on the page that manages boards. Previously it lived only
          on the projects list, and this section's own description pointed
          there — a settings page that can rename and archive a thing but not
          make one sends you elsewhere to finish a job you started here. */}
      {canCreateBoard && (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (newName.trim() !== '') create.mutate(newName.trim());
          }}
        >
          <Input
            aria-label="New board name"
            placeholder="New board name"
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value);
            }}
            className="h-8 max-w-xs text-xs"
          />
          <Button type="submit" size="sm" disabled={create.isPending || newName.trim() === ''}>
            {create.isPending ? 'Adding…' : 'Add board'}
          </Button>
        </form>
      )}

      {rename.isError && <ErrorText error={rename.error} />}
      {archive.isError && <ErrorText error={archive.error} />}
      {create.isError && <ErrorText error={create.error} />}
    </div>
  );
}

function LabelSettings({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const labels = useQuery(labelsQuery(orgId, projectId));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', color: '#6366f1' });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.labels(orgId, projectId) });

  const update = useMutation({
    mutationFn: (input: { labelId: LabelId; name: string; color: string }) =>
      api.work.labels.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (labelId: LabelId) => api.work.labels.delete.mutate({ labelId }),
    onSuccess: refresh,
  });

  return (
    <div className="rounded-2xl border border-line/40 bg-surface-raised p-5">
      <div className="mb-4 flex items-center gap-2">
        <Tag className="size-4 text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Labels</h2>
        {labels.data !== undefined && (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
            {labels.data.length}
          </span>
        )}
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        Deleting a label removes it from every card carrying it, and cannot be undone — a label holds
        no content of its own, so there is nothing to archive.
      </p>

      {labels.isPending && <SkeletonRows rows={3} className="*:h-10" />}

      {/* No create form here, deliberately, and the empty state has to say so
          rather than leave someone hunting for one. A label is minted from the
          card panel at the moment it is first needed; a project-level "new
          label" box invites naming a vocabulary up front for cards nobody has
          written yet. This section EDITS the vocabulary that use produced. */}
      {labels.data?.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line/50 py-8 text-center">
          <Tag className="size-8 text-ink-faint/50" />
          <p className="text-sm font-medium text-ink">No labels yet</p>
          <p className="text-xs text-ink-muted">
            Labels are created from a card's detail panel, the first time one is needed. They can be
            renamed and recoloured here afterwards.
          </p>
        </div>
      ) : (
        <ul className="space-y-1">
          {(labels.data ?? []).map((label) => (
            <li
              key={label.labelId}
              className="group flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-hover"
            >
              {editing === label.labelId ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.name.trim() !== '') {
                      update.mutate({
                        labelId: label.labelId as LabelId,
                        name: draft.name.trim(),
                        color: draft.color,
                      });
                    }
                  }}
                >
                  <input
                    type="color"
                    aria-label="Label colour"
                    value={draft.color}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, color: event.target.value }));
                    }}
                    className="h-8 w-10 rounded-lg border border-line bg-surface-sunken"
                  />
                  <Input
                    aria-label="Label name"
                    value={draft.name}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, name: event.target.value }));
                    }}
                    className="h-8 flex-1 text-xs"
                  />
                  <Button type="submit" size="sm" variant="primary" disabled={update.isPending}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span
                    className="size-3.5 shrink-0 rounded-md"
                    style={{ backgroundColor: label.color }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate text-sm text-ink">{label.name}</span>
                  <span className="text-xs text-ink-faint">
                    {label.cardCount} {label.cardCount === 1 ? 'card' : 'cards'}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => {
                      setEditing(label.labelId);
                      setDraft({ name: label.name, color: label.color });
                    }}
                  >
                    Edit
                  </Button>
                  {/* The count is in the confirm label because it IS the
                      decision: deleting a label nobody used and deleting one
                      on forty cards are the same click and very different
                      acts. */}
                  <ConfirmButton
                    label="Delete"
                    confirmLabel={
                      label.cardCount === 0
                        ? 'Delete label'
                        : `Delete from ${String(label.cardCount)} ${label.cardCount === 1 ? 'card' : 'cards'}`
                    }
                    disabled={remove.isPending}
                    onConfirm={() => {
                      remove.mutate(label.labelId as LabelId);
                    }}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {update.isError && <ErrorText error={update.error} />}
      {remove.isError && <ErrorText error={remove.error} />}
    </div>
  );
}

const STATUS_CATEGORIES: readonly StatusCategory[] = ['not_started', 'active', 'done'];
const STATUS_CATEGORY_LABEL: Readonly<Record<StatusCategory, string>> = {
  not_started: 'Not started',
  active: 'Active',
  done: 'Done',
};

/**
 * Statuses — the one vocabulary here that has NOWHERE ELSE to be created.
 *
 * Unlike a label, which can be minted from the card panel the first time
 * someone wants to tag something, a status has no such entry point: a board
 * grouped by status needs the columns to exist before anyone can drag a card
 * into one. So this is the only form on the page with a genuine "create".
 */
function StatusSettings({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const statuses = useQuery(statusesQuery(orgId, projectId));
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    name: string;
    category: StatusCategory;
    color: string;
    isDefault: boolean;
  }>({ name: '', category: 'not_started', color: '#94a3b8', isDefault: false });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: keys.statuses(orgId, projectId) });

  const create = useMutation({
    mutationFn: (input: {
      name: string;
      category: StatusCategory;
      color: string;
      isDefault: boolean;
    }) => api.work.statuses.create.mutate({ projectId, ...input }),
    onSuccess: async () => {
      setDraft({ name: '', category: 'not_started', color: '#94a3b8', isDefault: false });
      await refresh();
    },
  });

  const update = useMutation({
    mutationFn: (input: {
      statusId: StatusId;
      name: string;
      category: StatusCategory;
      color: string;
      isDefault: boolean;
    }) => api.work.statuses.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (statusId: StatusId) => api.work.statuses.delete.mutate({ statusId }),
    onSuccess: refresh,
  });

  return (
    <div className="rounded-2xl border border-line/40 bg-surface-raised p-5">
      <div className="mb-4 flex items-center gap-2">
        <CircleDot className="size-4 text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Statuses</h2>
        {statuses.data !== undefined && (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
            {statuses.data.length}
          </span>
        )}
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        What a board grouped by status shows as columns. The default is where a new card lands when
        nothing else was chosen.
      </p>

      {/* The create form, ABOVE the list.
          It used to sit underneath, which is the wrong end for the one section
          on this page that has a genuine create: a project accumulates statuses,
          so the control drifted further down the page the more it was used — and
          it was hidden entirely while any row was being edited. */}
      {editing === null && (
        <AddPanel>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.name.trim() !== '') {
                create.mutate({ ...draft, name: draft.name.trim() });
              }
            }}
          >
            <input
              type="color"
              aria-label="New status colour"
              value={draft.color}
              onChange={(event) => {
                setDraft((current) => ({ ...current, color: event.target.value }));
              }}
              className="h-8 w-10 rounded-lg border border-line bg-surface"
            />
            <Input
              aria-label="New status name"
              placeholder="Status name"
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
              className="h-8 flex-1 text-xs"
            />
            <select
              aria-label="New status category"
              value={draft.category}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  category: event.target.value as StatusCategory,
                }));
              }}
              className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-ink"
            >
              {STATUS_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {STATUS_CATEGORY_LABEL[category]}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, isDefault: event.target.checked }));
                }}
                className="size-3.5 rounded border-line"
              />
              Default
            </label>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={create.isPending || draft.name.trim() === ''}
            >
              Add status
            </Button>
          </form>
        </AddPanel>
      )}

      {statuses.isPending && <SkeletonRows rows={3} className="*:h-10" />}

      {statuses.data?.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line/50 py-8 text-center">
          <CircleDot className="size-8 text-ink-faint/50" />
          <p className="text-sm font-medium text-ink">No statuses yet</p>
          <p className="text-xs text-ink-muted">
            A board grouped by status needs these to exist before a card can be dragged into one.
          </p>
        </div>
      ) : (
        <ul className="space-y-1">
          {(statuses.data ?? []).map((status) => (
            <li
              key={status.statusId}
              className="group flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-hover"
            >
              {editing === status.statusId ? (
                <form
                  className="flex flex-1 flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (draft.name.trim() !== '') {
                      update.mutate({ statusId: status.statusId as StatusId, ...draft });
                    }
                  }}
                >
                  <input
                    type="color"
                    aria-label="Status colour"
                    value={draft.color}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, color: event.target.value }));
                    }}
                    className="h-8 w-10 rounded-lg border border-line bg-surface-sunken"
                  />
                  <Input
                    aria-label="Status name"
                    value={draft.name}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, name: event.target.value }));
                    }}
                    className="h-8 flex-1 text-xs"
                  />
                  <select
                    aria-label="Category"
                    value={draft.category}
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        category: event.target.value as StatusCategory,
                      }));
                    }}
                    className="h-8 rounded-lg border border-line bg-surface-sunken px-2 text-xs text-ink"
                  >
                    {STATUS_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {STATUS_CATEGORY_LABEL[category]}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <input
                      type="checkbox"
                      checked={draft.isDefault}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, isDefault: event.target.checked }));
                      }}
                      className="size-3.5 rounded border-line"
                    />
                    Default
                  </label>
                  <Button type="submit" size="sm" variant="primary" disabled={update.isPending}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span
                    className="size-3.5 shrink-0 rounded-md"
                    style={{ backgroundColor: status.color }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate text-sm text-ink">
                    {status.name}
                    {status.isDefault && (
                      <span className="ml-2 rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-ink-muted">
                        default
                      </span>
                    )}
                  </span>
                  <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
                    {STATUS_CATEGORY_LABEL[status.category]}
                  </span>
                  <span className="text-xs text-ink-faint">
                    {status.cardCount} {status.cardCount === 1 ? 'card' : 'cards'}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => {
                      setEditing(status.statusId);
                      setDraft({
                        name: status.name,
                        category: status.category,
                        color: status.color,
                        isDefault: status.isDefault,
                      });
                    }}
                  >
                    Edit
                  </Button>
                  {/* Deleting a status un-classifies its cards rather than
                      deleting them (`ON DELETE SET NULL`), so the count is what
                      the confirm needs to state: nothing is lost except which
                      column those cards were in, and that is not recoverable. */}
                  <ConfirmButton
                    label="Delete"
                    confirmLabel={
                      status.cardCount === 0
                        ? 'Delete status'
                        : `Un-classify ${String(status.cardCount)} ${status.cardCount === 1 ? 'card' : 'cards'}`
                    }
                    disabled={remove.isPending}
                    onConfirm={() => {
                      remove.mutate(status.statusId as StatusId);
                    }}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {create.isError && <ErrorText error={create.error} />}
      {update.isError && <ErrorText error={update.error} />}
      {remove.isError && <ErrorText error={remove.error} />}
    </div>
  );
}

function FieldSettings({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');

  /* Archived fields are INCLUDED here, and only here. A card panel shows live
     fields only; this is the one place an archived one can be brought back, and
     without it archiving would be a one-way door. */
  const fields = useQuery({
    queryKey: [...keys.fields(orgId, projectId), 'all'],
    queryFn: async () => api.work.fields.list.query({ projectId, includeArchived: true }),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.fields(orgId, projectId) });

  const rename = useMutation({
    mutationFn: (input: { fieldId: CustomFieldId; name: string }) =>
      api.work.fields.update.mutate(input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
  });

  const setArchived = useMutation({
    mutationFn: (input: { fieldId: CustomFieldId; archived: boolean }) =>
      api.work.fields.archive.mutate(input),
    onSuccess: refresh,
  });

  return (
    <div className="rounded-2xl border border-line/40 bg-surface-raised p-5">
      <div className="mb-4 flex items-center gap-2">
        <SlidersHorizontal className="size-4 text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Custom fields</h2>
        {fields.data !== undefined && (
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
            {fields.data.length}
          </span>
        )}
      </div>
      <p className="mb-4 text-[13px] leading-relaxed text-ink-muted">
        A field's TYPE is fixed once created — there is no honest migration from a choice list to a
        number, and every option would silently rewrite data someone entered. Archiving hides a field
        without discarding the values on existing cards.
      </p>

      {fields.isPending && <SkeletonRows rows={2} className="*:h-10" />}

      {fields.data?.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line/50 py-8 text-center">
          <SlidersHorizontal className="size-8 text-ink-faint/50" />
          <p className="text-sm font-medium text-ink">No custom fields yet</p>
          <p className="text-xs text-ink-muted">
            Fields are created from a card's detail panel. Archived ones stay listed here, which is the
            only place they can be restored.
          </p>
        </div>
      ) : (
        <ul className="space-y-1">
          {(fields.data ?? []).map((field) => (
            <li
              key={field.fieldId}
              className="group flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-colors hover:bg-surface-hover"
            >
              {editing === field.fieldId ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (name.trim() !== '') {
                      rename.mutate({ fieldId: field.fieldId as CustomFieldId, name: name.trim() });
                    }
                  }}
                >
                  <Input
                    aria-label="Field name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                    }}
                    className="h-8 flex-1 text-xs"
                  />
                  <Button type="submit" size="sm" variant="primary" disabled={rename.isPending}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="flex-1 truncate text-sm text-ink">
                    {field.name}
                    {field.archivedAt !== null && (
                      <span className="ml-2 rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-ink-muted">
                        archived
                      </span>
                    )}
                  </span>
                  <span className="rounded-full bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink-muted">
                    {field.type}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => {
                      setEditing(field.fieldId);
                      setName(field.name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={() => {
                      setArchived.mutate({
                        fieldId: field.fieldId as CustomFieldId,
                        archived: field.archivedAt === null,
                      });
                    }}
                  >
                    {field.archivedAt === null ? 'Archive' : 'Restore'}
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {rename.isError && <ErrorText error={rename.error} />}
      {setArchived.isError && <ErrorText error={setArchived.error} />}
    </div>
  );
}
