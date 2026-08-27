import type { Wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Automation rules (Phase 10, Wave 1) — read, toggle, delete, and run
 * history, ported from `apps/web/src/features/automation/vocabulary.ts`'s
 * pure display logic and `automations-page.tsx`'s own `RuleRow`/
 * `RunHistory` reasoning. Types, query keys, and the human-readable
 * translation of what the server stores — no `react-native` import
 * anywhere in this file, the same split `people.ts`/`telephony.ts`
 * already establish.
 *
 * **Rule creation and editing now ship — `automation-editor.tsx` —
 * narrower than web's builder, and the narrowing is a real, stated
 * boundary rather than a silent gap.** Web's builder
 * (`RuleEditor`/`action-pickers.tsx`) fills in a `FilterTree` condition
 * and one of ten action-type-specific argument forms. Two of those
 * argument kinds have no picker here at all: `webhook` (this app has no
 * webhook registry) and `integration` (no Slack/GitHub connector list
 * either) — so `call_webhook`, `slack.post_message` and
 * `github.create_issue` are not in `ARGUMENTS` below and the editor
 * cannot create or edit a rule using one. The condition builder is the
 * same story at a larger scale: Phase 8's TQL/filter UI has never
 * touched native, so this editor never writes a condition, full stop —
 * every rule it CREATES has `condition: null`, and `canEditOnMobile`
 * below refuses to offer "Edit" at all for an existing rule that already
 * has one, because saving it back would silently CLEAR it. Every other
 * action type (list/status/label/member/channel/priority/phone/text) has
 * a real picker, built from queries this app already had — see
 * `automation-editor.tsx`'s own header for the full account. Webhooks,
 * Slack/GitHub connectors, and API tokens (the other three tabs on web's
 * `/automations`) are separate, more developer-facing surfaces nested on
 * the same web page and are not touched here either.
 *
 * **The condition itself is never RENDERED as a tree, on web or here —
 * that stays true even now that rules can be edited.** `RuleRow` shows
 * "and a condition matches" when one is set, never the tree; the builder
 * is the only place a condition's actual shape is shown, because that is
 * the only place with the field/operator vocabulary loaded to render it
 * meaningfully, and this app was never that place.
 */

export type AutomationSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['automation']['list']['query']>>
>['automations'][number];

export type AutomationRun = Wire<
  Awaited<ReturnType<MobileTRPCClient['automation']['runs']['query']>>
>[number];

export const AUTOMATIONS_QUERY_KEY = ['automation.list'] as const;

export function automationRunsQueryKey(automationId: string): readonly ['automation.runs', string] {
  return ['automation.runs', automationId];
}

export interface TriggerOption {
  readonly event: string;
  readonly label: string;
}

/**
 * Wave 1's triggers, copied verbatim from `vocabulary.ts`'s own
 * `TRIGGER_OPTIONS` — a closed, hand-maintained list deliberately
 * narrower than the server's full event registry (over a hundred names,
 * most of which nobody would build a rule on). The two connector events
 * at the bottom are excluded from `automation-editor.tsx`'s own trigger
 * picker (see that file's header) but stay here so a rule built on web
 * that uses one still reads correctly when opened read-only on a phone.
 */
export const TRIGGER_OPTIONS: readonly TriggerOption[] = [
  { event: 'card.created', label: 'A card is created' },
  { event: 'card.status_changed', label: "A card's status changes" },
  { event: 'card.moved', label: 'A card is moved to another list' },
  { event: 'card.assigned', label: 'A card is assigned' },
  { event: 'card.labeled', label: 'A card is labelled' },
  { event: 'card.updated', label: 'A card is edited' },
  { event: 'card.archived', label: 'A card is archived' },
  { event: 'comment.created', label: 'A comment is added to a card' },
  { event: 'comment.updated', label: 'A comment is edited' },
  { event: 'comment.deleted', label: 'A comment is removed' },
  { event: 'checklist_item.updated', label: 'A checklist item is checked or edited' },
  { event: 'attachment.uploaded', label: 'A file is attached to a card' },
  { event: 'card.field_set', label: "A card's custom field changes" },
  { event: 'integration.slack_event', label: 'A Slack event arrives (message, reaction, …)' },
  { event: 'integration.github_event', label: 'A GitHub event arrives (push, issue, …)' },
];

/** Triggers `automation-editor.tsx`'s picker offers — every `TRIGGER_OPTIONS`
 *  entry except the two connector events, which name no card and therefore
 *  every card-mutating action this editor can build would record a failed
 *  run against them (`vocabulary.ts`'s own note on why those two exist). */
export const EDITOR_TRIGGER_OPTIONS: readonly TriggerOption[] = TRIGGER_OPTIONS.filter(
  (option) =>
    option.event !== 'integration.slack_event' && option.event !== 'integration.github_event',
);

export function triggerLabel(event: string): string {
  return TRIGGER_OPTIONS.find((option) => option.event === event)?.label ?? event;
}

/** Every action the executor implements, labelled for a person — copied verbatim from `vocabulary.ts`'s own `ACTION_LABELS`. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'card.move': 'Move the card to a list',
  'card.set_status': "Set the card's status",
  'card.set_priority': "Set the card's priority",
  'card.assign': 'Assign someone to the card',
  'card.add_label': 'Add a label to the card',
  'card.remove_label': 'Remove a label from the card',
  'card.unassign': 'Remove an assignee',
  'card.add_comment': 'Add a comment to the card',
  'chat.post_message': 'Post a chat message',
  call_webhook: 'Call a webhook',
  'call.place': 'Place a call',
  'sms.send': 'Send an SMS',
  'slack.post_message': 'Post a Slack message',
  'github.create_issue': 'Open a GitHub issue',
};

/**
 * How to EDIT each argument of each action — `automation-editor.tsx`'s own
 * `ArgumentPicker` switches on `kind` to render a real picker rather than a
 * text field asking someone to type a UUID by hand, mirroring `vocabulary
 * .ts`'s own `ArgumentKind`/`ARGUMENTS`. Narrower than web's table on
 * purpose: `webhook` and `integration` are absent because this app has no
 * webhook registry or connector list to pick from (see this file's own
 * header), so `call_webhook`, `slack.post_message` and `github.create_issue`
 * are not in `ARGUMENTS` below at all — a type with no entry here is a type
 * the editor cannot build or edit, which is exactly `EDITABLE_ACTION_TYPES`.
 */
export type ArgumentKind =
  | 'priority'
  | 'member'
  | 'channel'
  | 'phoneNumber'
  | 'phoneTarget'
  | 'list'
  | 'status'
  | 'label'
  | 'text';

export interface ArgumentSpec {
  readonly field: string;
  readonly label: string;
  readonly kind: ArgumentKind;
  readonly optional?: boolean;
}

export const ARGUMENTS: Readonly<Record<string, readonly ArgumentSpec[]>> = {
  'card.move': [{ field: 'listId', label: 'List', kind: 'list' }],
  'card.set_status': [{ field: 'statusId', label: 'Status', kind: 'status' }],
  'card.set_priority': [{ field: 'priority', label: 'Priority', kind: 'priority' }],
  'card.assign': [{ field: 'userId', label: 'Person', kind: 'member' }],
  'card.add_label': [{ field: 'labelId', label: 'Label', kind: 'label' }],
  'card.remove_label': [{ field: 'labelId', label: 'Label', kind: 'label' }],
  'card.unassign': [{ field: 'userId', label: 'Person', kind: 'member' }],
  'card.add_comment': [{ field: 'body', label: 'Comment', kind: 'text' }],
  'chat.post_message': [
    { field: 'channelId', label: 'Channel', kind: 'channel' },
    { field: 'body', label: 'Message', kind: 'text' },
  ],
  'call.place': [
    { field: 'to', label: 'To', kind: 'phoneTarget' },
    { field: 'fromPhoneNumberId', label: 'From (your number)', kind: 'phoneNumber' },
  ],
  'sms.send': [
    { field: 'to', label: 'To', kind: 'phoneTarget' },
    { field: 'fromPhoneNumberId', label: 'From (your number)', kind: 'phoneNumber' },
    { field: 'body', label: 'Message', kind: 'text' },
  ],
};

/** Every action type this app can build a picker for — the same set
 *  `ARGUMENTS` has an entry for, restated as a set for cheap membership
 *  checks (`canEditOnMobile` below). */
export const EDITABLE_ACTION_TYPES: ReadonlySet<string> = new Set(Object.keys(ARGUMENTS));

/** The cost-bearing actions (§5.5), hidden unless the deployment enables
 *  them — mirrors `vocabulary.ts`'s own `TELEPHONY_ACTIONS`. The flag is a
 *  product-surface gate, never a security control: every real gate a
 *  telephony action passes runs unconditionally at execution either way. */
const TELEPHONY_ACTIONS: ReadonlySet<string> = new Set(['call.place', 'sms.send']);

/** Which argument kinds only exist inside a PROJECT — mirrors `vocabulary
 *  .ts`'s own `PROJECT_SCOPED`. Lists, statuses and labels are project
 *  vocabulary; a rule is org-wide, so an action naming one binds the whole
 *  rule to that project even though nothing stores that binding. */
const PROJECT_SCOPED: ReadonlySet<ArgumentKind> = new Set<ArgumentKind>([
  'list',
  'status',
  'label',
]);

/** True when any of this action's arguments needs a project chosen first. */
export function needsProject(type: string): boolean {
  return (ARGUMENTS[type] ?? []).some((argument) => PROJECT_SCOPED.has(argument.kind));
}

/** The actions the editor may offer to ADD, as `[type, label]` pairs — every
 *  `EDITABLE_ACTION_TYPES` entry, telephony-gated the same way `vocabulary
 *  .ts`'s own `offeredActions` gates web's. */
export function offeredActions(
  telephonyActionsEnabled: boolean,
): readonly (readonly [type: string, label: string])[] {
  return Object.entries(ACTION_LABELS).filter(
    ([type]) =>
      EDITABLE_ACTION_TYPES.has(type) && (!TELEPHONY_ACTIONS.has(type) || telephonyActionsEnabled),
  );
}

export type ActionValue =
  | { readonly type: 'card.move'; readonly listId: string }
  | { readonly type: 'card.set_status'; readonly statusId: string }
  | { readonly type: 'card.set_priority'; readonly priority: string }
  | { readonly type: 'card.assign'; readonly userId: string }
  | { readonly type: 'card.add_label'; readonly labelId: string }
  | { readonly type: 'card.remove_label'; readonly labelId: string }
  | { readonly type: 'card.unassign'; readonly userId: string }
  | { readonly type: 'card.add_comment'; readonly body: string }
  | { readonly type: 'chat.post_message'; readonly channelId: string; readonly body: string }
  | { readonly type: 'call.place'; readonly to: string; readonly fromPhoneNumberId: string }
  | {
      readonly type: 'sms.send';
      readonly to: string;
      readonly fromPhoneNumberId: string;
      readonly body: string;
    };

/**
 * One row in the editor — `key` is a stable identity for React's list
 * reconciliation, kept separate from `value` so changing an action's TYPE
 * (which replaces the whole value object) does not remount the row and
 * steal focus mid-edit. Mirrors `vocabulary.ts`'s own `ActionDraft`.
 */
export interface ActionDraft {
  readonly key: string;
  readonly value: ActionValue;
}

/** A fresh draft of the given type, reusing `key` when replacing a row in
 *  place — mirrors `vocabulary.ts`'s own `blankAction`, narrowed to the
 *  types this editor offers. */
export function blankAction(type: string, key: string): ActionDraft {
  switch (type) {
    case 'card.move':
      return { key, value: { type: 'card.move', listId: '' } };
    case 'card.set_status':
      return { key, value: { type: 'card.set_status', statusId: '' } };
    case 'card.assign':
      return { key, value: { type: 'card.assign', userId: '' } };
    case 'card.add_label':
      return { key, value: { type: 'card.add_label', labelId: '' } };
    case 'card.remove_label':
      return { key, value: { type: 'card.remove_label', labelId: '' } };
    case 'card.unassign':
      return { key, value: { type: 'card.unassign', userId: '' } };
    case 'card.add_comment':
      return { key, value: { type: 'card.add_comment', body: '' } };
    case 'chat.post_message':
      return { key, value: { type: 'chat.post_message', channelId: '', body: '' } };
    case 'call.place':
      return { key, value: { type: 'call.place', to: '', fromPhoneNumberId: '' } };
    case 'sms.send':
      return { key, value: { type: 'sms.send', to: '', fromPhoneNumberId: '', body: '' } };
    default:
      return { key, value: { type: 'card.set_priority', priority: 'high' } };
  }
}

/** True once every argument of every action has a value — the server
 *  refuses anything less, and "why won't it save" is worse when it only
 *  surfaces as a server error after the fact. Mirrors `automations-page
 *  .tsx`'s own `actionsComplete`. */
export function actionsComplete(actions: readonly ActionDraft[]): boolean {
  return actions.every((action) =>
    (ARGUMENTS[action.value.type] ?? []).every((spec) => {
      if (spec.optional === true) return true;
      const value = (action.value as unknown as Record<string, string>)[spec.field];
      return typeof value === 'string' && value.trim() !== '';
    }),
  );
}

/**
 * Turns a rule's stored actions back into editable drafts. Only ever called
 * when `canEditOnMobile` has already said yes — every action is guaranteed
 * to be one of `EDITABLE_ACTION_TYPES` — but each field is still narrowed
 * defensively from `unknown` rather than cast, since the value comes off
 * the wire as jsonb and a malformed row should degrade to an empty field
 * rather than throw.
 */
export function draftsFrom(stored: readonly unknown[]): ActionDraft[] {
  return stored.map((raw, index) => {
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const type = typeof record['type'] === 'string' ? record['type'] : 'card.set_priority';
    const draft = blankAction(type, `existing-${String(index)}`);
    const fields: Record<string, string> = {};
    for (const spec of ARGUMENTS[type] ?? []) {
      const value = record[spec.field];
      fields[spec.field] = typeof value === 'string' ? value : '';
    }
    return { key: draft.key, value: { ...draft.value, ...fields } };
  });
}

/**
 * Whether `automation-editor.tsx` may offer "Edit" for this rule at all —
 * the UI half of the decision `automation.ts`'s own header states: mobile
 * only ever writes back a rule it can FULLY and safely represent, never a
 * partial one. Two conditions, both load-bearing:
 *
 *   - `condition === null` — a condition can only be rendered by the
 *     builder that has the field/operator vocabulary loaded for it, which
 *     this app does not have (Phase 8's TQL/filter UI has never touched
 *     native). Saving a rule with `condition: null` would silently CLEAR a
 *     condition someone set on web, which is worse than refusing to edit.
 *   - every action's type is in `EDITABLE_ACTION_TYPES` — a rule holding a
 *     `call_webhook` or connector action has no picker on this platform, so
 *     re-saving it would mean inventing a value for an argument the editor
 *     never showed.
 *
 * A rule failing either check still gets Enable/Disable/Delete
 * (`automations.tsx`'s `RuleRow`) — only "Edit" is gated.
 */
export function canEditOnMobile(rule: {
  readonly condition?: unknown;
  readonly actions: readonly unknown[];
}): boolean {
  if (rule.condition !== null) return false;
  return rule.actions.every((action) => {
    const type =
      typeof action === 'object' && action !== null
        ? (action as Record<string, unknown>)['type']
        : undefined;
    return typeof type === 'string' && EDITABLE_ACTION_TYPES.has(type);
  });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * One stored action, described for a person — ported verbatim from
 * `vocabulary.ts`'s own `describeAction`, minus the `ARGUMENTS` table
 * fallback (that table exists to label an action's FIRST argument by
 * name for the ones with no dedicated case below, e.g. `card.move`'s
 * `listId` — this app has no rule builder to share it with, so the
 * three special-cased "say what it actually says" branches plus a bare
 * label fallback cover every action type without needing a copy of that
 * table here too).
 *
 * Takes `unknown` because the value comes off the wire as jsonb: a rule
 * written by a NEWER build can name an action this build has never heard
 * of, and the list must still render rather than crash.
 */
export function describeAction(action: unknown): string {
  if (typeof action !== 'object' || action === null) return 'unrecognized action';

  const record = action as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  const label = ACTION_LABELS[type] ?? type;

  if (
    (type === 'chat.post_message' || type === 'card.add_comment' || type === 'sms.send') &&
    typeof record['body'] === 'string'
  ) {
    return `${label}: "${truncate(record['body'], 40)}"`;
  }

  if (type === 'slack.post_message' && typeof record['text'] === 'string') {
    const channel = typeof record['channel'] === 'string' ? record['channel'] : '';
    return `${label}${channel === '' ? '' : ` to ${channel}`}: "${truncate(record['text'], 40)}"`;
  }

  if (type === 'github.create_issue' && typeof record['title'] === 'string') {
    return `${label}: "${truncate(record['title'], 40)}"`;
  }

  return label;
}

/**
 * The engine's refusal codes, in words — ported verbatim from
 * `vocabulary.ts`'s own `REASON_TEXT`/`explainReason`. The stored
 * `reason` is a stable machine code because a run row is data other
 * things read; showing it raw makes a person guess, and the ones worth
 * explaining are exactly the ones that look like the system is broken
 * when it is working as designed.
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  condition_not_met: 'the condition did not match, so nothing ran',
  rule_disabled: 'the rule was disabled',
  org_suspended: 'this organization is suspended',
  depth_exceeded: 'too many automations fired in a chain — stopped to prevent a loop',
  self_trigger: "this rule's own action would re-trigger it",
  budget_exhausted: 'this organization hit its hourly automation limit',
  unauthorized: 'the rule owner no longer has permission to do this',
  condition_unusable: 'the saved condition no longer parses — edit the rule on web to fix it',
  trigger_not_evaluable: 'this trigger carried nothing for the condition to check',
};

export function explainReason(reason: string): string {
  return REASON_TEXT[reason] ?? reason;
}

const STATUS_TEXT: Readonly<Record<string, string>> = {
  succeeded: 'ran successfully',
  failed: 'an action failed',
  refused: 'refused',
  skipped: 'skipped',
};

export function explainStatus(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

const STATUS_COLOR: Readonly<Record<string, string>> = {
  succeeded: colors.success.hex,
  failed: colors.danger.hex,
  refused: colors.warning.hex,
  skipped: colors.inkFaint.hex,
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? colors.ink.hex;
}

/** One action's outcome, as the engine recorded it — the same narrow-from-`unknown` shape `ActionOutcome` reads on web. */
export function actionOutcomeOf(
  result: unknown,
): { readonly label: string; readonly failed: boolean; readonly error: string | null } | null {
  if (typeof result !== 'object' || result === null) return null;

  const record = result as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  const failed = record['status'] === 'failed';
  const error = typeof record['error'] === 'string' ? record['error'] : null;

  return { label: ACTION_LABELS[type] ?? type, failed, error };
}
