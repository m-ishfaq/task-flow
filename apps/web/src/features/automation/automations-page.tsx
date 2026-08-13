import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { resourceForTrigger, type FilterNode } from '@taskflow/filter';
import type { ProjectId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { cn } from '../../lib/cn.js';
import { formatRelative } from '../../lib/format.js';
import { useToast } from '../../lib/toast-context.js';
import type { Wire } from '../../lib/wire.js';
import { Button, ConfirmButton, Empty, Field, SkeletonRows } from '../../components/primitives.js';
import { SecretReveal } from '../../components/secret-reveal.js';
import { ErrorText, ErrorView } from '../../components/error-view.js';
import { FilterBuilder } from '../work/filter/filter-builder.js';
import {
  apiTokensQuery,
  automationCapabilitiesQuery,
  automationRunsQuery,
  automationsQuery,
  integrationsQuery,
  webhookDeliveriesQuery,
  webhooksQuery,
} from './api.js';
import { ApiTokensSection } from './api-tokens-section.js';
import { IntegrationsSection } from './integrations-section.js';
import {
  ACTION_LABELS,
  ARGUMENTS,
  TELEPHONY_ACTIONS,
  TRIGGER_OPTIONS,
  type ActionDraft,
  blankAction,
  describeAction,
  needsProject,
  offeredActions,
} from './vocabulary.js';
import { ArgumentPicker, ProjectScopePicker } from './action-pickers.js';

/** The trigger's human label, falling back to its event name for one this build does not offer. */
function triggerLabel(event: string): string {
  return TRIGGER_OPTIONS.find((option) => option.event === event)?.label ?? event;
}

/**
 * True when every argument of every action has a value — the server refuses
 * anything less (a list id must be a real uuid, a message body non-empty), and
 * "why won't it save" is worse when it only surfaces as a server error after
 * the author has moved on. The Save button is disabled until this passes, and
 * a one-line hint says which half of the form is incomplete.
 */
function actionsComplete(actions: readonly ActionDraft[]): boolean {
  return actions.every((action) =>
    (ARGUMENTS[action.value.type] ?? []).every((spec) => {
      if (spec.optional === true) return true;
      const value = (action.value as unknown as Record<string, string>)[spec.field];
      return typeof value === 'string' && value.trim() !== '';
    }),
  );
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
    const specs = ARGUMENTS[type];
    if (specs === undefined) return blankAction();

    const draft = blankAction(type);

    /* EVERY argument, not just the first. The version before this restored
       only `specs[0]`, which meant opening a `chat.post_message` rule for
       editing silently dropped its message body — and saving would then have
       written the rule back with an empty one. The single-argument assumption
       kept finding new ways to be wrong. */
    const restored = specs.reduce<Record<string, unknown>>(
      (value, spec) => ({
        ...value,
        [spec.field]: typeof record[spec.field] === 'string' ? record[spec.field] : '',
      }),
      { ...draft.value },
    );

    return { key: draft.key, value: restored as ActionDraft['value'] };
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

/* The tab ids, single-sourced: the ROUTE's search schema imports this same
   const (`z.enum(AUTOMATION_TAB_IDS)` in router.tsx), so adding a tab here
   and forgetting the route is a compile error instead of a tab that cannot
   open. The first version duplicated the enum in the route's validateSearch
   and the page grew a third tab the router never heard of — clicking it
   navigated to `?tab=apiTokens`, the validator refused it, and nothing
   happened. */
export const AUTOMATION_TAB_IDS = ['rules', 'webhooks', 'apiTokens', 'integrations'] as const;
export type AutomationTabId = (typeof AUTOMATION_TAB_IDS)[number];

const TABS = [
  { id: 'rules', label: 'Rules' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'apiTokens', label: 'API tokens' },
  { id: 'integrations', label: 'Integrations' },
] as const;

type TabId = AutomationTabId;

/**
 * ## Two tabs, where there used to be two stacked sections
 *
 * The stacked version had the rules list in a `flex-1` `<main>` with the
 * webhook registry after it, which on any screen taller than the rule list
 * pushed the registry to the very bottom of the viewport behind a void the
 * height of the window. The registry was not findable by scrolling — there was
 * nothing to scroll — and not visible without one, so it read as an empty page
 * with something stranded at the foot of it.
 *
 * The earlier argument for sections over tabs was that a rule and the endpoint
 * it calls are one surface, and `call_webhook` is meaningless until an endpoint
 * exists to pick. That concern is real and is answered directly rather than by
 * co-location: the tab carries a COUNT, so "you have no webhooks" is legible
 * from the Rules tab without leaving it, and the action picker's own empty
 * state already says "create one on the Webhooks tab" — a sentence that was
 * describing a tab this page did not have.
 */
export function AutomationsPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const tab: TabId = useSearch({ from: '/automations', select: (value) => value.tab }) ?? 'rules';

  const automations = useQuery({ ...automationsQuery(orgId), enabled: orgId !== '' });
  const webhooks = useQuery({ ...webhooksQuery(orgId), enabled: orgId !== '' });
  const apiTokens = useQuery({ ...apiTokensQuery(orgId), enabled: orgId !== '' });
  const integrations = useQuery({ ...integrationsQuery(orgId), enabled: orgId !== '' });

  const counts: Readonly<Record<TabId, number | undefined>> = {
    rules: automations.data?.length,
    webhooks: webhooks.data?.length,
    apiTokens: apiTokens.data?.length,
    /* Connected rows only — a disconnected row is a past authorization, not
       something the tab's badge should claim exists today. */
    integrations: integrations.data?.filter((row) => row.status === 'connected').length,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line px-4 pt-4 pb-2 md:px-6">
        <h1 className="text-base font-semibold text-ink">Automations</h1>
        <p className="mt-0.5 text-xs text-ink-muted">
          When something happens, check a condition, then act. Rules run with the permissions of
          whoever created them.
        </p>

        <nav aria-label="Automation sections" className="mt-3 flex gap-1">
          {TABS.map((item) => {
            const count = counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                aria-current={tab === item.id ? 'page' : undefined}
                onClick={() => {
                  void navigate({ to: '/automations', search: { tab: item.id } });
                }}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  tab === item.id
                    ? 'bg-accent text-accent-ink shadow-sm'
                    : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                )}
              >
                {item.label}
                {/* Deliberately rendered only once the query has settled. A
                    zero that is really "still loading" is the one number worth
                    not guessing at here — it is the difference between "you
                    have no webhooks" and "we have not asked yet". */}
                {count !== undefined && (
                  <span
                    className={cn(
                      'rounded px-1 text-[10px] tabular-nums',
                      tab === item.id ? 'bg-accent-ink/20' : 'bg-surface-sunken text-ink-faint',
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-4 md:p-6">
          {tab === 'rules' ? (
            <RulesPanel orgId={orgId} automations={automations} />
          ) : tab === 'webhooks' ? (
            <WebhooksSection orgId={orgId} />
          ) : tab === 'apiTokens' ? (
            <ApiTokensSection orgId={orgId} />
          ) : (
            <IntegrationsSection orgId={orgId} />
          )}
        </div>
      </div>
    </div>
  );
}

function RulesPanel({
  orgId,
  automations,
}: {
  readonly orgId: string;
  readonly automations: UseQueryResult<readonly RuleSummary[]>;
}) {
  /* Three separate pieces of state, deliberately. The first version folded
     "which rule's runs are open" and "which rule is being edited" into one
     `editing` field, which meant opening a rule's history and editing it were
     the same click and neither could be done without the other. */
  const [showingRuns, setShowingRuns] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const editingRule = automations.data?.find((rule) => rule.automationId === editingRuleId);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-ink-faint">
          Every rule records a run each time its trigger fires — including the times its condition
          did not match.
        </p>
        {!creating && editingRule === undefined && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              setCreating(true);
              setEditingRuleId(null);
            }}
          >
            New rule
          </Button>
        )}
      </div>

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

      {automations.isPending ? (
        <SkeletonRows rows={3} />
      ) : automations.isError ? (
        <ErrorView error={automations.error} title="Could not load automations" />
      ) : automations.data.length === 0 ? (
        <Empty
          title="No automations yet"
          description="A rule watches for an event — a card entering Done, a comment being added — and then does something."
          action={
            !creating ? (
              <Button
                size="sm"
                onClick={() => {
                  setCreating(true);
                }}
              >
                New rule
              </Button>
            ) : undefined
          }
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
    <div
      className={cn(
        'overflow-hidden rounded-lg border transition-colors',
        rule.enabled ? 'border-line' : 'border-line/60',
      )}
    >
      {/* `flex-wrap` with the actions in their own non-shrinking group. The
          flat version put six controls and a two-line description in one
          nowrap row, so on anything narrower than a desktop the description
          truncated to a few characters to keep four buttons on screen — the
          text a reader came for losing to the controls they had not asked for
          yet. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 bg-surface-raised px-3 py-2">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            rule.enabled ? 'bg-success' : 'bg-ink-faint',
          )}
        />
        <span className="sr-only">{rule.enabled ? 'Enabled' : 'Disabled'}</span>

        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2">
            <span
              className={cn(
                'truncate text-sm font-medium',
                rule.enabled ? 'text-ink' : 'text-ink-muted',
              )}
            >
              {rule.name}
            </span>
            {rule.conditionBroken && (
              <span
                className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                title="The stored condition no longer parses, so this rule is refused on every event"
              >
                Broken
              </span>
            )}
          </p>
          {/* WHAT THE RULE DOES, not how many things it does. "3 actions" is a
              count of facts the reader came here to learn, and withholding
              them means opening the editor to answer "what does this rule
              even do".

              `When`/`Then` are spelled out rather than implied by an arrow
              alone: the arrow reads as an arrow only once you already know the
              shape, and this row is where someone learns it. */}
          <p className="truncate text-[11px] text-ink-faint">
            <span className="text-ink-faint">When </span>
            <span className="text-ink-muted">{triggerLabel(rule.triggerEvent)}</span>
            {rule.condition !== null && (
              <span className="text-ink-faint"> and a condition matches</span>
            )}
            <span className="text-ink-faint"> → </span>
            <span className="text-ink-muted">
              {rule.actions.map((action) => describeAction(action)).join(', ')}
            </span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
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
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            Runs <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          </Button>

          {/* Two clicks. A rule is deleted outright — there is no archive and
              no restore — and it used to sit one click away from `Runs`, at
              the end of a row of four identical ghost buttons. */}
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete rule"
            disabled={remove.isPending}
            className="h-6 px-1.5 text-[11px]"
            onConfirm={() => {
              remove.mutate();
            }}
          />
        </div>
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
  /* Two ways to reach this now (§7.8b): a card trigger with no card, and a
     connector event missing the wrapper fields a connector condition reads. */
  trigger_not_evaluable: 'this trigger carried nothing for the condition to check',
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

  /* Which vocabulary the condition is written in — derived, never stored. The
     server derives the same answer from the same function when it validates the
     save, so the builder cannot offer a field the save will refuse. */
  const conditionResource = resourceForTrigger(triggerEvent);
  /* Wave 4 (§5.5) — whether the cost-bearing telephony actions may be offered
     at all. The SERVER answers (the same env flag the write boundary is built
     from), never a client-side copy of the deployment's env; false until the
     answer arrives, which is the safe side — the server refuses to save a
     rule containing one while the flag is off. */
  const capabilities = useQuery({
    ...automationCapabilitiesQuery(orgId),
    enabled: orgId !== '',
  });
  /* Which project's vocabulary the list/status/label pickers offer. Local to
     the editor and never stored — see the field's own comment below. Starts
     unset even when editing, because the stored action carries an id and not
     the project it came from; the existing value stays selected regardless,
     since the pickers show what is chosen by id. */
  const [scopeProject, setScopeProject] = useState<ProjectId | null>(null);

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
            const next = event.target.value;
            /* Changing the trigger can change WHICH field set the condition is
               read against (§7.8b) — card fields for most triggers, the two
               connector fields for a Slack/GitHub event. The sets do not
               overlap, so a condition carried across that boundary is invalid
               in every chip at once and cannot be repaired from the builder,
               which only offers the new set's fields. Clearing it is the only
               recoverable outcome; keeping it would be a form that cannot be
               submitted and does not say why. */
            if (resourceForTrigger(next) !== resourceForTrigger(triggerEvent)) setCondition(null);
            setTriggerEvent(next);
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
            scoped to one project's vocabulary.

            `resource` is derived from the trigger, never chosen here: a Slack
            or GitHub rule filters on `provider_event` / `provider_scope`, and
            everything else filters on the card. See §7.8b. */}
        <div id="automation-condition" className="flex items-center gap-2">
          <FilterBuilder
            orgId={orgId}
            projectId={null}
            resource={conditionResource}
            value={condition}
            onChange={setCondition}
          />
          {condition === null && (
            <span className="text-[11px] text-ink-faint">
              {conditionResource === 'connector'
                ? 'Runs on every event from every connected workspace or repository.'
                : 'Runs every time the trigger fires.'}
            </span>
          )}
        </div>
      </Field>

      {/* Only rendered when an action needs it. Lists, statuses and labels are
          PROJECT vocabulary while a rule is org-wide, so the picker has to be
          told which project's options to offer. It is a UI aid and is not
          stored: the action carries the id it resolved to, which is all the
          engine needs.

          The consequence is worth stating out loud because it is real and
          predates the pickers — a rule whose action names project A's list
          simply fails for a card in project B, and the run records it. Pasting
          an id had the identical outcome, just later and less visibly. */}
      {actions.some((action) => needsProject(action.value.type)) && (
        <Field label="Project (for list, status and label choices)" htmlFor="automation-project">
          <div id="automation-project" className="space-y-1">
            <ProjectScopePicker orgId={orgId} value={scopeProject} onChange={setScopeProject} />
            <p className="text-[11px] text-ink-faint">
              Those actions only apply to cards in this project — a card from another project
              records a failed run.
            </p>
          </div>
        </Field>
      )}

      <Field label="Then" htmlFor="automation-actions">
        <div id="automation-actions" className="space-y-2">
          {actions.map((action, index) => (
            <ActionRow
              key={action.key}
              orgId={orgId}
              projectId={scopeProject}
              action={action}
              telephonyActionsEnabled={capabilities.data?.telephonyActionsEnabled ?? false}
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
        <Button
          type="submit"
          size="sm"
          disabled={name.trim() === '' || !actionsComplete(actions) || save.isPending}
        >
          {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
        </Button>
        <button type="button" onClick={onDone} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
        {name.trim() !== '' && !actionsComplete(actions) && (
          <span className="text-[11px] text-ink-faint">Finish choosing each action to save.</span>
        )}
      </div>
    </form>
  );
}

function ActionRow({
  orgId,
  projectId,
  action,
  telephonyActionsEnabled,
  onChange,
  onRemove,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId | null;
  readonly action: ActionDraft;
  /** Wave 4 (§5.5) — the server's answer to whether telephony actions exist. */
  readonly telephonyActionsEnabled: boolean;
  readonly onChange: (next: ActionDraft) => void;
  readonly onRemove?: () => void;
}) {
  const specs = ARGUMENTS[action.value.type] ?? [];
  const values = action.value as unknown as Record<string, string>;

  /* The offerable actions, minus the cost-bearing ones when the deployment
     has not enabled them. A rule SAVED while the flag was on keeps its
     telephony action in the editor after the flag is turned off: the row
     must stay legible, and saving unchanged is refused by the server with a
     real message — silently swapping the type for whatever sorts first
     would be an edit that replaced the action while the author watched. */
  const offered = offeredActions(telephonyActionsEnabled);
  /* `ACTION_LABELS[type] ?? type`: the label is present for every telephony
     type (the invariant vocabulary.test.ts pins), but `noUncheckedIndexedAccess`
     cannot know that, and the fallback is the type itself — the same fallback
     `describeAction` uses for a rule written by a newer build. */
  const options =
    TELEPHONY_ACTIONS.has(action.value.type) &&
    !offered.some(([type]) => type === action.value.type)
      ? ([
          ...offered,
          [action.value.type, ACTION_LABELS[action.value.type] ?? action.value.type],
        ] as const)
      : offered;

  return (
    <div className="flex items-start gap-2">
      <select
        value={action.value.type}
        onChange={(event) => {
          onChange(blankAction(event.target.value, action.key));
        }}
        aria-label="Action"
        className="shrink-0 rounded border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
      >
        {options.map(([type, text]) => (
          <option key={type} value={type}>
            {text}
          </option>
        ))}
      </select>

      {/* One picker per ARGUMENT, not one input per action. The single-input
          version could not reach `chat.post_message`'s `body` at all, so that
          action could never be saved — the server requires it non-empty. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {specs.map((spec) => (
          <ArgumentPicker
            key={spec.field}
            orgId={orgId}
            projectId={projectId}
            kind={spec.kind}
            label={spec.label}
            /* Only the `integration` kind reads it — to offer the right
               provider's connectors (§7.6). */
            actionType={action.value.type}
            value={values[spec.field] ?? ''}
            onChange={(next) => {
              onChange({
                key: action.key,
                value: { ...action.value, [spec.field]: next },
              });
            }}
          />
        ))}
      </div>

      {onRemove !== undefined && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove action"
          className="shrink-0 py-1 text-xs text-ink-faint hover:text-danger"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * The webhook registry (Wave 2, ai/phase-10-automation.md §5) — the endpoints
 * a rule's `call_webhook` action can name.
 *
 * Lives on the automations page because that is where rules are built; a
 * webhook is org furniture with no other surface. The SIGNING SECRET is shown
 * exactly once, on create, and never again — this box is the "paste it into
 * your receiver" moment, and a lost secret means recreating the webhook.
 * There is no read-back route and no rotation, so the UI does not pretend
 * there is one.
 */
type WebhookSummary = Wire<Awaited<ReturnType<typeof api.automation.webhooks.list.query>>>[number];

function WebhooksSection({ orgId }: { readonly orgId: string }) {
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{
    readonly name: string;
    readonly secret: string;
  } | null>(null);
  const [showingDeliveries, setShowingDeliveries] = useState<string | null>(null);

  const webhooks = useQuery({ ...webhooksQuery(orgId), enabled: orgId !== '' });

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-ink-faint">
          Endpoints a rule's “Call a webhook” action can reach. The receiver verifies the signature
          header with the secret shown at creation.
        </p>
        {!creating && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              setCreating(true);
            }}
          >
            New webhook
          </Button>
        )}
      </div>

      {creating && (
        <WebhookCreateForm
          onCreate={(result) => {
            setCreatedSecret(result);
            setCreating(false);
          }}
          onCancel={() => {
            setCreating(false);
          }}
        />
      )}

      {/* Shown once, and the dismissal is a deliberate click rather than a
          timeout — a secret that vanished while someone was still reading it
          is a recreated webhook. */}
      {createdSecret !== null && (
        <SecretReveal
          name={createdSecret.name}
          secret={createdSecret.secret}
          onDismiss={() => {
            setCreatedSecret(null);
          }}
        />
      )}

      {webhooks.isPending ? (
        <SkeletonRows rows={2} />
      ) : webhooks.isError ? (
        <ErrorText error={webhooks.error} />
      ) : webhooks.data.length === 0 ? (
        <Empty
          title="No webhooks yet"
          description="A rule cannot call an endpoint that is not registered here. Register one, paste its signing secret into your receiver, then pick it from a rule's “Call a webhook” action."
          action={
            !creating ? (
              <Button
                size="sm"
                onClick={() => {
                  setCreating(true);
                }}
              >
                New webhook
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {webhooks.data.map((webhook) => (
            <li key={webhook.webhookId}>
              <WebhookRow
                orgId={orgId}
                webhook={webhook}
                expanded={showingDeliveries === webhook.webhookId}
                onToggleExpanded={() => {
                  setShowingDeliveries(
                    showingDeliveries === webhook.webhookId ? null : webhook.webhookId,
                  );
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The create form — name and URL only; the secret is minted on submit. */
function WebhookCreateForm({
  onCreate,
  onCancel,
}: {
  readonly onCreate: (result: { name: string; secret: string }) => void;
  readonly onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const orgId = useSession((state) => state.orgId) ?? '';
  const toast = useToast();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');

  const create = useMutation({
    mutationFn: () => api.automation.webhooks.create.mutate({ name: name.trim(), url: url.trim() }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: keys.webhooks(orgId) });
      onCreate({ name: name.trim(), secret: result.signingSecret });
    },
    onError: (error: unknown) => {
      toast.failure('The webhook could not be created', error);
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
      className="mt-3 space-y-2 rounded-lg border border-line bg-surface-raised p-3"
    >
      <Field label="Name" htmlFor="webhook-name">
        <input
          id="webhook-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          maxLength={120}
          placeholder="Release notifications"
          className="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
        />
      </Field>
      <Field label="URL" htmlFor="webhook-url">
        <input
          id="webhook-url"
          type="url"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          maxLength={2048}
          placeholder="https://hooks.example.com/on-release"
          className="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
        />
        <p className="text-[11px] text-ink-faint">
          Public endpoints only — internal and private addresses are refused, and every redirect is
          re-checked at delivery.
        </p>
      </Field>

      {create.isError && <ErrorText error={create.error} />}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={name.trim() === '' || url.trim() === '' || create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create webhook'}
        </Button>
        <button type="button" onClick={onCancel} className="text-xs text-ink-faint hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One registered endpoint. */
function WebhookRow({
  orgId,
  webhook,
  expanded,
  onToggleExpanded,
}: {
  readonly orgId: string;
  readonly webhook: WebhookSummary;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.webhooks(orgId) });

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) =>
      api.automation.webhooks.setEnabled.mutate({ webhookId: webhook.webhookId, enabled }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: unknown) => {
      toast.failure('The webhook could not be updated', error);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.automation.webhooks.delete.mutate({ webhookId: webhook.webhookId }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (error: unknown) => {
      toast.failure('The webhook could not be deleted', error);
    },
  });

  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 bg-surface-raised px-3 py-2">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            webhook.enabled ? 'bg-success' : 'bg-ink-faint',
          )}
        />
        <span className="sr-only">{webhook.enabled ? 'Enabled' : 'Disabled'}</span>

        <div className="min-w-0 flex-1 basis-48">
          <p className="flex items-center gap-2">
            <span
              className={cn(
                'truncate text-sm font-medium',
                webhook.enabled ? 'text-ink' : 'text-ink-muted',
              )}
            >
              {webhook.name}
            </span>
            {!webhook.enabled && webhook.disabledAt !== null && (
              <span
                className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger"
                title={`Auto-disabled after ${String(webhook.failureCount)} consecutive failed deliveries`}
              >
                Disabled by failures
              </span>
            )}
          </p>
          {/* `font-mono` because this is a URL somebody will compare character
              by character against what they configured in their receiver, and
              a proportional font makes `rn` and `m` the same shape. */}
          <p className="truncate font-mono text-[11px] text-ink-faint" title={webhook.url}>
            {webhook.url}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            disabled={setEnabled.isPending}
            onClick={() => {
              setEnabled.mutate(!webhook.enabled);
            }}
          >
            {webhook.enabled ? 'Disable' : 'Enable'}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px]"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
          >
            Deliveries <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
          </Button>

          {/* Deleting an endpoint cascades its delivery queue with it, and the
              signing secret cannot be recovered — recreating means a new secret
              and a receiver reconfigured to match. Firmly a two-click action. */}
          <ConfirmButton
            label="Delete"
            confirmLabel="Delete endpoint"
            disabled={remove.isPending}
            className="h-6 px-1.5 text-[11px]"
            onConfirm={() => {
              remove.mutate();
            }}
          />
        </div>
      </div>

      {expanded && <WebhookDeliveries orgId={orgId} webhookId={webhook.webhookId} />}
      {(setEnabled.isError || remove.isError) && (
        <div className="border-t border-line px-3 py-2">
          <ErrorText error={setEnabled.error ?? remove.error} />
        </div>
      )}
    </div>
  );
}

/** Recent deliveries for one endpoint — the "did it go out" read. */
function WebhookDeliveries({
  orgId,
  webhookId,
}: {
  readonly orgId: string;
  readonly webhookId: string;
}) {
  const deliveries = useQuery({
    ...webhookDeliveriesQuery(orgId, webhookId),
    enabled: orgId !== '',
  });

  if (deliveries.isPending) return <SkeletonRows rows={2} />;
  if (deliveries.isError) return <ErrorText error={deliveries.error} />;
  if (deliveries.data.length === 0) {
    return (
      <p className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
        No deliveries yet — this endpoint appears in no rule runs.
      </p>
    );
  }

  return (
    <ul className="border-t border-line">
      {deliveries.data.map((delivery) => (
        <li key={delivery.deliveryId} className="px-3 py-1.5 text-[11px]">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'w-16 shrink-0 font-medium',
                DELIVERY_STATUS_COLOR[delivery.status] ?? 'text-ink',
              )}
            >
              {delivery.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-muted">
              {delivery.eventName}
              {delivery.attempts > 1 && ` · ${String(delivery.attempts)} attempts`}
              {delivery.lastStatusCode !== null && ` · HTTP ${String(delivery.lastStatusCode)}`}
              {delivery.lastError !== null && (
                <span className="text-danger"> · {delivery.lastError}</span>
              )}
            </span>
            <span className="shrink-0 text-ink-faint">{formatRelative(delivery.createdAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

const DELIVERY_STATUS_COLOR: Readonly<Record<string, string>> = {
  succeeded: 'text-success',
  pending: 'text-ink-faint',
  dead: 'text-danger',
};
