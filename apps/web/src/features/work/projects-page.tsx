import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { Button, Empty, Field, Input, SkeletonRows } from '../../components/primitives.js';
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
 */

export function ProjectsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const projects = useQuery(projectsQuery(orgId));
  const [creating, setCreating] = useState(false);

  if (projects.isPending) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <SkeletonRows rows={4} className="*:h-20" />
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

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-ink">Projects</h1>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            setCreating((open) => !open);
          }}
        >
          New project
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

      {live.length === 0 ? (
        <Empty title="No projects yet" description="A project holds boards, labels and fields." />
      ) : (
        <ul className="space-y-3">
          {live.map((project) => (
            <li
              key={project.projectId}
              className="rounded border border-line bg-surface-raised p-3"
            >
              <div className="flex items-baseline gap-2">
                <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                  {project.key}
                </span>
                <h2 className="text-sm font-medium text-ink">{project.name}</h2>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.projectId as ProjectId }}
                  className="ml-auto text-xs text-accent underline"
                >
                  Settings
                </Link>
              </div>
              {project.description !== null && (
                <p className="mt-1 text-xs text-ink-muted">{project.description}</p>
              )}
              <BoardList orgId={orgId} projectId={project.projectId as ProjectId} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BoardList({
  orgId,
  projectId,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
}) {
  const boards = useQuery(boardsQuery(orgId, projectId));
  const queryClient = useQueryClient();
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: (boardName: string) =>
      api.work.boards.create.mutate({ projectId, name: boardName }),
    onSuccess: async () => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: keys.boards(orgId, projectId) });
    },
  });

  if (boards.data === undefined) return null;

  const live = boards.data.filter((board) => board.archivedAt === null);

  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      {live.length === 0 ? (
        <p className="text-xs text-ink-faint">No boards yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {live.map((board) => (
            <li key={board.boardId}>
              <Link
                to="/boards/$boardId"
                params={{ boardId: board.boardId as BoardId }}
                search={{ view: 'board', project: projectId }}
                className="inline-block rounded border border-line bg-surface px-2 py-1 text-xs text-ink hover:bg-surface-hover"
              >
                {board.name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '') create.mutate(name.trim());
        }}
      >
        <Input
          aria-label="New board name"
          placeholder="New board"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="h-7 text-xs"
        />
        <Button type="submit" size="sm" disabled={create.isPending || name.trim() === ''}>
          Add
        </Button>
      </form>

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
      await queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });
      onDone();
    },
  });

  return (
    <form
      className="space-y-3 rounded border border-line bg-surface-raised p-3"
      onSubmit={(event) => {
        void handleSubmit((values) => {
          create.mutate(values);
        })(event);
      }}
    >
      <Field label="Name" htmlFor="project-name">
        <Input id="project-name" {...register('name', { required: true })} />
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
          className="uppercase"
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
        <Input id="project-description" {...register('description')} />
      </Field>

      {create.isError && <ErrorView error={create.error} />}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
          Create
        </Button>
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
