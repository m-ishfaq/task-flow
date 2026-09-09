import type { AutomationAction, AutomationRule, RunReason } from './types.js';

/**
 * Loop protection (ai/phase-10-automation.md §4) — mandatory, day one.
 *
 * ## Why this is structural rather than cautious
 *
 * Actions run through the ordinary service layer, which is what buys
 * automations the same audit, events, broadcasts and notifications a human
 * action gets. The unavoidable consequence: **every action emits an event, and
 * every event is a potential trigger.**
 *
 * A rule whose action fires its own trigger is an infinite loop, and it is not
 * an exotic mistake — _when a card is updated, set a field_ is a plausible
 * thing for a person to build in a rule builder, and it runs forever.
 *
 * This module holds the two PURE layers, so they can be tested exhaustively
 * without a database. The other two are inherently stateful and live in
 * `repository.ts`: the durable per-org hourly budget, and the kill switch
 * (`enabled` plus `identity.orgs.status`).
 */

/**
 * The hard depth cap.
 *
 * Five is deliberately small. A legitimate chain — a card enters Done, which
 * posts to a channel, which notifies someone — is two or three hops; anything
 * past five is far more likely to be a cycle than a design. The cost of being
 * wrong is a recorded `depth_exceeded` run that a person can see and raise,
 * which is a much better failure than a queue that never drains.
 */
export const MAX_DEPTH = 5;

/**
 * Events an action of each type emits, for the self-trigger check.
 *
 * Hand-maintained and deliberately CONSERVATIVE: listing an event an action
 * does not actually emit costs a false refusal that shows up in run history
 * with a reason; MISSING one costs a loop the depth cap has to catch instead.
 * When in doubt, list it.
 *
 * This is a static approximation, not a proof — a service method may emit
 * events this table does not know, which is exactly why the depth cap is the
 * real control and this is the usability layer on top of it.
 */
/* Declared with ACTION-TYPE keys so adding an action without a map entry is a
   compile error — that exhaustiveness is the point. Looked up through a
   widened `string` view below, because the type this is indexed with at
   runtime comes from a jsonb column and may name an action a NEWER build
   wrote. TypeScript treats a total Record as always-present and would call the
   `?? []` dead code; it is not, and a rule from the future must not crash the
   engine for every rule behind it. */
const EVENTS_EMITTED_BY: Readonly<Record<AutomationAction['type'], readonly string[]>> = {
  'card.move': ['card.moved', 'card.updated', 'list.rebalanced'],
  'card.set_status': ['card.status_changed', 'card.updated'],
  'card.set_priority': ['card.updated'],
  'card.assign': ['card.assigned', 'card.updated'],
  'card.add_label': ['card.labeled', 'card.updated'],
  'card.remove_label': ['card.labeled', 'card.updated'],
  'card.unassign': ['card.assigned', 'card.updated'],
  'card.add_comment': ['comment.created', 'card.updated'],
  'chat.post_message': ['message.sent'],
  /* The enqueue emits this through the service layer, so a rule triggered by
     `webhook.delivery_queued` whose action calls a webhook would feed
     itself. Listed conservatively, per the header: the QUEUED event, not the
     eventual `webhook.delivery_queued` the loop might produce again — the
     loop itself writes no outbox event of this name. */
  call_webhook: ['webhook.delivery_queued'],
  /* Wave 4 — the cost-bearing actions emit through the telephony service
     layer exactly like a human's do, so a rule triggered by `call.placed` or
     `sms.sent` whose action places a call or sends an SMS would feed itself. */
  'call.place': ['call.placed', 'call.status_changed'],
  'sms.send': ['sms.sent'],
  /* Wave 4 slice 4 (§7.6). These are the OUTBOUND governance events the
     service emits after a confirmed provider success — deliberately NOT the
     inbound `integration.slack_event` / `integration.github_event` triggers.

     The distinction matters and is the whole reason this table is
     conservative. A rule "when a GitHub event arrives, post to Slack" does not
     self-trigger through this table, and it must not be made to: the loop it
     could form runs through the PROVIDER — our Slack post becomes a Slack
     `message` event that comes back in as `integration.slack_event`. Nothing
     in this process can see that hop, which is exactly what the depth counter
     is for. Listing the inbound names here would refuse the most obviously
     useful rule in the phase while stopping no real loop. */
  'slack.post_message': ['integration.message_posted'],
  'github.create_issue': ['integration.issue_created'],
  /* §8 — onboarding/offboarding automation. Each emits through the ordinary
     service layer exactly like every action above, so the same self-trigger
     reasoning applies: a rule triggered by one of these events whose own
     action would re-emit it is refused here rather than burning the depth
     budget. */
  'channel.add_member': ['channel.member_added'],
  'channel.remove_member': ['channel.member_removed'],
  'docs.grant_space_access': ['grant.created'],
  'identity.revoke_sessions': ['session.revoked'],
  'member_grant.revoke_all': ['member_grant.revoked'],
  'cards.bulk_reassign': ['card.bulk_reassigned'],
  /* §8 checklist item 1 — emits through the ordinary card-creation service
     layer exactly like every action above, so a rule triggered by
     `card.created` whose own action creates another card would feed itself. */
  'card.create': ['card.created'],
  /* §8 checklist item 3 — loops the real `memberGrants.grant`, which emits
     `member_grant.created` once per permission applied. Listed the same
     conservative way `cards.bulk_reassign` lists its own single event: the
     ACTION emits it, regardless of how many times the loop inside it runs. */
  'member_grant.apply_role_defaults': ['member_grant.created'],
};

export interface DepthVerdict {
  readonly allowed: boolean;
  readonly reason?: RunReason;
}

/**
 * Layer 1 — the depth cap.
 *
 * The counter rides on the event envelope, so an event produced by an action
 * carries its parent's depth plus one. This is the layer that stops the
 * TWO-RULE mutual cycle: rule A triggers B, B triggers A, and neither rule is
 * self-triggering, so no single-rule check can see it. Only a counter that
 * survives the hop can.
 */
export function checkDepth(depth: number): DepthVerdict {
  if (depth >= MAX_DEPTH) return { allowed: false, reason: 'depth_exceeded' };
  return { allowed: true };
}

/**
 * Layer 2 — static self-trigger refusal.
 *
 * A rule triggered by `card.updated` whose action emits `card.updated` would
 * re-trigger itself on every pass, burning the whole depth budget on one
 * user action and filling run history with noise. Refusing it outright is
 * both cheaper and far easier to explain than five recorded runs ending in
 * `depth_exceeded`.
 *
 * The check is on the RULE, not on a running chain, so it can also be applied
 * at save time — where it is a usability feature, telling the author
 * immediately rather than after their first confusing run.
 *
 * It is deliberately not the only defence: it cannot see a cycle spanning two
 * rules, and its event table is an approximation. `checkDepth` is what
 * actually guarantees termination.
 */
export function selfTriggers(rule: {
  readonly triggerEvent: string;
  readonly actions: readonly AutomationAction[];
}): boolean {
  return rule.actions.some((action) => eventsEmittedBy(action.type).includes(rule.triggerEvent));
}

/** Both pure layers, in the order they run. */
export function checkLoopProtection(rule: AutomationRule, depth: number): DepthVerdict {
  const byDepth = checkDepth(depth);
  if (!byDepth.allowed) return byDepth;

  if (selfTriggers(rule)) return { allowed: false, reason: 'self_trigger' };

  return { allowed: true };
}

/**
 * The events an action of this type is known to emit. Exported for the
 * save-time check.
 *
 * Takes a plain `string`, not `AutomationAction['type']`, because the value
 * reaching it comes from a jsonb column and may name an action this build has
 * never heard of. An unknown type emits nothing KNOWN, so it does not
 * self-trigger by this check — the depth cap is what still bounds it.
 */
export function eventsEmittedBy(type: string): readonly string[] {
  const table: Readonly<Record<string, readonly string[]>> = EVENTS_EMITTED_BY;
  return table[type] ?? [];
}
