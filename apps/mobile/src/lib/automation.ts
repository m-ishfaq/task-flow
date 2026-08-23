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
 * **What this pass does NOT port: creating or editing a rule.** The
 * builder web ships (`RuleEditor`, `action-pickers.tsx`, 973 lines
 * together) exists to fill in a `FilterTree` condition and one of ten
 * action-type-specific argument forms — a card's target list, a chat
 * channel, a webhook, an org member, a label. Every one of those needs a
 * picker this app either does not have yet (a webhook registry, a
 * connector picker, a condition builder — Phase 8's TQL/filter UI has
 * never been ported to native at all) or would need to build fresh for
 * this alone. That is real, dedicated work, not a corner cut from this
 * pass. What ships instead is a complete, honest slice on its own terms:
 * see what rules exist, see WHY one did or did not fire, kill a
 * misbehaving one, delete one outright — the actions someone actually
 * reaches for from a phone, as opposed to composing a new rule with a
 * ten-field form on a 6-inch screen. Webhooks, Slack/GitHub connectors,
 * and API tokens (the other three tabs on web's `/automations`) are
 * separate, more developer-facing surfaces nested on the same web page
 * and are not touched here either.
 *
 * **The condition itself is never rendered, on web or here.** `RuleRow`
 * shows "and a condition matches" when one is set, never the tree — the
 * builder is the only place a condition's actual shape is shown, because
 * that is the only place with the field/operator vocabulary loaded to
 * render it meaningfully. This file follows the identical rule, which is
 * what keeps a genuinely absent condition-builder from being a gap in
 * the read-only view too.
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

/**
 * Wave 1's triggers, copied verbatim from `vocabulary.ts`'s own
 * `TRIGGER_OPTIONS` — a closed, hand-maintained list deliberately
 * narrower than the server's full event registry (over a hundred names,
 * most of which nobody would build a rule on). This app never offers a
 * trigger picker itself (no rule creation here), so the only thing this
 * list is used for is turning a stored `triggerEvent` back into words —
 * but it needs to be the SAME words, not a re-derived guess, or a rule
 * built on web would read differently once opened on a phone.
 */
const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  'card.created': 'A card is created',
  'card.status_changed': "A card's status changes",
  'card.moved': 'A card is moved to another list',
  'card.assigned': 'A card is assigned',
  'card.labeled': 'A card is labelled',
  'card.updated': 'A card is edited',
  'card.archived': 'A card is archived',
  'comment.created': 'A comment is added to a card',
  'comment.updated': 'A comment is edited',
  'comment.deleted': 'A comment is removed',
  'checklist_item.updated': 'A checklist item is checked or edited',
  'attachment.uploaded': 'A file is attached to a card',
  'card.field_set': "A card's custom field changes",
  'integration.slack_event': 'A Slack event arrives (message, reaction, …)',
  'integration.github_event': 'A GitHub event arrives (push, issue, …)',
};

export function triggerLabel(event: string): string {
  return TRIGGER_LABELS[event] ?? event;
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
