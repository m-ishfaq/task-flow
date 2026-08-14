import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Section,
  SkeletonRows,
  Spinner,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { boardsQuery, labelsQuery, projectsQuery, statusesQuery } from './api.js';

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
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div className="flex items-center gap-2">
        <Link to="/projects" className="text-sm text-accent underline">
          Projects
        </Link>
        <span className="text-ink-faint">/</span>
        <h1 className="text-lg font-semibold text-ink">{project.name}</h1>
        <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
          {project.key}
        </span>
      </div>

      <ProjectDetails orgId={orgId} project={project} />
      <BoardSection
        orgId={orgId}
        projectId={projectId}
        canCreateBoard={project.capabilities.update}
      />
      <LabelSettings orgId={orgId} projectId={projectId} />
      <StatusSettings orgId={orgId} projectId={projectId} />
      <FieldSettings orgId={orgId} projectId={projectId} />
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
    <Section title="Project">
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
      <p className="text-xs text-ink-faint">
        The project key cannot be changed — it is part of every card number already issued.
      </p>

      {update.isError && <ErrorText error={update.error} />}
      {archive.isError && <ErrorText error={archive.error} />}
    </Section>
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
    <Section
      title="Boards"
      count={boards.data === undefined ? undefined : live.length}
      /* Was "Boards are created from the projects list" — a settings page
         whose own description sends you somewhere else to do half the job.
         Creation lives here now too, so this page manages boards completely. */
      description="Rename, create, or archive. Archiving hides a board without touching its cards."
    >
      {boards.isPending && <SkeletonRows rows={2} className="*:h-10" />}

      {boards.data !== undefined && live.length === 0 ? (
        <Empty
          title="No boards in this project"
          description="A project without a board has nowhere to put cards."
        />
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {live.map((board) => (
            <li key={board.boardId} className="flex items-center gap-2 px-3 py-2">
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
                    className="h-7 text-xs"
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
                    className="flex-1 truncate text-sm text-ink hover:text-accent"
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
          className="mt-2 flex items-center gap-2"
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
            className="h-7 max-w-xs text-xs"
          />
          <Button type="submit" size="sm" disabled={create.isPending || newName.trim() === ''}>
            {create.isPending ? 'Adding…' : 'Add board'}
          </Button>
        </form>
      )}

      {rename.isError && <ErrorText error={rename.error} />}
      {archive.isError && <ErrorText error={archive.error} />}
      {create.isError && <ErrorText error={create.error} />}
    </Section>
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
    <Section
      title="Labels"
      count={labels.data?.length}
      description="Deleting a label removes it from every card carrying it, and cannot be undone — a label holds no content of its own, so there is nothing to archive."
    >
      {labels.isPending && <SkeletonRows rows={3} className="*:h-10" />}

      {/* No create form here, deliberately, and the empty state has to say so
          rather than leave someone hunting for one. A label is minted from the
          card panel at the moment it is first needed; a project-level "new
          label" box invites naming a vocabulary up front for cards nobody has
          written yet. This section EDITS the vocabulary that use produced. */}
      {labels.data?.length === 0 ? (
        <Empty
          title="No labels yet"
          description="Labels are created from a card's detail panel, the first time one is needed. They can be renamed and recoloured here afterwards."
        />
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {(labels.data ?? []).map((label) => (
            <li key={label.labelId} className="flex items-center gap-2 px-3 py-2">
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
                    className="h-7 w-10 rounded border border-line bg-surface-sunken"
                  />
                  <Input
                    aria-label="Label name"
                    value={draft.name}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, name: event.target.value }));
                    }}
                    className="h-7 text-xs"
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
                    className="size-3 shrink-0 rounded"
                    style={{ backgroundColor: label.color }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate text-sm text-ink">{label.name}</span>
                  <span className="text-[11px] text-ink-faint">
                    {label.cardCount} {label.cardCount === 1 ? 'card' : 'cards'}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
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
    </Section>
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
    <Section
      title="Statuses"
      count={statuses.data?.length}
      description="What a board grouped by status shows as columns. The default is where a new card lands when nothing else was chosen."
    >
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
              className="h-8 w-10 rounded border border-line bg-surface"
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
              className="h-8 rounded border border-line bg-surface px-1.5 text-xs text-ink"
            >
              {STATUS_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {STATUS_CATEGORY_LABEL[category]}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-[11px] text-ink-muted">
              <input
                type="checkbox"
                checked={draft.isDefault}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, isDefault: event.target.checked }));
                }}
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
        <Empty
          title="No statuses yet"
          description="A board grouped by status needs these to exist before a card can be dragged into one."
        />
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {(statuses.data ?? []).map((status) => (
            <li key={status.statusId} className="flex items-center gap-2 px-3 py-2">
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
                    className="h-7 w-10 rounded border border-line bg-surface-sunken"
                  />
                  <Input
                    aria-label="Status name"
                    value={draft.name}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, name: event.target.value }));
                    }}
                    className="h-7 flex-1 text-xs"
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
                    className="h-7 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
                  >
                    {STATUS_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {STATUS_CATEGORY_LABEL[category]}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-[11px] text-ink-muted">
                    <input
                      type="checkbox"
                      checked={draft.isDefault}
                      onChange={(event) => {
                        setDraft((current) => ({ ...current, isDefault: event.target.checked }));
                      }}
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
                    className="size-3 shrink-0 rounded"
                    style={{ backgroundColor: status.color }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate text-sm text-ink">
                    {status.name}
                    {status.isDefault && (
                      <span className="ml-2 text-[11px] text-ink-faint">default</span>
                    )}
                  </span>
                  <span className="text-[11px] text-ink-faint">
                    {STATUS_CATEGORY_LABEL[status.category]}
                  </span>
                  <span className="text-[11px] text-ink-faint">
                    {status.cardCount} {status.cardCount === 1 ? 'card' : 'cards'}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
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
    </Section>
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
    <Section
      title="Custom fields"
      count={fields.data?.length}
      description="A field's TYPE is fixed once created — there is no honest migration from a choice list to a number, and every option would silently rewrite data someone entered. Archiving hides a field without discarding the values on existing cards."
    >
      {fields.isPending && <SkeletonRows rows={2} className="*:h-10" />}

      {fields.data?.length === 0 ? (
        <Empty
          title="No custom fields yet"
          description="Fields are created from a card's detail panel. Archived ones stay listed here, which is the only place they can be restored."
        />
      ) : (
        <ul className="divide-y divide-line rounded border border-line">
          {(fields.data ?? []).map((field) => (
            <li key={field.fieldId} className="flex items-center gap-2 px-3 py-2">
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
                    className="h-7 text-xs"
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
                      <span className="ml-2 text-[11px] text-ink-faint">archived</span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-ink-faint">{field.type}</span>
                  <Button
                    size="sm"
                    variant="ghost"
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
    </Section>
  );
}
