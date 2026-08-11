/**
 * What a rule can say, as the builder offers it (ai/phase-10-automation.md §1).
 *
 * Both lists below are closed and hand-maintained, and the trigger list is
 * deliberately NARROWER than what the server accepts: the event registry holds
 * well over a hundred names, including ones nobody would build a rule on
 * (`session.token_reuse_detected`) and ones Wave 1's executor cannot act on.
 * Offering the whole registry would be a menu of mostly-wrong answers.
 *
 * ## Adding a trigger
 *
 * One entry in `TRIGGER_OPTIONS`, and the event must carry a `cardId` — see
 * that list's own note. Nothing else: the server validates a trigger against
 * the live registry, so a name that exists is already accepted.
 *
 * ## Adding an action — five places, deliberately
 *
 *   1. here: the union member, `ACTION_LABELS`, and its `ARGUMENTS` entry;
 *   2. `apps/api/src/automation/router.ts`: the Zod variant, which is the
 *      write boundary deciding what may reach the database at all;
 *   3. `apps/api/src/automation/automation.service.ts`: the same union member
 *      and its `EVENTS_EMITTED_BY` entry (the save-time self-trigger check's
 *      copy of the table);
 *   4. `apps/worker/src/automation/types.ts` and `loop-protection.ts`: the
 *      union member plus the entry in ITS `EVENTS_EMITTED_BY` table — the
 *      exhaustive `switch` in `executor.ts` is the branch itself, so a missing
 *      one is a compile error rather than a silent no-op;
 *   5. if the action calls a service module the worker does not import yet,
 *      an `"./…"` entry in `apps/api/package.json`'s `exports` map — the
 *      worker reaches `apps/api` only through those subpaths.
 *
 * The two `EVENTS_EMITTED_BY` tables are deliberate copies (each side's
 * comment says why); keeping them in sync is part of the change. Five places
 * sounds like friction and is the point: it is what keeps "a rule cannot do
 * something a user could not" checkable by reading the places that decide it.
 */

export interface TriggerOption {
  readonly event: string;
  readonly label: string;
}

/**
 * Wave 1's triggers.
 *
 * Every one carries a `cardId`, which is not a coincidence: the executor acts
 * on "the card the trigger named" (`cardIdOf`) and a condition is evaluated
 * against that card's row, so a trigger without one leaves both with nothing to
 * work on — the engine records `trigger_not_evaluable` and refuses. Offering
 * one here would be offering a rule that cannot work.
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
];

/** Every action the executor implements, labelled for a person. */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'card.move': 'Move the card to a list',
  'card.set_status': "Set the card's status",
  'card.set_priority': "Set the card's priority",
  'card.assign': 'Assign someone to the card',
  'card.add_label': 'Add a label to the card',
  'card.remove_label': 'Remove a label from the card',
  'card.unassign': 'Remove an assignee',
  'card.add_comment': 'Add a comment to the card',
  'chat.post_message': 'Post a chat message',
  'call_webhook': 'Call a webhook',
};

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
  | { readonly type: 'call_webhook'; readonly webhookId: string };

/**
 * How to EDIT each argument of each action.
 *
 * The first version of this file assumed one argument per action and rendered a
 * single text input bound to it. Two things were wrong with that, and the
 * second was fatal:
 *
 *   - every id was typed or pasted by hand, which is not something a person
 *     can do — nobody knows a channel's UUID;
 *   - `chat.post_message` has TWO arguments, and only `channelId` was
 *     reachable. `body` stayed `''` forever, the server requires it non-empty,
 *     so that action could never be saved at all. The single-argument
 *     assumption made the feature unusable rather than merely awkward.
 *
 * So an action declares its arguments as a list, each with the KIND of input it
 * needs. `kind` is what the editor switches on to render a real picker.
 */
export type ArgumentKind =
  /** A short enum, rendered as a plain select. */
  | 'priority'
  /** Org-scoped pickers — no project needed. */
  | 'member'
  | 'channel'
  | 'webhook'
  /** Project-scoped pickers — need a project chosen first (see PROJECT_SCOPED). */
  | 'list'
  | 'status'
  | 'label'
  /** Free text. */
  | 'text';

export interface ArgumentSpec {
  readonly field: string;
  readonly label: string;
  readonly kind: ArgumentKind;
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
  /* Wave 2 — names an org-registered webhook, so the picker offers the
     registry and the action can never carry a bare URL. */
  'call_webhook': [{ field: 'webhookId', label: 'Webhook', kind: 'webhook' }],
};

/**
 * Argument kinds whose options only exist inside a PROJECT.
 *
 * Lists, statuses and labels are project vocabulary; a rule is org-wide. That
 * mismatch is real and predates this file — an action naming a list in project
 * A simply fails for a card in project B, recorded as a failed run. The picker
 * makes it visible rather than introducing it: previously you pasted an id and
 * found out later.
 */
export const PROJECT_SCOPED: ReadonlySet<ArgumentKind> = new Set<ArgumentKind>([
  'list',
  'status',
  'label',
]);

/** True when any of this action's arguments needs a project to be chosen. */
export function needsProject(type: string): boolean {
  return (ARGUMENTS[type] ?? []).some((argument) => PROJECT_SCOPED.has(argument.kind));
}

/**
 * One stored action, described for a person.
 *
 * A rule row that says "3 actions" tells the reader nothing about what the rule
 * DOES, which is the only thing they came to the page to find out. This turns
 * the stored jsonb back into the sentence the builder offered.
 *
 * Takes `unknown` because the value comes off the wire as jsonb: a rule written
 * by a NEWER build can name an action this one has never heard of, and the list
 * must still render rather than crash.
 */
export function describeAction(action: unknown): string {
  if (typeof action !== 'object' || action === null) return 'unrecognized action';

  const record = action as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  const label = ACTION_LABELS[type] ?? type;

  /* A message body reads far better than an id, so a post-message or
     add-comment action is described by what it says rather than by where or
     on what it does it. */
  if ((type === 'chat.post_message' || type === 'card.add_comment') && typeof record['body'] === 'string') {
    return `${label}: “${truncate(record['body'], 40)}”`;
  }

  const first = (ARGUMENTS[type] ?? [])[0];
  const value = first === undefined ? undefined : record[first.field];
  if (typeof value !== 'string' || value === '') return label;

  /* Ids stay truncated rather than resolved to names: resolving would mean a
     lookup per action per rule, and a deleted target would render as a blank
     or a spinner — worse than a visible id somebody can match by eye. The
     PICKER is where names belong, because there the options are already
     loaded. */
  return `${label}: ${truncate(value, 12)}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * One row in the editor.
 *
 * `key` is a stable identity for React's list reconciliation, kept separate
 * from the value so that changing an action's TYPE — which replaces the whole
 * value object — does not remount the row and steal focus mid-edit.
 */
export interface ActionDraft {
  readonly key: string;
  readonly value: ActionValue;
}

/** A fresh draft of the given type, reusing `key` when replacing a row in place. */
export function blankAction(type = 'card.set_priority', key?: string): ActionDraft {
  const identity = key ?? crypto.randomUUID();

  switch (type) {
    case 'card.move':
      return { key: identity, value: { type: 'card.move', listId: '' } };
    case 'card.set_status':
      return { key: identity, value: { type: 'card.set_status', statusId: '' } };
    case 'card.assign':
      return { key: identity, value: { type: 'card.assign', userId: '' } };
    case 'card.add_label':
      return { key: identity, value: { type: 'card.add_label', labelId: '' } };
    case 'card.remove_label':
      return { key: identity, value: { type: 'card.remove_label', labelId: '' } };
    case 'card.unassign':
      return { key: identity, value: { type: 'card.unassign', userId: '' } };
    case 'card.add_comment':
      return { key: identity, value: { type: 'card.add_comment', body: '' } };
    case 'chat.post_message':
      return { key: identity, value: { type: 'chat.post_message', channelId: '', body: '' } };
    case 'call_webhook':
      return { key: identity, value: { type: 'call_webhook', webhookId: '' } };
    default:
      return { key: identity, value: { type: 'card.set_priority', priority: 'high' } };
  }
}
