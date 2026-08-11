import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FilterNode } from '@taskflow/filter';
import { useSession } from '../../lib/session.js';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { cn } from '../../lib/cn.js';
import { formatRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import type { Wire } from '../../lib/wire.js';
import { Button, Empty, Field, SkeletonRows } from '../../components/primitives.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { FilterBuilder } from '../work/filter/filter-builder.js';
import { automationRunsQuery, automationsQuery } from './api.js';
import {
  ACTION_LABELS,
  ARGUMENT_KEYS,
  TRIGGER_OPTIONS,
  type ActionDraft,
  blankAction,
  describeAction,
} from './vocabulary.js';

/** The trigger's human label, falling back to its event name for one this build does not offer. */
function triggerLabel(event: string): string {
  return TRIGGER_OPTIONS.find((option) => option.event === event)?.label ?? event;
}

/**
 * Turns a rule's stored actions back into editable drafts.
 *
 * The stored value is jsonb off the wire, so every field is narrowed rather
 * than trusted: a rule written by a NEWER build can name an action type this
 * one does not offer, and the editor must not crash on it.
 *
 * An unrecognized action degrades to a blank of the default type, which is a
 * DESTRUCTIVE fallback — saving would replace it. That is why the row for it
 * is not silently identical to a normal one; the trade is accepted because the
 * alternative is refusing to open the editor at all for a rule that is
 * otherwise fine, and a build that cannot show a rule also cannot fix it.
 */
function draftsFrom(stored: readonly unknown[] | undefined): ActionDraft[] {
  if (stored === undefined || stored.length === 0) return [blankAction()];

  return stored.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return blankAction();

    const record = entry as Record<string, unknown>;
    const type = typeof record['type'] === 'string' ? record['type'] : '';
    const key = ARGUMENT_KEYS[type];
    if (key === undefined) return blankAction();

    const draft = blankAction(type);
    const value = typeof record[key] === 'string' ? record[key] : '';

    return {
      key: draft.key,
      value: { ...draft.value, [key]: value },
    };
  });
}

/**
 * Automation rules (ai/phase-10-automation.md Wave 1).
 *
 * ## The condition editor is the board's filter builder, unchanged
 *
 * Not a similar one — the same component, editing the same `FilterNode` the
 * SQL compiler consumes and the engine's evaluator runs. That is the payoff of
 * PLAN.md §10.2's split finally arriving: a person who has built a board filter
 * already knows how to write an automation condition, and the TQL tab shipped
 * in Phase 8 Wave 3 means they can type it instead if they prefer.
 *
 * Wave 1 conditions are evaluated against the CARD, so the builder is used with
 * its card field set exactly as the board uses it. A condition naming a field
 * cards do not have is refused by the server while the author is still looking
 * at it.
 *
 * ## The UI never re-derives authorization
 *
 * There is no client-side check for `automation:manage`. The page renders, the
 * server answers, and a member who may not manage rules gets an honest
 * FORBIDDEN rendered in place — §8.2 is explicit that a UI reimplementing
 * `can()` produces two models that drift, and the one users see is the one
 * that is never tested.
 */

export function AutomationsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  /* Three separate pieces of state, deliberately. The first version folded
     "which rule's runs are open" and "which rule is being edited" into one
     `editing` field, which meant opening a rule's history and editing it were
     the same click and neither could be done without the other. */
  const [showingRuns, setShowingRuns] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const automations = useQuery({ ...automationsQuery(orgId), enabled: orgId !== '' });
  const editingRule = automations.data?.find((rule) => rule.automationId === editingRuleId);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto p-4 md:p-6">
      <header className="flex shrink-0 items-start justify-between gap-3">
        <div>
          <h1 className="text-sm font-semibold text-ink">Automations</h1>
          <p className="text-xs text-ink-faint">
            When something happens, check a condition, then act. Rules run with the permissions of
            whoever created them.
          </p>
        </div>
        {!creating && editingRule === undefined && (
          <Button
            size="sm"
            onClick={() => {
              setCreating(true);
              setEditingRuleId(null);
            }}
          >
            New rule
          </Button>
        )}
      </header>

      {creating && (
        <RuleEditor
          orgId={orgId}
          onDone={() => {
            setCreating(false);
          }}
        />
      )}

      {editingRule !== undefined && (
        /* `key` remounts the editor when a different rule is picked. Without
           it, React keeps the previous rule's form state — you would open rule
           B and be editing it with rule A's name and actions still in the
           fields, which is the shape of an edit that silently overwrites the
           wrong thing. */
        <RuleEditor
          key={editingRule.automationId}
          orgId={orgId}
          initial={editingRule}
          onDone={() => {
            setEditingRuleId(null);
          }}
        />
      )}

      <main className="min-h-0 flex-1">
        {automations.isPending ? (
          <SkeletonRows rows={3} />
        ) : automations.isError ? (
          <ErrorView error={automations.error} title="Could not load automations" />
        ) : automations.data.length === 0 ? (
          <Empty
            title="No automations yet"
            description="A rule watches for an event — a card entering Done, a comment being added — and then does something."
          />
        ) : (
          <ul className="space-y-2">
            {automations.data.map((rule) => (
              <li key={rule.automationId}>
                <RuleRow
                  orgId={orgId}
                  rule={rule}
                  expanded={showingRuns === rule.automationId}
                  onToggleExpanded={() => {
                    setShowingRuns(showingRuns === rule.automationId ? null : rule.automationId);
                  }}
                  onEdit={() => {
                    setEditingRuleId(rule.automationId);
                    setCreating(false);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

/**
 * One rule, as the wire actually delivers it.
 *
 * `Wire<…>`, not the bare tRPC return type. The two differ — `Wire` maps
 * `Date` to `string` and makes everything deeply readonly — and taking the
 * client's own type here compiled until the readonly mismatch surfaced,
 * which is precisely the drift `lib/wire.ts` exists to make visible rather
 * than let a component quietly disagree with the transport.
 */
type RuleSummary = Wire<Awaited<ReturnType<typeof api.automation.list.query>>>[number];

function RuleRow({
  orgId,
  rule,
  expanded,
  onToggleExpanded,
  onEdit,
}: {
  readonly orgId: string;
  readonly rule: RuleSummary;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.automations(orgId) });

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      api.automation.setEnabled.mutate({ automationId: rule.automationId, enabled }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: unknown) => {
      toast.failure('The rule could not be updated', error);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.automation.delete.mutate({ automationId: rule.automationId }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: unknown) => {
      toast.failure('The rule could not be deleted', error);
    },
  });

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2.5 bg-surface-raised px-3 py-2">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            rule.enabled ? 'bg-success' : 'bg-ink-faint',
          )}
        />
        <span className="sr-only">{rule.enabled ? 'Enabled' : 'Disabled'}</span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{rule.name}</p>
          {/* WHAT THE RULE DOES, not how many things it does. "3 actions" is a
              count of facts the reader came here to learn, and withholding
              them means opening the editor to answer "what does this rule
              even do". */}
          <p className="truncate text-[11px] text-ink-faint">
            <span className="text-ink-muted">{triggerLabel(rule.triggerEvent)}</span>
            {rule.condition !== null && ' · if a condition matches'} →{' '}
            {rule.actions.map((action) => describeAction(action)).join(', ')}
          </p>
        </div>

        {rule.conditionBroken && (
          <span
            className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"
            title="The stored condition no longer parses, so this rule is refused on every event"
          >
            Broken
          </span>
        )}

        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          disabled={setEnabled.isPending}
          onClick={() => {
            setEnabled.mutate(!rule.enabled);
          }}
        >
          {rule.enabled ? 'Disable' : 'Enable'}
        </Button>

        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={onEdit}>
          Edit
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          onClick={onToggleExpanded}
        >
          {expanded ? 'Hide runs' : 'Runs'}
        </Button>

        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px] text-danger"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>

      {expanded && <RunHistory orgId={orgId} automationId={rule.automationId} />}
      {(setEnabled.isError || remove.isError) && (
        <div className="border-t border-line px-3 py-2">
          <ErrorText error={setEnabled.error ?? remove.error} />
        </div>
      )}
    </div>
  );
}

/**
 * Run history for one rule (§3, §9 decision 8).
 *
 * Shows SKIPPED runs alongside successes, deliberately — "my rule did not
 * fire" is the question this screen exists to answer, and a list of successes
 * cannot tell "the engine never saw the event" apart from "it saw it and the
 * condition said no". The reason column is where that answer lives.
 */
function RunHistory({
  orgId,
  automationId,
}: {
  readonly orgId: string;
  readonly automationId: string;
}) {
  const runs = useQuery({ ...automationRunsQuery(orgId, automationId), enabled: orgId !== '' });

  if (runs.isPending) return <SkeletonRows rows={2} />;
  if (runs.isError) return <ErrorText error={runs.error} />;
  if (runs.data.length === 0) {
    return (
      <p className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
        This rule has not run yet. A run is recorded every time its trigger fires — including when
        the condition does not match.
      </p>
    );
  }

  return (
    <ul className="border-t border-line">
      {runs.data.map((run) => (
        <li key={run.runId} className="px-3 py-1.5 text-[11px]">
          <div className="flex items-center gap-2">
            <span
              className={cn('w-16 shrink-0 font-medium', STATUS_COLOR[run.status] ?? 'text-ink')}
            >
              {run.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-muted">
              {run.reason === null ? EXPLAIN_STATUS[run.status] : explainReason(run.reason)}
              {run.depth > 0 && ` · ${String(run.depth)} automation hop(s) deep`}
            </span>
            <span className="shrink-0 text-ink-faint">{formatRelative(run.createdAt)}</span>
          </div>

          {/* WHAT ACTUALLY HAPPENED, per action, in order. The engine records
              this precisely so a partially-applied rule is diagnosable — it
              stops at the first failure (§9 decision 6), so "action 2 failed"
              also means action 3 never ran, and showing only a count hides
              both facts. */}
          {run.actionResults.length > 0 && (
            <ol className="mt-0.5 ml-16 space-y-0.5">
              {run.actionResults.map((result, index) => (
                <ActionOutcome key={index} result={result} />
              ))}
            </ol>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One action's outcome, as the engine recorded it. */
function ActionOutcome({ result }: { readonly result: unknown }) {
  if (typeof result !== 'object' || result === null) return null;

  const record = result as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  const failed = record['status'] === 'failed';
  const error = typeof record['error'] === 'string' ? record['error'] : null;

  return (
    <li className="flex items-start gap-1.5">
      <span aria-hidden="true" className={failed ? 'text-danger' : 'text-success'}>
        {failed ? '✕' : '✓'}
      </span>
      <span className="sr-only">{failed ? 'Failed' : 'Succeeded'}:</span>
      <span className="min-w-0 flex-1 text-ink-faint">
        {ACTION_LABELS[type] ?? type}
        {error !== null && <span className="text-danger"> — {error}</span>}
      </span>
    </li>
  );
}

/**
 * The engine's refusal codes, in words.
 *
 * The stored `reason` is a stable machine code (`depth_exceeded`) because a run
 * row is data other things read. Showing it raw makes a person guess, and the
 * ones worth explaining are exactly the ones that look like the system is
 * broken when it is working as designed.
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  condition_not_met: 'the condition did not match, so nothing ran',
  rule_disabled: 'the rule was disabled',
  org_suspended: 'this organization is suspended',
  depth_exceeded: 'too many automations fired in a chain — stopped to prevent a loop',
  self_trigger: "this rule's own action would re-trigger it",
  budget_exhausted: 'this organization hit its hourly automation limit',
  unauthorized: 'the rule owner no longer has permission to do this',
  condition_unusable: 'the saved condition no longer parses — edit the rule to fix it',
  trigger_not_evaluable: 'this trigger has no card for the condition to check',
};

function explainReason(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

const EXPLAIN_STATUS: Readonly<Record<string, string>> = {
  succeeded: 'ran successfully',
  failed: 'an action failed',
  refused: 'refused',
  skipped: 'skipped',
};

const STATUS_COLOR: Readonly<Record<string, string>> = {
  succeeded: 'text-success',
  failed: 'text-danger',
  refused: 'text-warning',
  skipped: 'text-ink-faint',
};

/**
 * The rule builder.
 *
 * Trigger from a closed list, condition from the board's own filter builder,
 * actions from a closed list. There is no free-text field anywhere that becomes
 * behaviour — which is the UI half of §8's "a rule is data, never a script".
 */
function RuleEditor({
  orgId,
  initial,
  onDone,
}: {
  readonly orgId: string;
  /** Present when editing an existing rule; absent when creating one. */
  readonly initial?: RuleSummary;
  readonly onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const editing = initial !== undefined;

  /* Seeded from the rule ONCE, at mount. The page gives this component a `key`
     of the rule's id, so picking a different rule remounts it and re-seeds —
     which is what keeps someone from opening rule B and editing it with rule
     A's fields still filled in. */
  const [name, setName] = useState(initial?.name ?? '');
  const [triggerEvent, setTriggerEvent] = useState(
    initial?.triggerEvent ?? TRIGGER_OPTIONS[0]?.event ?? '',
  );
  const [condition, setCondition] = useState<FilterNode | null>(
    (initial?.condition as FilterNode | null | undefined) ?? null,
  );
  const [actions, setActions] = useState<ActionDraft[]>(() => draftsFrom(initial?.actions));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: null,
        triggerEvent,
        condition,
        actions: actions.map((action) => action.value) as never,
        /* Preserved, not reset. An edit must not silently re-enable a rule
           somebody deliberately turned off — the kill switch and the editor
           are separate controls and this is where they would collide. */
        enabled: initial?.enabled ?? true,
      };

      /* Normalized to void: `create` answers with an id and `update` with a
         name, neither of which this form uses — it re-reads the list either
         way. Returning the union would make the mutation's result type a
         choice nothing consumes. */
      return editing
        ? api.automation.update
            .mutate({ ...body, automationId: initial.automationId })
            .then(() => undefined)
        : api.automation.create.mutate(body).then(() => undefined);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.automations(orgId) });
      onDone();
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
      className="shrink-0 space-y-3 rounded-lg border border-line bg-surface-raised p-3"
    >
      <Field label="Name" htmlFor="automation-name">
        <input
          id="automation-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={120}
          placeholder="Notify the team when something ships"
          className="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
        />
      </Field>

      <Field label="When" htmlFor="automation-trigger">
        <select
          id="automation-trigger"
          value={triggerEvent}
          onChange={(event) => {
            setTriggerEvent(event.target.value);
          }}
          className="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
        >
          {TRIGGER_OPTIONS.map((option) => (
            <option key={option.event} value={option.event}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="If (optional)" htmlFor="automation-condition">
        {/* The board's builder, unchanged — same component, same AST, same
            validator. `projectId` is null because a rule is org-wide and not
            scoped to one project's vocabulary. */}
        <div id="automation-condition" className="flex items-center gap-2">
          <FilterBuilder orgId={orgId} projectId={null} value={condition} onChange={setCondition} />
          {condition === null && (
            <span className="text-[11px] text-ink-faint">Runs every time the trigger fires.</span>
          )}
        </div>
      </Field>

      <Field label="Then" htmlFor="automation-actions">
        <div id="automation-actions" className="space-y-2">
          {actions.map((action, index) => (
            <ActionRow
              key={action.key}
              action={action}
              onChange={(next) => {
                setActions(actions.map((item, i) => (i === index ? next : item)));
              }}
              /* Conditional SPREAD, not a ternary yielding undefined:
                 `exactOptionalPropertyTypes` treats "absent" and "present and
                 undefined" as different types, and the last action must not be
                 removable — a rule with zero actions is refused by the
                 database's own CHECK. */
              {...(actions.length > 1
                ? {
                    onRemove: () => {
                      setActions(actions.filter((_, i) => i !== index));
                    },
                  }
                : {})}
            />
          ))}
          {actions.length < 10 && (
            <button
              type="button"
              onClick={() => {
                setActions([...actions, blankAction()]);
              }}
              className="rounded border border-dashed border-line px-2 py-0.5 text-xs text-ink-faint hover:border-accent hover:text-accent"
            >
              + Add action
            </button>
          )}
        </div>
      </Field>

      {save.isError && <ErrorText error={save.error} />}

      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Button type="submit" size="sm" disabled={name.trim() === '' || save.isPending}>
          {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
        </Button>
        <button type="button" onClick={onDone} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ActionRow({
  action,
  onChange,
  onRemove,
}: {
  readonly action: ActionDraft;
  readonly onChange: (next: ActionDraft) => void;
  readonly onRemove?: () => void;
}) {
  const label = ACTION_LABELS[action.value.type];

  return (
    <div className="flex items-center gap-2">
      <select
        value={action.value.type}
        onChange={(event) => {
          onChange(blankAction(event.target.value, action.key));
        }}
        aria-label="Action"
        className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
      >
        {Object.entries(ACTION_LABELS).map(([type, text]) => (
          <option key={type} value={type}>
            {text}
          </option>
        ))}
      </select>

      <input
        value={argumentOf(action)}
        onChange={(event) => {
          onChange(withArgument(action, event.target.value));
        }}
        aria-label={`${label ?? action.value.type} value`}
        placeholder={PLACEHOLDER[action.value.type]}
        className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
      />

      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove action"
          className="text-xs text-ink-faint hover:text-danger"
        >
          ×
        </button>
      )}
    </div>
  );
}

const PLACEHOLDER: Readonly<Record<string, string>> = {
  'card.move': 'list id',
  'card.set_status': 'status id',
  'card.set_priority': 'urgent | high | normal | low',
  'card.assign': 'user id',
  'card.add_label': 'label id',
  'chat.post_message': 'channel id',
};

/** The single editable argument of an action draft. */
function argumentOf(action: ActionDraft): string {
  const value = action.value as Record<string, string>;
  const key = ARGUMENT_KEY[action.value.type];
  return key === undefined ? '' : (value[key] ?? '');
}

function withArgument(action: ActionDraft, next: string): ActionDraft {
  const key = ARGUMENT_KEY[action.value.type];
  if (key === undefined) return action;
  return { key: action.key, value: { ...action.value, [key]: next } };
}

const ARGUMENT_KEY: Readonly<Record<string, string>> = {
  'card.move': 'listId',
  'card.set_status': 'statusId',
  'card.set_priority': 'priority',
  'card.assign': 'userId',
  'card.add_label': 'labelId',
  'chat.post_message': 'channelId',
};
