import {
  unsafeAsId,
  unsafeAsPhoneNumber,
  type CardId,
  type RequestId,
} from '@taskflow/contracts';
import { resolveOrgMembership } from '@taskflow/api/tenancy/resolve';
import * as cards from '@taskflow/api/work/cards';
import * as comments from '@taskflow/api/work/comments';
import * as labels from '@taskflow/api/work/labels';
import * as messages from '@taskflow/api/chat/messages';
import * as webhooks from '@taskflow/api/automation/webhooks';
import * as telephonyCalls from '@taskflow/api/telephony/call';
import * as telephonySms from '@taskflow/api/telephony/message';
import type { TelephonyDeps } from '@taskflow/api/telephony/deps';
import { RichTextDocument, type RichTextNode } from '@taskflow/api/richtext';
import type { WorkActor } from '@taskflow/api/work/shared';
/* `./chat/channel` is the existing map entry for `chat/shared.ts` — reused
   rather than adding a second alias to the same file, which would be two names
   for one module and a coin-flip about which one the next reader greps for. */
import type { ChatActor } from '@taskflow/api/chat/channel';
import type { ActionExecutor, ActionResult, AutomationAction, TriggerEvent } from './types.js';

/**
 * Executing a rule's actions (ai/phase-10-automation.md §1.3, §2).
 *
 * ⚠ The most security-relevant file in this phase. Two properties carry it, and
 * both are easy to lose by writing the obvious thing.
 *
 * ## 1. Actions run through the SERVICE LAYER, never against tables
 *
 * Every branch below calls the same exported service function a tRPC route
 * calls. That is what makes an automation's card move produce the same domain
 * event, audit entry, realtime broadcast, notification and search re-index a
 * human's card move produces — for free, and impossible to forget, because
 * there is no other path available from here. The worker holds no privileged
 * database access: it opens `withOrgScope` as `taskflow_app` exactly as the API
 * does, under the same RLS.
 *
 * ## 2. The actor is the RULE OWNER, re-resolved at EXECUTION
 *
 * `resolveOrgMembership(rule.createdBy, rule.orgId)` runs on every single
 * execution and returns null when that person's membership is gone, inactive,
 * or their org is suspended. So:
 *
 *   - a rule written by someone who has since been demoted acts with their
 *     CURRENT permissions, not the ones they had at save time;
 *   - a rule written by someone who has left the org stops working entirely;
 *   - a member who cannot delete cards cannot write a rule that deletes cards,
 *     because the service's own `enforceOn` sees a subject with their role.
 *
 * The alternative — authorize once at save time, then run as system — is
 * simpler, faster, and turns every stored rule into a privilege that outlives
 * its author. A stored rule is a credential that never expires unless something
 * re-checks it, and this function is that something.
 *
 * The actor is NOT the person whose action triggered the rule. Attributing an
 * automation's card move to whoever dragged the card into Done would make the
 * audit log assert that a person did something they did not do.
 */

/**
 * A synthetic request id for automation-initiated work.
 *
 * Every envelope needs one, and there is no HTTP request here. Deriving it from
 * the TRIGGERING EVENT's id rather than minting a fresh one means every event
 * an automation emits can be traced back to the event that caused it with a
 * single query — the closest thing to a causation chain the current schema
 * offers, and it costs nothing.
 */
function requestIdFor(event: TriggerEvent): RequestId {
  return unsafeAsId<'RequestId'>(event.id);
}

export interface ExecutorDeps {
  /**
   * Re-resolves the rule owner's membership. Injectable so the authorization
   * behaviour can be tested without standing up a whole identity fixture —
   * never to bypass it.
   */
  readonly resolveMembership?: typeof resolveOrgMembership;
  /**
   * Wave 4 (§5.5) — the telephony deps the cost-bearing actions run through.
   * Built in `main.ts` from the same env subset the API validates, so a rule's
   * call passes the identical `checkOutboundAllowed` chokepoint a human's
   * does. Absent when the flag is off, or when no carrier is configured.
   */
  readonly telephony?: TelephonyDeps;
  /**
   * Wave 4 (§5.5) — the execution-time half of the env flag. The API refuses
   * to SAVE a rule containing a telephony action while it is off; this second
   * gate refuses to RUN one, so a rule saved while the flag was on stops the
   * moment the deployment turns it off — with a recorded reason, not a
   * silence. Default false matches the env default.
   */
  readonly telephonyActionsEnabled?: boolean;
}

export function createActionExecutor(deps: ExecutorDeps = {}): ActionExecutor {
  const resolveMembership = deps.resolveMembership ?? resolveOrgMembership;

  return {
    async execute({ rule, event, nextDepth }) {
      /* THE authorization step. Re-resolved every execution — see §2 in the
         file header. A null membership means the owner was removed, deactivated
         or their org suspended, and the rule simply stops. */
      const membership = await resolveMembership(rule.createdBy, rule.orgId);
      if (membership === null) {
        return rule.actions.map((action, index) => ({
          index,
          type: action.type,
          status: 'failed' as const,
          error: 'the rule owner is no longer an active member of this organization',
        }));
      }

      const actor: WorkActor & ChatActor = {
        subject: {
          orgId: membership.orgId,
          userId: rule.createdBy,
          /* From the LIVE membership row, never from anything stored on the
             rule. This is the line that makes a demotion take effect
             immediately rather than when something happens to be rewritten. */
          role: membership.role,
          tuples: membership.tuples,
        },
        requestId: requestIdFor(event),
        /* What makes the chain terminate. Every event these actions emit
           carries this, so the next hop sees a higher number and the engine's
           depth cap eventually refuses. */
        causationDepth: nextDepth,
      };

      const results: ActionResult[] = [];

      for (const [index, action] of rule.actions.entries()) {
        try {
          await runAction(actor, action, event, deps);
          results.push({ index, type: action.type, status: 'succeeded' });
        } catch (error) {
          results.push({
            index,
            type: action.type,
            status: 'failed',
            error: error instanceof Error ? error.message : 'unknown error',
          });
          /* STOP at the first failure (§9 decision 6). Continuing would apply
             a rule half-way with no record of intent, and retrying the whole
             rule later would re-run the actions that already succeeded — which
             is how one flaky action produces four card moves. */
          break;
        }
      }

      return results;
    },
  };
}

/**
 * Dispatches one action to its service function.
 *
 * The `switch` is exhaustive over the closed union, so adding an action type
 * without handling it is a compile error rather than a silent no-op.
 */
async function runAction(
  actor: WorkActor & ChatActor,
  action: AutomationAction,
  event: TriggerEvent,
  deps: ExecutorDeps,
): Promise<void> {
  switch (action.type) {
    case 'card.move': {
      /* Neighbours are null: "append to the end of the target list". A rule has
         no drag position, and inventing one from the event would be a rank
         computed from a board read at an unrelated moment — the exact staleness
         `cards.move` takes neighbours to avoid. */
      await cards.moveCard(actor, {
        cardId: cardIdOf(event),
        targetListId: unsafeAsId<'ListId'>(action.listId),
        beforeCardId: null,
        afterCardId: null,
      });
      return;
    }

    case 'card.set_status': {
      await cards.setCardStatus(actor, {
        cardId: cardIdOf(event),
        statusId: unsafeAsId<'StatusId'>(action.statusId),
      });
      return;
    }

    case 'card.set_priority': {
      /* `updateCard` is a FULL REPLACE — the trap CLAUDE.md documents for the
         web client, where "take the row, change one field, send it" erases a
         description per rename. The same trap exists here and is worse,
         because nobody is watching. So the card is read first and every other
         field is passed back unchanged, including the version the optimistic
         check needs. */
      const cardId = cardIdOf(event);
      const current = await cards.getCard(actor, { cardId });

      await cards.updateCard(actor, {
        cardId,
        version: current.version,
        title: current.title,
        description: descriptionOf(current.description),
        dueDate: current.dueDate,
        startDate: current.startDate,
        priority: action.priority as typeof current.priority,
      });
      return;
    }

    case 'card.assign': {
      /* ADDITIVE. `assignCard` replaces the whole array, so assigning without
         reading first would silently unassign everyone else on the card — a
         rule that "adds an assignee" removing three people is exactly the kind
         of quiet damage an unattended actor should not be able to do. */
      const cardId = cardIdOf(event);
      const current = await cards.getCard(actor, { cardId });
      const existing = current.assigneeIds.map((id) => unsafeAsId<'UserId'>(id));
      const addition = unsafeAsId<'UserId'>(action.userId);

      if (existing.includes(addition)) return;

      await cards.assignCard(actor, { cardId, assigneeIds: [...existing, addition] });
      return;
    }

    case 'card.add_label': {
      /* Additive, for the identical reason as `card.assign`: `setCardLabels`
         is a full replace. */
      const cardId = cardIdOf(event);
      const current = await labels.listCardLabels(actor, { cardId });
      const existing = current.map((label) => unsafeAsId<'LabelId'>(label.labelId));
      const addition = unsafeAsId<'LabelId'>(action.labelId);

      if (existing.includes(addition)) return;

      await labels.setCardLabels(actor, { cardId, labelIds: [...existing, addition] });
      return;
    }

    case 'card.remove_label': {
      /* The mirror of `card.add_label` above, with the same full-replace
         discipline: read first, subtract one, write the rest back. A target
         the card does not carry is a no-op rather than an error — the rule
         asked for a state the card is already in. */
      const cardId = cardIdOf(event);
      const current = await labels.listCardLabels(actor, { cardId });
      const existing = current.map((label) => unsafeAsId<'LabelId'>(label.labelId));
      const removal = unsafeAsId<'LabelId'>(action.labelId);

      if (!existing.includes(removal)) return;

      await labels.setCardLabels(actor, {
        cardId,
        labelIds: existing.filter((id) => id !== removal),
      });
      return;
    }

    case 'card.unassign': {
      /* The mirror of `card.assign`: remove ONE person from the set, reading
         the current assignees first so nobody else is touched. Assigning
         without the read would clear the card; removing without it would be
         the same damage in reverse. */
      const cardId = cardIdOf(event);
      const current = await cards.getCard(actor, { cardId });
      const existing = current.assigneeIds.map((id) => unsafeAsId<'UserId'>(id));
      const removal = unsafeAsId<'UserId'>(action.userId);

      if (!existing.includes(removal)) return;

      await cards.assignCard(actor, {
        cardId,
        assigneeIds: existing.filter((id) => id !== removal),
      });
      return;
    }

    case 'card.add_comment': {
      await comments.createComment(actor, {
        cardId: cardIdOf(event),
        body: plainParagraph(action.body),
      });
      return;
    }

    case 'chat.post_message': {
      /* A plain paragraph. The body is stored TEXT on the rule and is turned
         into the TipTap document shape here rather than letting a rule store
         arbitrary rich-text JSON — which would be a user-supplied document
         reaching `sendMessage`'s validator from a stored column instead of from
         a request, with no reason to allow it (§8 point 2: a rule is data, not
         a document). */
      await messages.sendMessage(actor, {
        channelId: unsafeAsId<'ChannelId'>(action.channelId),
        body: plainParagraph(action.body),
      });
      return;
    }

    case 'call_webhook': {
      /* Wave 2 — the first action that reaches a network the org does not
         control. The ENQUEUE goes through the service layer like every other
         action (same outbox, same audit, same loop-protection event), and the
         enqueue itself enforces `webhook:manage` against the rule owner's
         live permissions (§2) — a member who cannot manage webhooks cannot
         write a rule that calls them. The actual HTTP delivery happens later,
         in this same process, by the delivery loop, with the SSRF gate
         applied per redirect hop. */
      await webhooks.enqueueWebhookDelivery(actor, {
        webhookId: action.webhookId,
        event: { id: event.id, name: event.name, payload: event.payload },
      });
      return;
    }

    case 'call.place': {
      /* Wave 4 (§5.5) — the cost-bearing actions, behind the flag and through
         the SAME service function the click-to-call route calls. That service
         runs the full gate — geo, org freeze, subaccount, rolling cap,
         velocity, and the automation sub-budget — and records the ledger row
         under the `automation_call` kind in the same transaction. `record` is
         always false: a rule cannot ask to record a person, and the union has
         no field that would let it. */
      const telephony = telephonyFor(deps);
      await telephonyCalls.placeCall(
        actor,
        telephony,
        {
          to: unsafeAsPhoneNumber(action.to),
          fromPhoneNumberId: action.fromPhoneNumberId,
          record: false,
        },
        { initiatedBy: 'automation' },
      );
      return;
    }

    case 'sms.send': {
      /* Wave 4 (§5.5) — the SMS twin of `call.place` above: the same service
         function a human's SMS uses, the same gate, the ledger under
         `automation_sms`. The suppression list (§8.5) is checked first inside
         the service, exactly as it is for a human send — an opt-out is a legal
         fact, and a rule must not be able to message someone who asked to
         stop. */
      const telephony = telephonyFor(deps);
      await telephonySms.sendSms(
        actor,
        telephony,
        {
          to: unsafeAsPhoneNumber(action.to),
          fromPhoneNumberId: action.fromPhoneNumberId,
          body: action.body,
        },
        { initiatedBy: 'automation' },
      );
      return;
    }
  }
}

/**
 * The telephony deps for one cost-bearing action — or the reason it fails.
 *
 * Two distinct refusals, both recorded as failed actions in run history rather
 * than thrown somewhere silent:
 *
 *   - the flag is OFF: the deployment has chosen not to have these actions,
 *     so this rule predates the current configuration. This is the case that
 *     must never silently pass — a rule saved while the flag was on must stop
 *     the moment it is turned off;
 *   - the flag is on but no carrier is configured: a valid deployment with
 *     telephony simply absent, the API's own SERVICE_UNAVAILABLE case. The
 *     action fails loudly here so the rule's author sees why.
 *
 * Neither refusal reaches the carrier, so neither can cost anything.
 */
function telephonyFor(deps: ExecutorDeps): TelephonyDeps {
  if (deps.telephonyActionsEnabled !== true) {
    throw new Error(
      'telephony automation actions are disabled on this instance (AUTOMATION_TELEPHONY_ACTIONS_ENABLED is off)',
    );
  }
  if (deps.telephony === undefined) {
    throw new Error('telephony is not configured on this instance');
  }
  return deps.telephony;
}

/**
 * The one document shape a rule may say: a single plain-text paragraph.
 *
 * Both text-carrying actions (`chat.post_message` and `card.add_comment`)
 * store TEXT on the rule and get their TipTap document here, so there is
 * exactly one place that turns stored rule text into a document — a
 * user-supplied document can never reach a validator from a stored column.
 */
function plainParagraph(text: string): RichTextNode {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/**
 * Re-validates a card's stored description before handing it back to
 * `updateCard`.
 *
 * `CardDetail.description` is `unknown` — it is a jsonb column read straight
 * back out — and `updateCard` wants a `RichTextNode`. An `as` cast would
 * compile and would be an unchecked claim about a value that came from a
 * database rather than from a parser, which is exactly what
 * `exactOptionalPropertyTypes` and this codebase's "no `any`" posture exist to
 * discourage.
 *
 * Parsing it costs one validation of a document this action is not even
 * changing, and buys the guarantee that an automation can never be the thing
 * that writes an invalid document back. A description that does not parse fails
 * the ACTION, with a message, rather than being quietly re-written.
 */
function descriptionOf(stored: unknown): RichTextNode | null {
  if (stored === null || stored === undefined) return null;

  const parsed = RichTextDocument.safeParse(stored);
  if (!parsed.success) {
    throw new Error("this card's description is not valid rich text, so it cannot be rewritten");
  }
  return parsed.data;
}

/**
 * The card an action operates on — always the one the trigger named.
 *
 * A rule cannot name a DIFFERENT card than the event that fired it, and that is
 * a deliberate limit rather than an oversight: an action carrying its own card
 * id would let one rule reach across an org's whole board set, and every such
 * reach would still have to be authorized per card anyway. "This card" keeps
 * the blast radius of a rule equal to the blast radius of its trigger.
 */
function cardIdOf(event: TriggerEvent): CardId {
  const cardId = event.payload['cardId'];
  if (typeof cardId !== 'string') {
    throw new Error(`${event.name} carries no cardId, so this action has nothing to act on`);
  }
  return unsafeAsId<'CardId'>(cardId);
}
