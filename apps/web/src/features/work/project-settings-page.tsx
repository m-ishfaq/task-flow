import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CustomFieldId, LabelId, ProjectId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { Button, Empty, Field, Input, Spinner } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { boardsQuery, labelsQuery, projectsQuery } from './api.js';

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
      <BoardSection orgId={orgId} projectId={projectId} />
      <LabelSettings orgId={orgId} projectId={projectId} />
      <FieldSettings orgId={orgId} projectId={projectId} />
    </div>
  );
}

function ProjectDetails({
  orgId,
  project,
}: {
  readonly orgId: string;
  readonly project: { projectId: string; name: string; description: string | null };
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
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Project</h2>

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
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field label="Description" htmlFor="project-description">
          <Input
            id="project-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>

        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={update.isPending}>
            Save
          </Button>
          <Button
            variant="ghost"
            className="ml-auto text-danger"
            disabled={archive.isPending}
            onClick={() => {
              archive.mutate();
            }}
          >
            Archive project
          </Button>
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
    </section>
  );
}

function BoardSection({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const queryClient = useQueryClient();
  const boards = useQuery(boardsQuery(orgId, projectId));
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');

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

  const live = (boards.data ?? []).filter((board) => board.archivedAt === null);

  return (
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Boards</h2>

      {live.length === 0 ? (
        <p className="text-xs text-ink-faint">No boards in this project.</p>
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
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() => {
                      archive.mutate(board.boardId as BoardId);
                    }}
                  >
                    Archive
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {rename.isError && <ErrorText error={rename.error} />}
      {archive.isError && <ErrorText error={archive.error} />}
    </section>
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
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Labels</h2>

      {(labels.data ?? []).length === 0 ? (
        <p className="text-xs text-ink-faint">
          No labels yet. They are created from a card, or here once one exists.
        </p>
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
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger"
                    onClick={() => {
                      remove.mutate(label.labelId as LabelId);
                    }}
                  >
                    Delete
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {update.isError && <ErrorText error={update.error} />}
      {remove.isError && <ErrorText error={remove.error} />}
    </section>
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
    <section className="space-y-3">
      <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
        Custom fields
      </h2>
      <p className="text-xs text-ink-muted">
        A field&rsquo;s TYPE is fixed once created — there is no honest migration from a choice list
        to a number, and every option would silently rewrite data someone entered. Archiving hides a
        field without discarding the values on existing cards.
      </p>

      {(fields.data ?? []).length === 0 ? (
        <p className="text-xs text-ink-faint">None yet. Add one from any card&rsquo;s panel.</p>
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
    </section>
  );
}
