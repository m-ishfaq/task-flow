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
 * that list's own note — unless it is a deliberately card-less trigger like
 * the connector events at the bottom, which say so in their label. Nothing
 * else: the server validates a trigger against the live registry, so a name
 * that exists is already accepted.
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
 *
 * The two connector events at the bottom are the deliberate exception (§7.5):
 * an inbound Slack/GitHub event carries no card because it ISN'T one, so a
 * rule whose actions need the trigger's card records a failed run — the
 * honest shape for a rule built wrong — while a rule using the non-card
 * actions (chat post, webhook call, and slice 4's connector actions) works
 * exactly as built.
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
  /* Wave 4 slice 3 (§7.5) — no card, deliberately; see the header note. */
  { event: 'integration.slack_event', label: 'A Slack event arrives (message, reaction, …)' },
  { event: 'integration.github_event', label: 'A GitHub event arrives (push, issue, …)' },
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
  call_webhook: 'Call a webhook',
  /* Wave 4 (§5.5) — the cost-bearing actions. They cost money and are gated
     behind a deployment flag, so `offeredActions` hides them unless the
     server says they exist — but the LABELS (and the ARGUMENTS below) are
     unconditional, because a rule saved under a previous configuration must
     still render when listed. */
  'call.place': 'Place a call',
  'sms.send': 'Send an SMS',
  /* Wave 4 slice 4 (§7.6) — unconditional, unlike the telephony pair: they
     cost nothing and reach only a provider the org connected itself, so there
     is no deployment flag and `offeredActions` never hides them. A rule that
     names a connector the org has since disconnected fails at execution with a
     recorded reason, which is the honest place for it. */
  'slack.post_message': 'Post a Slack message',
  'github.create_issue': 'Open a GitHub issue',
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
  | { readonly type: 'call_webhook'; readonly webhookId: string }
  /* Wave 4 (§5.5) — `to` is free text because a rule may reach anyone
     (validated to E.164 by the server, never a UI claim), while the FROM
     number must be one the org owns — that is what the picker offers. */
  | { readonly type: 'call.place'; readonly to: string; readonly fromPhoneNumberId: string }
  | {
      readonly type: 'sms.send';
      readonly to: string;
      readonly fromPhoneNumberId: string;
      readonly body: string;
    }
  /* Wave 4 slice 4 (§7.6). `integrationId` is a picker over the org's
     CONNECTED connectors; the GitHub repository is not an argument at all,
     because it is the connector's own scope. */
  | {
      readonly type: 'slack.post_message';
      readonly integrationId: string;
      readonly channel: string;
      readonly text: string;
    }
  | {
      readonly type: 'github.create_issue';
      readonly integrationId: string;
      readonly title: string;
      readonly body: string;
    };

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
  /**
   * A connected Slack workspace or GitHub repository (Wave 4 slice 4, §7.6).
   *
   * One kind, not two, because the picker's options are filtered by the action
   * that asked: `slack.post_message` offers Slack rows and
   * `github.create_issue` offers GitHub rows. A second `ArgumentKind` would be
   * two names for one control and a coin flip about which one a new provider
   * should use.
   */
  | 'integration'
  /** The org's owned phone numbers (Wave 4, §5.5). */
  | 'phoneNumber'
  /**
   * Who a rule dials or texts: a select of org members' work phones, with a
   * fall-through to a typed E.164 for anyone not in the directory (Wave 4,
   * §5.5).
   */
  | 'phoneTarget'
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
  /**
   * True when the server accepts an empty value (Wave 4 slice 4).
   *
   * Every argument before this one was required, so `actionsComplete` simply
   * demanded all of them — an assumption, not a rule. A GitHub issue with a
   * title and no body is perfectly ordinary, and the route's schema allows it,
   * so a Save button disabled on an empty body would be the UI refusing
   * something the server does not. Mark it here rather than special-casing the
   * field name in the form, which is where the two would drift.
   */
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
  /* Wave 2 — names an org-registered webhook, so the picker offers the
     registry and the action can never carry a bare URL. */
  call_webhook: [{ field: 'webhookId', label: 'Webhook', kind: 'webhook' }],
  /* Wave 4 (§5.5) — the cost-bearing actions. `to` is a contact-or-custom
     picker: the org's members with work phones offered as prefills, plus a
     manual E.164 field (a rule may reach anyone, and the server validates the
     number). `fromPhoneNumberId` is a picker over the org's OWN numbers,
     because the service resolves it under `withOrgScope` and a number the org
     does not hold is a 404. */
  'call.place': [
    { field: 'to', label: 'To', kind: 'phoneTarget' },
    { field: 'fromPhoneNumberId', label: 'From (your number)', kind: 'phoneNumber' },
  ],
  'sms.send': [
    { field: 'to', label: 'To', kind: 'phoneTarget' },
    { field: 'fromPhoneNumberId', label: 'From (your number)', kind: 'phoneNumber' },
    { field: 'body', label: 'Message', kind: 'text' },
  ],
  /* Wave 4 slice 4 (§7.6). Note what is NOT here: `github.create_issue` has no
     repository argument. The repo is the connector's own scope, resolved
     server-side, so the picker choosing a connector IS choosing the repo — and
     a rule can never name one the org did not connect. */
  'slack.post_message': [
    { field: 'integrationId', label: 'Workspace', kind: 'integration' },
    { field: 'channel', label: 'Channel', kind: 'text' },
    { field: 'text', label: 'Message', kind: 'text' },
  ],
  'github.create_issue': [
    { field: 'integrationId', label: 'Repository', kind: 'integration' },
    { field: 'title', label: 'Title', kind: 'text' },
    { field: 'body', label: 'Body (optional)', kind: 'text', optional: true },
  ],
};

/**
 * Which provider's connectors an action's `integration` picker may offer.
 *
 * A closed map rather than a guess from the action's `type` prefix: the prefix
 * happens to match today (`slack.` / `github.`) and reading it would be a
 * parser over a naming convention, which breaks silently the first time an
 * action is named for what it does rather than for who it calls.
 */
export const INTEGRATION_PROVIDER_OF: Readonly<Record<string, 'slack' | 'github'>> = {
  'slack.post_message': 'slack',
  'github.create_issue': 'github',
};

/**
 * The cost-bearing actions (§5.5), hidden unless the deployment enables them.
 *
 * The flag is a PRODUCT-SURFACE gate, never a security control: every gate a
 * telephony action passes — geo, org freeze, subaccount, rolling cap,
 * velocity, the automation sub-budget — runs unconditionally at execution
 * whether or not the builder offers the action.
 */
export const TELEPHONY_ACTIONS: ReadonlySet<string> = new Set(['call.place', 'sms.send']);

/**
 * The actions the builder may offer, as `[type, label]` pairs.
 *
 * The server decides whether the telephony actions exist at all
 * (`automation.capabilities`, answered from the deployment env), and the UI
 * must not offer a rule the server will refuse to save. False until the
 * answer arrives — the safe side of the flag: a hidden action is a missing
 * feature, a shown one is a rule that cannot exist.
 */
export function offeredActions(
  telephonyActionsEnabled: boolean,
): readonly [type: string, label: string][] {
  return Object.entries(ACTION_LABELS).filter(
    ([type]) => !TELEPHONY_ACTIONS.has(type) || telephonyActionsEnabled,
  );
}

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
  if (
    (type === 'chat.post_message' || type === 'card.add_comment' || type === 'sms.send') &&
    typeof record['body'] === 'string'
  ) {
    return `${label}: “${truncate(record['body'], 40)}”`;
  }

  /* Wave 4 slice 4 — the same "say what it says" rule, over the field each of
     these actually carries. Without this the first ARGUMENT is `integrationId`
     and every connector action in the list would read "Post a Slack message:
     019ff609-78…", which is the id of a row the reader cannot resolve by eye —
     strictly worse than the text the rule sends. */
  if (type === 'slack.post_message' && typeof record['text'] === 'string') {
    const channel = typeof record['channel'] === 'string' ? record['channel'] : '';
    return `${label}${channel === '' ? '' : ` to ${channel}`}: “${truncate(record['text'], 40)}”`;
  }

  if (type === 'github.create_issue' && typeof record['title'] === 'string') {
    return `${label}: “${truncate(record['title'], 40)}”`;
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
    case 'call.place':
      return { key: identity, value: { type: 'call.place', to: '', fromPhoneNumberId: '' } };
    case 'sms.send':
      return {
        key: identity,
        value: { type: 'sms.send', to: '', fromPhoneNumberId: '', body: '' },
      };
    case 'slack.post_message':
      return {
        key: identity,
        value: { type: 'slack.post_message', integrationId: '', channel: '', text: '' },
      };
    case 'github.create_issue':
      return {
        key: identity,
        value: { type: 'github.create_issue', integrationId: '', title: '', body: '' },
      };
    default:
      return { key: identity, value: { type: 'card.set_priority', priority: 'high' } };
  }
}
