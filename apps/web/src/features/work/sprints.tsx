import { useState } from 'react';
import { ModalClose, ModalContent, ModalDescription, ModalRoot, ModalTitle } from '@taskflow/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, ProjectId, SprintId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useToast } from '../../lib/toast-context.js';
import { Button, ConfirmButton, Input } from '../../components/primitives.js';
import { ErrorText } from '../../components/error-view.js';
import { sprintsQuery, type Sprint } from './api.js';
import type { SprintFilter } from './sprint-filter.js';

/**
 * The sprint dimension on the board (`ai/phase-10.5-sprints.md`).
 *
 * A sprint board is the SAME board, filtered — the picker writes a `sprint=`
 * URL param and the renderer filters the one card query the board already
 * fetches, so switching between All, the backlog and a sprint is instant and
 * the two can never disagree. The backlog is NOT a row (decision 4), so the
 * filter names it literally alongside real sprint ids.
 *
 * The picker is the same control that opens the sprints manager panel — one
 * surface, one vocabulary, matching how statuses are managed. Every control in
 * the manager is rendered for everyone and the server answers (§8.2): a member
 * without `project:update` gets an honest FORBIDDEN toast, never a hidden
 * button.
 *
 * The filter itself lives in `sprint-filter.ts` — NOT here — because a
 * component file with a function export cannot fast-refresh.
 */

export interface SprintPickerProps {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly boardId: BoardId;
  readonly value: SprintFilter;
  readonly onChange: (value: SprintFilter) => void;
}

export function SprintPicker({ orgId, projectId, boardId, value, onChange }: SprintPickerProps) {
  const sprints = useQuery(sprintsQuery(orgId, projectId));
  const [managing, setManaging] = useState(false);

  return (
    <div className="flex items-center gap-1.5 text-xs text-ink-muted">
      <label className="flex items-center gap-1.5">
        Sprint
        <select
          aria-label="Sprint"
          value={value ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === '' ? null : next === 'backlog' ? 'backlog' : (next as SprintId));
          }}
          className="h-7 max-w-48 rounded border border-line bg-surface-sunken px-1.5 text-xs text-ink"
        >
          <option value="">All</option>
          <option value="backlog">Backlog</option>
          {(sprints.data ?? []).map((sprint) => (
            <option key={sprint.sprintId} value={sprint.sprintId}>
              {sprintLabel(sprint)}
            </option>
          ))}
        </select>
      </label>

      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setManaging(true);
        }}
      >
        Manage
      </Button>

      {managing && (
        <SprintsManagerDialog
          orgId={orgId}
          projectId={projectId}
          boardId={boardId}
          onClose={() => {
            setManaging(false);
          }}
        />
      )}
    </div>
  );
}

/** One option's text — name, dates, status marker, and its live card count. */
function sprintLabel(sprint: Sprint): string {
  const status =
    sprint.status === 'active'
      ? ' (active)'
      : sprint.status === 'completed' || sprint.status === 'cancelled'
        ? ' (closed)'
        : '';
  return `${sprint.name} · ${sprint.startsOn}–${sprint.endsOn}${status} · ${String(sprint.cardCount)}`;
}

/** Today (plus an offset), as the `YYYY-MM-DD` the date inputs and the Day schema both use. */
function today(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return String(now.getFullYear()) + '-' + month + '-' + day;
}

const STATUS_LABEL: Readonly<Record<Sprint['status'], string>> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Readonly<Record<Sprint['status'], string>> = {
  planned: 'text-ink-faint',
  active: 'text-emerald-600',
  completed: 'text-blue-600',
  cancelled: 'text-danger',
};

interface SprintDraft {
  readonly name: string;
  readonly goal: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

function blankDraft(): SprintDraft {
  /* A sprint that starts and ends today is almost never what was meant — the
     default window is two weeks, matching how sprints are actually planned. */
  return { name: '', goal: '', startsOn: today(), endsOn: today(14) };
}

/**
 * The sprints manager panel — create, edit dates, start, complete, cancel.
 *
 * Opened from the picker, like the status vocabulary lives beside where it is
 * picked. The lifecycle buttons are the server's transitions with the labels
 * the service guards state against: Start on a planned sprint, Complete on the
 * active one, Cancel from either, Edit on a planned sprint (or the goal of an
 * active one — the service refuses the locked fields, and the form disables
 * them so the refusal is never a surprise).
 */
export function SprintsManagerDialog({
  orgId,
  projectId,
  boardId,
  onClose,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly boardId: BoardId;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const sprints = useQuery(sprintsQuery(orgId, projectId));

  const [draft, setDraft] = useState<SprintDraft>(blankDraft);
  const [editing, setEditing] = useState<SprintId | null>(null);
  const [editDraft, setEditDraft] = useState<SprintDraft>(blankDraft);
  /* Which sprint the close dialog is open for (10.6 D1). A ConfirmButton was
     enough while the close had one outcome; choosing a destination is a real
     decision that needs the counts in front of it, so it gets a panel. */
  const [closing, setClosing] = useState<SprintId | null>(null);

  const refreshSprints = () =>
    queryClient.invalidateQueries({ queryKey: keys.sprints(orgId, projectId) });

  /* Completing or cancelling a sprint RELEASES cards — their `sprint_id`
     changes in bulk, so every board card list, My Tasks, and the card-detail
     family have to see the real rows, not the pre-close cache. The detail
     family matters because an open panel can sit behind this modal: without
     it, the Sprint field keeps showing the old sprint after the close. Cards
     on OTHER boards of the same project can be in the sprint too (assignment
     is card-level, project-wide); their caches are not invalidated here
     because a board remounts with a refetch anyway — the one board rendered
     at a time self-heals, and this call stays scoped to what the close
     provably touched on screen. */
  const refreshReleasedCards = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) });
    await queryClient.invalidateQueries({ queryKey: keys.myCards(orgId) });
    await queryClient.invalidateQueries({ queryKey: ['org', orgId, 'card'] });
  };

  const create = useMutation({
    mutationFn: (input: SprintDraft) =>
      api.work.sprints.create.mutate({
        projectId,
        name: input.name.trim(),
        goal: input.goal.trim() === '' ? null : input.goal.trim(),
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      }),
    onSuccess: async () => {
      setDraft(blankDraft());
      await refreshSprints();
    },
    onError: (error) => {
      toast.failure('The sprint was not created', error);
    },
  });

  const update = useMutation({
    mutationFn: (input: SprintDraft & { readonly sprintId: SprintId }) =>
      api.work.sprints.update.mutate({
        sprintId: input.sprintId,
        name: input.name.trim(),
        goal: input.goal.trim() === '' ? null : input.goal.trim(),
        startsOn: input.startsOn,
        endsOn: input.endsOn,
      }),
    onSuccess: async () => {
      setEditing(null);
      await refreshSprints();
    },
    onError: (error) => {
      toast.failure('The sprint was not saved', error);
    },
  });

  const start = useMutation({
    mutationFn: (sprintId: SprintId) => api.work.sprints.start.mutate({ sprintId }),
    onSuccess: refreshSprints,
    onError: (error) => {
      toast.failure('The sprint could not be started', error);
    },
  });

  const complete = useMutation({
    mutationFn: (input: { sprintId: SprintId; moveUnfinishedTo: SprintId | null }) =>
      api.work.sprints.complete.mutate(input),
    onSuccess: async (result) => {
      setClosing(null);
      await refreshSprints();
      await refreshReleasedCards();
      /* The counts are the only record of what the close DID, and they are
         gone from the screen the moment the list refreshes — so they are said
         out loud rather than left to be inferred from a shorter board. */
      toast.show('Sprint completed', {
        description:
          result.releasedCount === 0
            ? `${String(result.shippedCount)} shipped, nothing left over.`
            : `${String(result.shippedCount)} shipped, ${String(result.releasedCount)} moved on.`,
      });
    },
    onError: (error) => {
      toast.failure('The sprint could not be completed', error);
    },
  });

  const cancel = useMutation({
    mutationFn: (sprintId: SprintId) => api.work.sprints.cancel.mutate({ sprintId }),
    onSuccess: async () => {
      await refreshSprints();
      await refreshReleasedCards();
    },
    onError: (error) => {
      toast.failure('The sprint could not be cancelled', error);
    },
  });

  const openEdit = (sprint: Sprint) => {
    setEditDraft({
      name: sprint.name,
      goal: sprint.goal ?? '',
      startsOn: sprint.startsOn,
      endsOn: sprint.endsOn,
    });
    setEditing(sprint.sprintId as SprintId);
  };

  return (
    <ModalRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ModalContent size="lg" className="flex max-h-[80vh] flex-col p-4">
        <ModalTitle>Sprints</ModalTitle>
        <ModalDescription>
          Plan the project's windows. One active sprint at a time; closed sprints stay as the record
          of what shipped.
        </ModalDescription>

        <div className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto">
          <form
            className="space-y-2 rounded border border-line p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.name.trim() !== '') create.mutate(draft);
            }}
          >
            <p className="text-[11px] font-medium text-ink-muted">New sprint</p>
            {/* Full-width rows rather than one crowded line: the single-row
                version squeezed the name field until its placeholder read
                "Sprin" and clipped the goal — the modal is not that short. */}
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                aria-label="New sprint name"
                placeholder="Sprint name"
                value={draft.name}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, name: event.target.value }));
                }}
                className="h-8 w-full text-xs"
              />
              <Input
                aria-label="New sprint goal"
                placeholder="Goal (optional)"
                value={draft.goal}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, goal: event.target.value }));
                }}
                className="h-8 w-full text-xs"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-ink-muted">
                <input
                  type="date"
                  aria-label="Starts"
                  value={draft.startsOn}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, startsOn: event.target.value }));
                  }}
                  className="h-8 rounded border border-line bg-surface px-1.5 text-xs text-ink"
                />
                →
                <input
                  type="date"
                  aria-label="Ends"
                  value={draft.endsOn}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, endsOn: event.target.value }));
                  }}
                  className="h-8 rounded border border-line bg-surface px-1.5 text-xs text-ink"
                />
              </label>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                disabled={create.isPending || draft.name.trim() === ''}
                className="ml-auto"
              >
                Add sprint
              </Button>
            </div>
            {create.isError && <ErrorText error={create.error} />}
          </form>

          {sprints.isPending && <p className="p-2 text-xs text-ink-faint">Loading…</p>}

          {(sprints.data ?? []).length === 0 ? (
            <p className="rounded border border-line p-3 text-xs text-ink-faint">
              No sprints yet. Plan the first window above — cards join it from the card panel's
              Sprint field.
            </p>
          ) : (
            <ul className="divide-y divide-line rounded border border-line">
              {/* Each row is a BLOCK, not a flex row: its own contents are
                  flexed by the wrapper inside, so the close panel can sit
                  underneath at full width. As a direct child of a flex `li`
                  the panel became a third column, squeezing the sprint name
                  and truncating the dates. */}
              {(sprints.data ?? []).map((sprint) => (
                <li key={sprint.sprintId} className="px-3 py-2">
                  {editing === sprint.sprintId ? (
                    <EditSprintForm
                      sprint={sprint}
                      draft={editDraft}
                      onDraftChange={setEditDraft}
                      onSave={(input) => {
                        update.mutate({ ...input, sprintId: sprint.sprintId as SprintId });
                      }}
                      onCancel={() => {
                        setEditing(null);
                      }}
                    />
                  ) : (
                    <>
                      <div className="flex items-center gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-xs font-medium text-ink">
                              {sprint.name}
                            </span>
                            <span
                              className={`text-[10px] uppercase ${STATUS_COLOR[sprint.status]}`}
                            >
                              {STATUS_LABEL[sprint.status]}
                            </span>
                          </div>
                          <p className="truncate text-[11px] text-ink-faint">
                            {sprint.startsOn} → {sprint.endsOn} · {sprint.cardCount}{' '}
                            {sprint.cardCount === 1 ? 'card' : 'cards'}
                            {sprint.goal !== null && ` · ${sprint.goal}`}
                          </p>
                        </div>

                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          {sprint.status === 'planned' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={start.isPending}
                              onClick={() => {
                                start.mutate(sprint.sprintId as SprintId);
                              }}
                            >
                              Start
                            </Button>
                          )}
                          {sprint.status === 'active' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={complete.isPending}
                              onClick={() => {
                                setClosing(sprint.sprintId as SprintId);
                              }}
                            >
                              Complete
                            </Button>
                          )}
                          {(sprint.status === 'planned' || sprint.status === 'active') && (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  openEdit(sprint);
                                }}
                              >
                                Edit
                              </Button>
                              <ConfirmButton
                                label="Cancel"
                                confirmLabel="Cancel sprint"
                                disabled={cancel.isPending}
                                onConfirm={() => {
                                  cancel.mutate(sprint.sprintId as SprintId);
                                }}
                              />
                            </>
                          )}
                        </div>
                      </div>

                      {closing === sprint.sprintId && (
                        <CloseSprintPanel
                          sprint={sprint}
                          options={sprints.data ?? []}
                          pending={complete.isPending}
                          onCancel={() => {
                            setClosing(null);
                          }}
                          onConfirm={(moveUnfinishedTo) => {
                            complete.mutate({
                              sprintId: sprint.sprintId as SprintId,
                              moveUnfinishedTo,
                            });
                          }}
                        />
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3 flex justify-end border-t border-line pt-3">
          <ModalClose asChild>
            <Button size="sm" variant="ghost">
              Close
            </Button>
          </ModalClose>
        </div>
      </ModalContent>
    </ModalRoot>
  );
}

/**
 * The inline edit form for one sprint.
 *
 * An ACTIVE sprint may change only its goal — the dates are the contract the
 * burndown reads and the name is how the team refers to it mid-flight — so the
 * locked fields are disabled rather than shown as editable-then-refused. That
 * is a model rule, not an authorization call: the server still answers for
 * every field, this just keeps the refusal from being a surprise.
 */
/**
 * Where the unfinished work goes (ai/phase-10.6-sprint-flow.md D1).
 *
 * Phase 10.5 closed a sprint with a two-click confirm because there was one
 * outcome: everything unfinished went to the backlog. That is still the
 * default — and still the right default, since 10.5 decision 5's argument
 * holds that rolling work over SILENTLY is how a sprint accumulates two
 * sprints' worth of work. What was missing is that a team running
 * back-to-back sprints then re-drags the same cards every fortnight.
 *
 * So the destination is a choice, made once, with the counts visible. The
 * count is what makes it a decision rather than a reflex: "12 unfinished"
 * reads very differently from "1 unfinished", and the old confirm showed
 * neither.
 *
 * Only `planned` and `active` sprints are offered — the service refuses a
 * closed one, and offering it here would be a control that exists to be
 * rejected.
 */
function CloseSprintPanel({
  sprint,
  options,
  pending,
  onCancel,
  onConfirm,
}: {
  readonly sprint: Sprint;
  readonly options: readonly Sprint[];
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (moveUnfinishedTo: SprintId | null) => void;
}) {
  const [target, setTarget] = useState<string>('');

  const destinations = options.filter(
    (option) =>
      option.sprintId !== sprint.sprintId &&
      (option.status === 'planned' || option.status === 'active'),
  );

  return (
    <div className="mt-2 rounded border border-line bg-surface-sunken/60 p-3">
      <p className="text-xs font-medium text-ink">Complete {sprint.name}</p>
      <p className="mt-0.5 text-[11px] text-ink-faint">
        {sprint.cardCount} {sprint.cardCount === 1 ? 'card' : 'cards'} attached. Cards in a done
        status stay with this sprint as its shipped record; the rest move where you choose.
      </p>

      <label className="mt-2 block">
        <span className="text-[11px] font-medium text-ink-muted">Move unfinished cards to</span>
        <select
          value={target}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
          className="mt-0.5 h-8 w-full rounded border border-line bg-surface px-2 text-xs text-ink"
        >
          <option value="">Backlog</option>
          {destinations.map((option) => (
            <option key={option.sprintId} value={option.sprintId}>
              {option.name}
              {option.status === 'active' ? ' (active)' : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-2 flex justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={pending}
          onClick={() => {
            onConfirm(target === '' ? null : (target as SprintId));
          }}
        >
          Complete sprint
        </Button>
      </div>
    </div>
  );
}

function EditSprintForm({
  sprint,
  draft,
  onDraftChange,
  onSave,
  onCancel,
}: {
  readonly sprint: Sprint;
  readonly draft: SprintDraft;
  readonly onDraftChange: (draft: SprintDraft) => void;
  readonly onSave: (input: SprintDraft) => void;
  readonly onCancel: () => void;
}) {
  const locked = sprint.status === 'active';
  const datesLocked = locked || sprint.status !== 'planned';

  return (
    <form
      className="flex flex-1 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.name.trim() !== '') onSave(draft);
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          aria-label="Sprint name"
          value={draft.name}
          disabled={locked}
          onChange={(event) => {
            onDraftChange({ ...draft, name: event.target.value });
          }}
          className="h-7 w-full text-xs"
        />
        <Input
          aria-label="Sprint goal"
          value={draft.goal}
          onChange={(event) => {
            onDraftChange({ ...draft, goal: event.target.value });
          }}
          className="h-7 w-full text-xs"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="date"
          aria-label="Starts"
          value={draft.startsOn}
          disabled={datesLocked}
          onChange={(event) => {
            onDraftChange({ ...draft, startsOn: event.target.value });
          }}
          className="h-7 rounded border border-line bg-surface px-1.5 text-xs text-ink disabled:opacity-50"
        />
        <input
          type="date"
          aria-label="Ends"
          value={draft.endsOn}
          disabled={datesLocked}
          onChange={(event) => {
            onDraftChange({ ...draft, endsOn: event.target.value });
          }}
          className="h-7 rounded border border-line bg-surface px-1.5 text-xs text-ink disabled:opacity-50"
        />
        <span className="text-[11px] text-ink-faint">
          {locked ? 'Active: only the goal is editable.' : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button type="submit" size="sm" variant="primary" disabled={draft.name.trim() === ''}>
            Save
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}
