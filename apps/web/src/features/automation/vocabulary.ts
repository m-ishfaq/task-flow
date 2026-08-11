/**
 * What a rule can say, as the builder offers it (ai/phase-10-automation.md §1).
 *
 * Both lists below are closed and hand-maintained, and both are deliberately
 * NARROWER than what the server accepts:
 *
 *   - TRIGGERS: the server validates a trigger against the live event registry,
 *     which holds well over a hundred events — including ones no person would
 *     ever want to build a rule on (`session.token_reuse_detected`) and ones
 *     Wave 1's executor cannot act on. Offering the whole registry in a dropdown
 *     would be a menu of mostly-wrong answers.
 *   - ACTIONS: exactly the closed union the executor implements. Adding one is a
 *     three-place change (here, the route's Zod schema, the executor's switch),
 *     which is what keeps "a rule cannot do something a user could not" checkable
 *     by reading three files.
 *
 * A trigger missing from this list is not unreachable — it is simply not
 * offered, and the server would accept it. That asymmetry is intentional: the
 * UI narrows for usability, the server decides for correctness, and neither
 * pretends to be the other.
 */

export interface TriggerOption {
  readonly event: string;
  readonly label: string;
}

/**
 * Wave 1's triggers.
 *
 * Every one of them carries a `cardId` in its payload, which is not a
 * coincidence: the executor's actions all operate on "the card the trigger
 * named" (`cardIdOf`), and a condition is evaluated against that card's row. A
 * trigger with no card would leave both with nothing to work on — the engine
 * records `trigger_not_evaluable` and refuses — so offering one here would be
 * offering a rule that cannot work.
 */
export const TRIGGER_OPTIONS: readonly TriggerOption[] = [
  { event: 'card.created', label: 'A card is created' },
  { event: 'card.status_changed', label: "A card's status changes" },
  { event: 'card.moved', label: 'A card is moved to another list' },
  { event: 'card.assigned', label: 'A card is assigned' },
  { event: 'comment.created', label: 'A comment is added to a card' },
];

/** Every action the executor implements, labelled for a person. */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  'card.move': 'Move the card to a list',
  'card.set_status': "Set the card's status",
  'card.set_priority': "Set the card's priority",
  'card.assign': 'Assign someone to the card',
  'card.add_label': 'Add a label to the card',
  'chat.post_message': 'Post a chat message',
};

export type ActionValue =
  | { readonly type: 'card.move'; readonly listId: string }
  | { readonly type: 'card.set_status'; readonly statusId: string }
  | { readonly type: 'card.set_priority'; readonly priority: string }
  | { readonly type: 'card.assign'; readonly userId: string }
  | { readonly type: 'card.add_label'; readonly labelId: string }
  | { readonly type: 'chat.post_message'; readonly channelId: string; readonly body: string };

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

/**
 * One stored action, described for a person.
 *
 * A rule row that says "3 actions" tells the reader nothing about what the rule
 * DOES, which is the only thing they came to the page to find out. This turns
 * the stored jsonb back into the sentence the builder offered.
 *
 * Takes `unknown` because the value comes off the wire as jsonb: a rule written
 * by a NEWER build can name an action this one has never heard of, and the list
 * must still render rather than crash. An unrecognized shape degrades to its own
 * type name — honest about what it is, and visibly not something this build can
 * explain.
 */
export function describeAction(action: unknown): string {
  if (typeof action !== 'object' || action === null) return 'unrecognized action';

  const record = action as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  const label = ACTION_LABELS[type] ?? type;

  const key = ARGUMENT_KEYS[type];
  const value = key === undefined ? undefined : record[key];
  if (typeof value !== 'string' || value === '') return label;

  /* Ids are shown truncated rather than resolved to names. Resolving would mean
     a lookup per action per rule — and a stale or deleted target would render
     as a spinner or a blank, which is worse than a visible id a person can
     match against the thing they picked. */
  return `${label}: ${value.length > 12 ? `${value.slice(0, 8)}…` : value}`;
}

/** Which field of each action carries its single argument. */
export const ARGUMENT_KEYS: Readonly<Record<string, string>> = {
  'card.move': 'listId',
  'card.set_status': 'statusId',
  'card.set_priority': 'priority',
  'card.assign': 'userId',
  'card.add_label': 'labelId',
  'chat.post_message': 'channelId',
};

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
    case 'chat.post_message':
      return { key: identity, value: { type: 'chat.post_message', channelId: '', body: '' } };
    default:
      return { key: identity, value: { type: 'card.set_priority', priority: 'high' } };
  }
}
