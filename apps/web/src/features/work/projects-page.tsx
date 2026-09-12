import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FolderKanban } from 'lucide-react';
import type { BoardId, ProjectId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import {
  Badge,
  Button,
  Empty,
  Field,
  FocusOnMountInput,
  Input,
  PageContainer,
  PageHeader,
  SkeletonRows,
} from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { boardsQuery, projectsQuery } from './api.js';
import { membersQuery, orgDetailQuery } from '../org/api.js';

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

export function ProjectsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const [showArchived, setShowArchived] = useState(false);
  const projects = useQuery(projectsQuery(orgId, showArchived));
  const orgDetail = useQuery(orgDetailQuery(orgId));
  const canCreateProject = orgDetail.data?.capabilities.createProject ?? false;
  const [creating, setCreating] = useState(false);
  /* Only needed for the getting-started panel's "invite a teammate" step
     below, and only while that panel can even render (no live projects) —
     `enabled` skips the request everywhere else, since every org past its
     first project has no use for this list on this particular page. */
  const members = useQuery({
    ...membersQuery(orgId),
    enabled: orgId !== '' && projects.data?.filter((p) => p.archivedAt === null).length === 0,
  });

  if (projects.isPending) {
    return (
      <PageContainer maxWidth="xl">
        <SkeletonRows rows={4} className="*:h-24" />
      </PageContainer>
    );
  }

  if (projects.isError) {
    return (
      <PageContainer maxWidth="xl">
        <ErrorView error={projects.error} title="Could not load projects" />
      </PageContainer>
    );
  }

  const live = projects.data.filter((project) => project.archivedAt === null);
  const archived = projects.data.filter((project) => project.archivedAt !== null);
  const shown = showArchived ? projects.data : live;

  /* Design Bible §14's own first-run mockup: "Welcome to {org}" and "Three
     steps to get your team moving.", not the ordinary "Projects" heading —
     a brand-new org's owner is not yet asking "what does a project own",
     they are asking "what do I do first", and the getting-started panel
     below answers exactly that. Swapped only for as long as that panel is
     the thing actually showing (the identical condition it renders under),
     so the page reverts to its ordinary identity the moment there is a real
     project list to show instead. */
  const showingGettingStarted = live.length === 0 && !showArchived && !creating && canCreateProject;

  return (
    <PageContainer maxWidth="xl" className="flex flex-col gap-6">
      {/* Hidden rather than disabled: a create form nobody without
          project:create could submit is clutter, and the list below stays
          fully visible either way. */}
      <PageHeader
        title={
          showingGettingStarted
            ? `Welcome to ${orgDetail.data?.name ?? 'your organization'}`
            : 'Projects'
        }
        description={
          showingGettingStarted
            ? 'Three steps to get your team moving.'
            : 'A project owns its boards, labels, statuses and card numbering.'
        }
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

      {live.length === 0 && !showArchived && !creating ? (
        showingGettingStarted ? (
          <GettingStartedPanel
            memberCount={members.data?.length}
            onStart={() => {
              setCreating(true);
            }}
          />
        ) : (
          <Empty
            icon={<FolderKanban aria-hidden="true" className="size-5" strokeWidth={1.75} />}
            title="No projects yet"
            description="A project holds boards, labels and fields. Create one to get started."
          />
        )
      ) : (
        <ul className="space-y-3">
          {shown.map((project) => (
            <ProjectCard
              key={project.projectId}
              orgId={orgId}
              project={project}
              showArchived={showArchived}
              canDuplicate={canCreateProject}
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
    </PageContainer>
  );
}

/**
 * Design Bible §14's own "first run" thesis — a bare "No projects yet" empty
 * state is the least useful thing a brand-new org's owner can see, since it
 * names nothing about what to do next beyond the button already above it.
 * The bible's own checklist has FOUR steps (org, first project, invite a
 * teammate, add a card); this ships three. "Add a card to your board" is
 * deliberately NOT included — there is no cheap, already-fetched, org-wide
 * "does any card exist yet" signal to check it against (every existing
 * card query is board- or project-scoped), and inventing a new cross-org
 * existence check purely for one checklist row's checkmark is more surface
 * than this pass should add for it. Fabricating a checkmark this app
 * cannot actually verify would be worse than leaving the row out.
 *
 * "Let the assistant set it up," the mockup's second CTA, is ALSO
 * deliberately not offered here: there is no `project_create` tool in the
 * AI registry (`apps/api/src/ai/tools/index.ts`) — the assistant can create
 * a CARD, a sprint, a Docs page, but not a project — so a button offering
 * that would hand someone a dead end the model would have to decline. This
 * is the identical "the model can only do what a tool in its list lets it
 * do" discipline `assistant-page.tsx`'s own system-prompt rules already
 * state; the UI-level analogue is not offering the button at all.
 *
 * Step 1 ("Create your organization") always renders done — reaching this
 * page at all already proves it, the same reasoning the mockup's own
 * screenshot gives ("you're the owner"). Step 3 ("Invite a teammate")
 * reads real membership data (`membersQuery`, already used identically on
 * `settings-page.tsx`): done once the org has more than the one member who
 * created it. Its own CTA links to `/settings` rather than a specific tab —
 * `SettingsPage`'s section switcher is local `useState`, not a URL param
 * (that file's own header explains why), so there is no deep link into the
 * Members section to offer.
 */
function GettingStartedPanel({
  memberCount,
  onStart,
}: {
  readonly memberCount: number | undefined;
  readonly onStart: () => void;
}) {
  const invited = memberCount !== undefined && memberCount > 1;

  return (
    <div className="rounded-xl border border-line/50 bg-surface-raised p-5">
      <h2 className="text-sm font-semibold text-ink">Getting started</h2>
      <p className="mt-0.5 text-xs text-ink-muted">A few steps to get your team moving.</p>

      <ul className="mt-4 divide-y divide-line/50">
        <ChecklistRow label="Create your organization" done />
        <ChecklistRow label="Create your first project" onAct={onStart} actLabel="Start" />
        <ChecklistRow
          label="Invite a teammate"
          done={invited}
          {...(invited ? {} : { to: '/settings' as const, actLabel: 'Settings' })}
        />
      </ul>
    </div>
  );
}

function ChecklistRow({
  label,
  done = false,
  onAct,
  to,
  actLabel,
}: {
  readonly label: string;
  readonly done?: boolean;
  readonly onAct?: () => void;
  readonly to?: '/settings';
  readonly actLabel?: string;
}) {
  return (
    <li className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          done ? 'border-success bg-success/15 text-success' : 'border-line text-transparent',
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
      <span className={cn('flex-1 text-sm', done ? 'text-ink-faint line-through' : 'text-ink')}>
        {label}
      </span>
      {!done && onAct !== undefined && (
        <button
          type="button"
          onClick={onAct}
          className="text-xs font-medium text-accent hover:underline"
        >
          {actLabel} →
        </button>
      )}
      {!done && to !== undefined && (
        <Link to={to} className="text-xs font-medium text-accent hover:underline">
          {actLabel} →
        </Link>
      )}
    </li>
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

  return (
    <li
      className={cardClass(isArchived)}
      // Archived projects stay legible rather than being dimmed into
      // unreadability: they are restorable, so they have to be readable enough
      // to decide whether to restore them.
    >
      <div className="flex items-center gap-2">
        <span className="rounded bg-surface-hover px-1.5 py-0.5 font-mono text-xs font-medium text-ink-muted">
          {project.key}
        </span>
        <h2 className="truncate text-sm font-medium text-ink">{project.name}</h2>
        {isArchived && <Badge tone="warning">archived</Badge>}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Not offered on an archived project: duplicating one would create a
              live copy of something somebody deliberately put away, and the
              first question would be why it came back. */}
          {!isArchived && canDuplicate && (
            <button
              type="button"
              onClick={() => {
                setDuplicating((open) => !open);
              }}
              className="rounded-md border border-line/60 px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-surface-hover hover:text-ink"
            >
              Duplicate
            </button>
          )}
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.projectId as ProjectId }}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            Settings
          </Link>
        </div>
      </div>

      {duplicating && (
        <DuplicateProjectForm
          orgId={orgId}
          projectId={project.projectId as ProjectId}
          sourceName={project.name}
          onDone={() => {
            setDuplicating(false);
          }}
        />
      )}

      {project.description !== null && project.description !== '' && (
        <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{project.description}</p>
      )}

      <BoardList
        orgId={orgId}
        projectId={project.projectId as ProjectId}
        showArchived={showArchived}
        canCreateBoard={project.capabilities.update}
      />
    </li>
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
      /* The list gained a project, and each project row lazily loads its own
         boards — invalidating the projects query is what makes the copy
         appear without a reload. */
      await queryClient.invalidateQueries({ queryKey: keys.projects(orgId) });
      onDone();
    },
  });

  return (
    <form
      className="mt-2 space-y-2 rounded border border-line bg-surface-sunken/60 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        duplicate.mutate();
      }}
    >
      {/* Ids carry the project id: several of these forms can be open at once
          on this page, and duplicated ids would make every label point at the
          first card's inputs. */}
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
        <span className="text-[11px] text-ink-muted">
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

function cardClass(isArchived: boolean): string {
  return isArchived
    ? 'rounded-xl border border-dashed border-line/40 bg-surface-sunken/30 p-5'
    : 'rounded-xl border border-line/50 bg-surface-raised p-5 transition-all duration-[var(--motion-base)] hover:border-line-strong hover:bg-surface-hover hover:shadow-sm';
}

function BoardList({
  orgId,
  projectId,
  showArchived,
  canCreateBoard,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly showArchived: boolean;
  /** project:update on THIS project — createBoard enforces it on the parent, not board:create. */
  readonly canCreateBoard: boolean;
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
    <div className="mt-3 border-t border-line/50 pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {live.map((board) => (
          <Link
            key={board.boardId}
            to="/boards/$boardId"
            params={{ boardId: board.boardId as BoardId }}
            search={{ view: 'board', project: projectId }}
            className="rounded-lg border border-line/50 bg-surface px-2.5 py-1.5 text-xs font-medium text-ink transition-colors duration-[var(--motion-fast)] hover:border-accent/40 hover:bg-surface-hover"
          >
            {board.name}
          </Link>
        ))}

        {live.length === 0 && !adding && (
          <span className="text-xs text-ink-faint">
            No boards yet — a project without one has nowhere to put cards.
          </span>
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
              className="rounded-lg border border-dashed border-line/50 px-2.5 py-1 text-xs text-ink-faint hover:border-line hover:bg-surface-hover hover:text-ink"
            >
              + Board
            </button>
          ))}

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
        <Input
          id="project-name"
          placeholder="Web Platform"
          {...register('name', { required: true })}
        />
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
