import { and, asc, desc, eq, gt, or, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { PAGE_DEFAULT, decodeNameKeyCursor, encodeNameKeyCursor } from './pagination.js';
import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { createEvent, findEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { can, type Subject } from '@taskflow/policy';
import { FilterTree, resourceForTrigger, validate, type FilterNode } from '@taskflow/filter';
import { automationCreated, automationDeleted, automationUpdated } from './events.js';
import { translatingConstraints } from '../work/shared.js';

/**
 * Automation rule management (ai/phase-10-automation.md §1, §2).
 *
 * The ENGINE is in `apps/worker`; this is the surface that creates, edits and
 * disables the rules it runs. The split matters: a route in this process can
 * take an authenticated request and can never execute anything, and the worker
 * can execute and never takes a request.
 *
 * ## Authorization here is about the RULE, not about what it does
 *
 * `automation:manage` governs writing rules — it is org-level, so a
 * relationship tuple cannot satisfy it (§9 decision 4). Whether a rule may
 * MOVE A CARD is a different question, asked at execution against the rule
 * owner's live permissions by the worker's executor (§2). Neither check
 * substitutes for the other, and collapsing them would either let a member
 * write rules or let an admin's rule act with more than the admin has.
 *
 * ## Two things are refused at SAVE time that could only be refused at run time
 *
 * Both are usability rather than security — the engine refuses them again
 * anyway — and both exist because a rule that is accepted and then never works
 * is much worse than one rejected while its author is still looking at it:
 *
 *   - a trigger naming an event no build registers, which would simply never
 *     fire (`assertTriggerRegistered`);
 *   - a self-triggering rule, which would burn the depth budget on every user
 *     action and fill run history with refusals (`assertNotSelfTriggering`).
 */

export interface AutomationActor {
  readonly subject: Subject;
  readonly requestId: RequestId;
}

export interface AutomationSummary {
  readonly automationId: string;
  readonly name: string;
  readonly description: string | null;
  readonly triggerEvent: string;
  readonly condition: FilterNode | null;
  readonly actions: readonly unknown[];
  readonly enabled: boolean;
  readonly createdBy: string;
  /** True when the stored condition no longer parses — see `parseStoredCondition`. */
  readonly conditionBroken: boolean;
}

export interface AutomationInput {
  readonly name: string;
  readonly description: string | null;
  readonly triggerEvent: string;
  readonly condition: FilterNode | null;
  readonly actions: readonly AutomationActionInput[];
  readonly enabled: boolean;
}

/**
 * The action shapes a rule may store.
 *
 * Kept structurally identical to the worker's own `AutomationAction` union and
 * deliberately NOT imported from it: `apps/api` must not depend on
 * `apps/worker`, and the route's Zod schema is the boundary that decides what
 * may be written. The executor's exhaustive `switch` is what fails loudly if
 * the two ever drift — a stored action it does not know is a compile error
 * there, not a silent no-op here.
 */
export type AutomationActionInput =
  | { readonly type: 'card.move'; readonly listId: string }
  | { readonly type: 'card.set_status'; readonly statusId: string }
  | { readonly type: 'card.set_priority'; readonly priority: string }
  | { readonly type: 'card.assign'; readonly userId: string }
  | { readonly type: 'card.add_label'; readonly labelId: string }
  | { readonly type: 'card.remove_label'; readonly labelId: string }
  | { readonly type: 'card.unassign'; readonly userId: string }
  | { readonly type: 'card.add_comment'; readonly body: string }
  | { readonly type: 'chat.post_message'; readonly channelId: string; readonly body: string }
  /* Wave 2 — the first action with an external effect. It names an
     org-registered webhook (never a URL), so the SSRF gate lives in the
     delivery loop instead of on the rule, and the enqueue itself is
     authorized as `webhook:manage` (§2). */
  | { readonly type: 'call_webhook'; readonly webhookId: string }
  /* Wave 4 — the cost-bearing actions (§5.5). Reachable only when the
     deployment enables them: the router's schema refuses to SAVE a rule
     containing one while AUTOMATION_TELEPHONY_ACTIONS_ENABLED is off, and the
     worker's executor refuses to RUN one. No `record` field — a rule must
     never be able to start recording a person. */
  | { readonly type: 'call.place'; readonly to: string; readonly fromPhoneNumberId: string }
  | {
      readonly type: 'sms.send';
      readonly to: string;
      readonly fromPhoneNumberId: string;
      readonly body: string;
    }
  /* Wave 4 slice 4 (§7.6) — the outbound connector actions. Both name a
     connector ROW rather than a URL or a repository string; the GitHub
     repository is the row's own scope, read by the service. */
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
    }
  /* §8 — onboarding/offboarding automation. See the worker's own
     AutomationAction union for why all six act on the trigger's own member
     and carry no `userId` of their own. */
  | { readonly type: 'channel.add_member'; readonly channelId: string }
  | { readonly type: 'channel.remove_member'; readonly channelId: string }
  | { readonly type: 'docs.grant_space_access'; readonly spaceId: string }
  | { readonly type: 'identity.revoke_sessions' }
  | { readonly type: 'member_grant.revoke_all' }
  | { readonly type: 'cards.bulk_reassign'; readonly toUserId: string }
  /* §8 checklist item 1 — see the worker's own `AutomationAction` for the
     full reasoning (a plain `createCard`, no template/cloning concept). */
  | { readonly type: 'card.create'; readonly listId: string; readonly title: string };

/**
 * Events an action emits, for the save-time self-trigger check.
 *
 * A deliberate SECOND copy of the worker's own table, and the duplication is
 * the lesser evil: the alternative is `apps/api` importing from `apps/worker`,
 * which inverts the dependency direction every other module in this repo
 * follows. The engine's copy is the one that actually protects the system —
 * this one only makes the refusal happen earlier, where a person can read it.
 * If they drift, a rule gets accepted here and refused there, with a recorded
 * reason: annoying, and not dangerous.
 */
const EVENTS_EMITTED_BY: Readonly<Record<string, readonly string[]>> = {
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
     `webhook.delivery_queued` whose action calls a webhook would feed itself. */
  call_webhook: ['webhook.delivery_queued'],
  /* Wave 4 — a call's lifecycle is a first-class event stream. Conservative
     per the header: the events `placeCall` actually emits plus the status
     transitions its own actions can provoke. */
  'call.place': ['call.placed', 'call.status_changed'],
  'sms.send': ['sms.sent'],
  /* Wave 4 slice 4 (§7.6) — the OUTBOUND governance events, deliberately not
     the inbound connector triggers. A loop through a provider (our Slack post
     coming back as a Slack event) is invisible to this process and is what the
     depth counter exists for; listing the inbound names here would refuse
     "post to Slack when something happens in GitHub" — the most useful rule in
     the phase — while stopping no real loop. The worker's copy of this table
     carries the same reasoning. */
  'slack.post_message': ['integration.message_posted'],
  'github.create_issue': ['integration.issue_created'],
  'channel.add_member': ['channel.member_added'],
  'channel.remove_member': ['channel.member_removed'],
  'docs.grant_space_access': ['grant.created'],
  'identity.revoke_sessions': ['session.revoked'],
  'member_grant.revoke_all': ['member_grant.revoked'],
  'cards.bulk_reassign': ['card.bulk_reassigned'],
  'card.create': ['card.created'],
};

const orgOf = (actor: AutomationActor): OrgId => actor.subject.orgId;
const userOf = (actor: AutomationActor): UserId => actor.subject.userId;

const envelopeOf = (actor: AutomationActor) => ({
  orgId: actor.subject.orgId,
  actorId: actor.subject.userId,
  requestId: actor.requestId,
});

/** Every rule in the org. Reading them is `automation:manage` too — see §2. */
export async function listAutomations(
  actor: AutomationActor,
  cursor: string | null = null,
  limit: number = PAGE_DEFAULT,
): Promise<{
  readonly automations: readonly AutomationSummary[];
  readonly nextCursor: string | null;
}> {
  const decoded = cursor === null ? null : decodeNameKeyCursor(cursor);

  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        automationId: schema.automations.id,
        name: schema.automations.name,
        description: schema.automations.description,
        triggerEvent: schema.automations.triggerEvent,
        condition: schema.automations.condition,
        actions: schema.automations.actions,
        enabled: schema.automations.enabled,
        createdBy: schema.automations.createdBy,
      })
      .from(schema.automations)
      .where(
        and(
          eq(schema.automations.orgId, orgOf(actor)),
          /* Resume after the cursor: `(name, id) > (cursor.name, cursor.id)`,
             written as plain operators because raw `sql` is banned here. */
          ...(decoded === null
            ? []
            : [
                or(
                  gt(schema.automations.name, decoded.name),
                  and(
                    eq(schema.automations.name, decoded.name),
                    gt(schema.automations.id, decoded.id),
                  ),
                ),
              ]),
        ),
      )
      .orderBy(asc(schema.automations.name), asc(schema.automations.id))
      // One extra row answers "is there a next page" without a COUNT.
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      automations: page.map((row) => {
        const parsed = parseStoredCondition(row.triggerEvent, row.condition);
        return {
          ...row,
          condition: parsed.condition,
          conditionBroken: parsed.broken,
          actions: Array.isArray(row.actions) ? (row.actions as readonly unknown[]) : [],
        };
      }),
      nextCursor:
        hasMore && last !== undefined
          ? encodeNameKeyCursor({ name: last.name, id: last.automationId })
          : null,
    };
  });
}

export async function createAutomation(
  actor: AutomationActor,
  input: AutomationInput,
): Promise<{ readonly automationId: string }> {
  const automationId = newId();
  const orgId = orgOf(actor);

  assertTriggerRegistered(input.triggerEvent);
  assertConditionUsable(input.triggerEvent, input.condition);
  assertNotSelfTriggering(input);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        await tx.insert(schema.automations).values({
          id: automationId,
          orgId,
          name: input.name,
          description: input.description,
          triggerEvent: input.triggerEvent,
          condition: input.condition,
          actions: [...input.actions],
          enabled: input.enabled,
          /* Whose permissions this rule will act with, forever, re-resolved on
             every execution by the worker (§2). Recorded here and never
             changed by an edit — see `updateAutomation`. */
          createdBy: userOf(actor),
        });

        await outboxWriter.append(tx, [
          createEvent(
            automationCreated,
            {
              automationId,
              name: input.name,
              triggerEvent: input.triggerEvent,
              enabled: input.enabled,
              actionCount: input.actions.length,
            },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('An automation with that name already exists.'),
  );

  return { automationId };
}

export async function updateAutomation(
  actor: AutomationActor,
  input: AutomationInput & { readonly automationId: string },
): Promise<{ readonly name: string }> {
  const orgId = orgOf(actor);

  assertTriggerRegistered(input.triggerEvent);
  assertConditionUsable(input.triggerEvent, input.condition);
  assertNotSelfTriggering(input);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const existing = await loadAutomation(tx, input.automationId);

        await tx
          .update(schema.automations)
          .set({
            name: input.name,
            description: input.description,
            triggerEvent: input.triggerEvent,
            condition: input.condition,
            actions: [...input.actions],
            enabled: input.enabled,
            updatedAt: new Date(),
            /* `createdBy` is deliberately NOT updated. It is the rule's
               OWNERSHIP — whose permissions it acts with — and letting an edit
               move it would turn "edit this rule" into "re-point this rule at
               my own, possibly higher, privileges", which is a privilege
               escalation wearing the shape of a rename. An admin who wants a
               rule to run as themselves creates one. */
          })
          .where(eq(schema.automations.id, input.automationId));

        await outboxWriter.append(tx, [
          createEvent(
            automationUpdated,
            {
              automationId: input.automationId,
              name: input.name,
              triggerEvent: input.triggerEvent,
              wasEnabled: existing.enabled,
              enabled: input.enabled,
              actionCount: input.actions.length,
            },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('An automation with that name already exists.'),
  );

  return { name: input.name };
}

/**
 * The kill switch's per-rule half (§4, layer 4).
 *
 * Its own method rather than a field on `update`, because "stop this rule now"
 * is what someone does in a hurry when a rule is misbehaving — and making that
 * require sending back a complete, valid rule body would mean the emergency
 * path runs the full validation gauntlet, including checks that could refuse
 * the very rule they are trying to stop.
 */
export async function setAutomationEnabled(
  actor: AutomationActor,
  input: { readonly automationId: string; readonly enabled: boolean },
): Promise<{ readonly enabled: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const existing = await loadAutomation(tx, input.automationId);

    await tx
      .update(schema.automations)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(eq(schema.automations.id, input.automationId));

    await outboxWriter.append(tx, [
      createEvent(
        automationUpdated,
        {
          automationId: input.automationId,
          name: existing.name,
          triggerEvent: existing.triggerEvent,
          wasEnabled: existing.enabled,
          enabled: input.enabled,
          actionCount: existing.actionCount,
        },
        envelopeOf(actor),
      ),
    ]);

    return { enabled: input.enabled };
  });
}

export async function deleteAutomation(
  actor: AutomationActor,
  input: { readonly automationId: string },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const existing = await loadAutomation(tx, input.automationId);

    /* A real delete. The run history goes with it by the composite FK's
       cascade, and that is the right trade: runs are operational telemetry
       about a rule that no longer exists, and the ACTIONS those runs performed
       are already in the audit log, which this does not touch. */
    await tx.delete(schema.automations).where(eq(schema.automations.id, input.automationId));

    await outboxWriter.append(tx, [
      createEvent(
        automationDeleted,
        { automationId: input.automationId, name: existing.name },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const };
  });
}

export interface AutomationRunSummary {
  readonly runId: string;
  readonly automationId: string;
  readonly triggerEvent: string;
  readonly status: string;
  readonly reason: string | null;
  readonly actionResults: readonly unknown[];
  readonly depth: number;
  readonly durationMs: number | null;
  readonly createdAt: Date;
}

/**
 * The org tier of the run-history UI (§9 decision 8).
 *
 * Scoped by RLS to this org and nothing else — an admin has no vocabulary here
 * for asking about another tenant's runs, which is deliberate: the platform
 * tier is a separate surface reading a separate scope, never this screen with a
 * filter.
 */
export async function listAutomationRuns(
  actor: AutomationActor,
  input: { readonly automationId?: string; readonly limit: number },
): Promise<readonly AutomationRunSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const scope =
      input.automationId === undefined
        ? eq(schema.automationRuns.orgId, orgOf(actor))
        : and(
            eq(schema.automationRuns.orgId, orgOf(actor)),
            eq(schema.automationRuns.automationId, input.automationId),
          );

    const rows = await tx
      .select({
        runId: schema.automationRuns.id,
        automationId: schema.automationRuns.automationId,
        triggerEvent: schema.automationRuns.triggerEvent,
        status: schema.automationRuns.status,
        reason: schema.automationRuns.reason,
        actionResults: schema.automationRuns.actionResults,
        depth: schema.automationRuns.depth,
        durationMs: schema.automationRuns.durationMs,
        createdAt: schema.automationRuns.createdAt,
      })
      .from(schema.automationRuns)
      .where(scope)
      .orderBy(desc(schema.automationRuns.createdAt))
      .limit(input.limit);

    return rows.map((row) => ({
      ...row,
      actionResults: Array.isArray(row.actionResults)
        ? (row.actionResults as readonly unknown[])
        : [],
    }));
  });
}

/* -------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

interface AutomationRow {
  readonly name: string;
  readonly triggerEvent: string;
  readonly enabled: boolean;
  readonly actionCount: number;
}

async function loadAutomation(tx: Tx, automationId: string): Promise<AutomationRow> {
  const rows = await tx
    .select({
      name: schema.automations.name,
      triggerEvent: schema.automations.triggerEvent,
      enabled: schema.automations.enabled,
      actions: schema.automations.actions,
    })
    .from(schema.automations)
    .where(eq(schema.automations.id, automationId))
    .limit(1);

  const row = rows[0];
  if (!row) throw errors.notFound();

  return {
    name: row.name,
    triggerEvent: row.triggerEvent,
    enabled: row.enabled,
    actionCount: Array.isArray(row.actions) ? row.actions.length : 1,
  };
}

/**
 * Refuses a trigger no build registers.
 *
 * Checked against the LIVE registry rather than a CHECK constraint, because a
 * constraint would be a second copy of the event catalog that drifts every time
 * a slice adds an event — and the drift's failure mode is a rule that saves
 * cleanly and never fires, which is silent and indistinguishable from a
 * condition that never matches.
 */
function assertTriggerRegistered(triggerEvent: string): void {
  if (findEvent(triggerEvent) === undefined) {
    throw errors.validation(
      { triggerEvent: [`"${triggerEvent}" is not an event this system emits.`] },
      'That trigger does not exist.',
    );
  }
}

/**
 * Refuses a condition that would be stored only to read back broken.
 *
 * A condition naming a field its trigger's field set does not have would parse,
 * store, and then be refused at every execution with `condition_unusable` —
 * failing here is the honest moment, while the author is still looking at what
 * they built.
 *
 * ## Which field set, and why it comes from the TRIGGER
 *
 * `resourceForTrigger` (ai/phase-10-automation.md §7.8b). Most triggers name a
 * card and are evaluated against the card row the engine re-reads; the two
 * connector triggers carry no card at all and are evaluated against the event's
 * own `provider_event` / `provider_scope`. The two sets are closed and do NOT
 * overlap, so this is a real refusal and not a formality: `status = X` on a
 * GitHub rule is a condition nothing could ever satisfy.
 *
 * Deriving it from the trigger rather than storing it on the rule is the point.
 * A flag on the row could be edited independently of the trigger, and then a
 * rule saved under one reading would evaluate under another — changing what it
 * means without anybody touching the condition.
 */
function assertConditionUsable(triggerEvent: string, condition: FilterNode | null): void {
  if (condition === null) return;

  const shape = FilterTree.safeParse(condition);
  if (!shape.success) {
    throw errors.validation({ condition: ['That condition is not a valid filter.'] });
  }

  const result = validate(resourceForTrigger(triggerEvent), shape.data);
  if (result.ok) return;

  throw errors.validation(
    { condition: result.errors.map((error) => error.message) },
    'That condition is not valid.',
  );
}

/**
 * Refuses a rule whose own actions would re-trigger it.
 *
 * The engine refuses this too, so this is not the control — it is the
 * difference between an author being told immediately and an author finding
 * five `depth_exceeded` runs in their history and having to work out why.
 */
function assertNotSelfTriggering(input: {
  readonly triggerEvent: string;
  readonly actions: readonly AutomationActionInput[];
}): void {
  const loops = input.actions.some((action) =>
    (EVENTS_EMITTED_BY[action.type] ?? []).includes(input.triggerEvent),
  );
  if (!loops) return;

  throw errors.validation(
    {
      actions: [
        `An action here emits "${input.triggerEvent}", which is this rule's own trigger — ` +
          'it would run itself in a loop.',
      ],
    },
    'That rule would trigger itself.',
  );
}

/**
 * Same argument as `view.service.ts`'s `parseStoredFilter`: a column is not a
 * parser.
 *
 * Takes the trigger for the same reason `assertConditionUsable` does — the row
 * holds both, and validating a connector rule's condition against the CARD set
 * would report every one of them as broken in the list. The bug that would
 * cause is not cosmetic: `conditionBroken` is what the UI shows as a warning
 * and what an author would act on by deleting a condition that was fine.
 */
function parseStoredCondition(
  triggerEvent: string,
  stored: unknown,
): {
  readonly condition: FilterNode | null;
  readonly broken: boolean;
} {
  if (stored === null || stored === undefined) return { condition: null, broken: false };

  const parsed = FilterTree.safeParse(stored);
  if (!parsed.success) return { condition: null, broken: true };

  return validate(resourceForTrigger(triggerEvent), parsed.data).ok
    ? { condition: parsed.data, broken: false }
    : { condition: null, broken: true };
}

/** Exported for the route's `can()` pre-check documentation — see the router. */
export function mayManageAutomations(subject: Subject): boolean {
  return can(subject, 'automation:manage').allowed;
}
