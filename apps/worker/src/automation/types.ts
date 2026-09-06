import type { FilterNode } from '@taskflow/filter';
import type { OrgId, UserId } from '@taskflow/contracts';

/**
 * The automation engine's vocabulary (ai/phase-10-automation.md §1).
 *
 * Everything a rule can express lives in this file, and the closed-union shape
 * of `AutomationAction` is a security control rather than a typing preference:
 * PLAN.md §10.3 lists actions, never scripts, and there is deliberately no
 * variant here that evaluates a user-supplied string. A rule is data.
 */

/** One rule, as loaded from `platform.automations`. */
export interface AutomationRule {
  readonly id: string;
  readonly orgId: OrgId;
  readonly name: string;
  /** A registered domain event name — the trigger. */
  readonly triggerEvent: string;
  /** The condition tree, or null for "fire on every occurrence". */
  readonly condition: FilterNode | null;
  readonly actions: readonly AutomationAction[];
  readonly enabled: boolean;
  /**
   * Whose permissions the actions run with, re-resolved at EXECUTION (§2).
   * Never the person whose action triggered the rule — attributing a rule's
   * card move to whoever dragged the card would make the audit log say a person
   * did something they did not do.
   */
  readonly createdBy: UserId;
}

/**
 * The closed action union for Wave 1 — everything with no external effect and
 * no cost.
 *
 * Webhooks arrive in Wave 2, and `place call` / `send SMS` in Wave 4 behind an
 * off-by-default env flag and their own spend sub-budget (§5.5). The ordering
 * is deliberate: the engine and its loop protection get exercised on actions
 * that cannot cost anything or reach a network the org does not control.
 *
 * Every variant names a service method that already exists and the arguments it
 * takes. Adding one is a deliberate three-place change — here, in the executor,
 * and in the route's Zod schema — which is what keeps "a rule cannot do
 * something a user could not" checkable by reading three files.
 */
export type AutomationAction =
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
     org-registered webhook (never a URL), so the SSRF gate can live in the
     delivery loop instead of on the rule, and the enqueue itself is
     authorized as `webhook:manage` (§2). */
  | { readonly type: 'call_webhook'; readonly webhookId: string }
  /* Wave 4 — the cost-bearing actions (ai/phase-10-automation.md §5.5).

     Available only when the deployment enables them
     (AUTOMATION_TELEPHONY_ACTIONS_ENABLED, default OFF — the API refuses to
     even save a rule containing them while it is off), and they run through
     the SAME outbound gate a human's call runs through: geo table, org
     freeze, subaccount check, rolling cap, velocity limiter, and the
     automation SUB-budget. The ledger attributes their spend under
     `automation_call`/`automation_sms` kinds so a broken rule burns its own
     allowance and stops while the phone still works for people.

     A rule can never request recording: the union has no field for it, and
     the executor always passes `record: false`. */
  | { readonly type: 'call.place'; readonly to: string; readonly fromPhoneNumberId: string }
  | {
      readonly type: 'sms.send';
      readonly to: string;
      readonly fromPhoneNumberId: string;
      readonly body: string;
    }
  /* Wave 4 slice 4 (§7.6) — the outbound connector actions, and the first
     ones that act as the ORG on a platform this deployment does not run.

     Both name a connector ROW, never a URL and never a repository string — the
     `call_webhook` rule applied to a second provider. The GitHub repository is
     the row's own `provider_scope`, so a rule cannot open an issue on a repo
     the org never connected even though the stored token would usually reach
     it. Slack's `channel` IS a rule input, because a workspace has many
     channels and the connector is the workspace.

     Authorization is `integration:manage`, enforced at EXECUTION inside the
     service (the `enqueueWebhookDelivery` precedent) — a member who cannot
     manage integrations cannot write a rule that speaks as the org. */
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
  /* §8 (ai/phase-15-ai-copilot-and-permissions.md) — onboarding/offboarding
     automation. All six act on the member the TRIGGER named (`member.added`
     or `member.offboarding_started`'s own `userId`), the identical "this
     card" discipline `cardIdOf` already enforces for the card actions above
     — a rule cannot reach past the person its trigger fired for. */
  | { readonly type: 'channel.add_member'; readonly channelId: string }
  | { readonly type: 'channel.remove_member'; readonly channelId: string }
  /* Fixed at 'viewer' rather than a caller-supplied relation — an unattended
     rule handing out 'editor' or 'owner' on a Docs space is a bigger blast
     radius than "let the new hire read the handbook" needs. */
  | { readonly type: 'docs.grant_space_access'; readonly spaceId: string }
  | { readonly type: 'identity.revoke_sessions' }
  | { readonly type: 'member_grant.revoke_all' }
  | { readonly type: 'cards.bulk_reassign'; readonly toUserId: string };

/** Every action type, for the route's schema and the executor's exhaustiveness check. */
export const ACTION_TYPES = [
  'card.move',
  'card.set_status',
  'card.set_priority',
  'card.assign',
  'card.add_label',
  'card.remove_label',
  'card.unassign',
  'card.add_comment',
  'chat.post_message',
  'call_webhook',
  'call.place',
  'sms.send',
  'slack.post_message',
  'github.create_issue',
  'channel.add_member',
  'channel.remove_member',
  'docs.grant_space_access',
  'identity.revoke_sessions',
  'member_grant.revoke_all',
  'cards.bulk_reassign',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** What happened to one action, in order. Stored in `automation_runs.action_results`. */
export interface ActionResult {
  readonly index: number;
  readonly type: string;
  readonly status: 'succeeded' | 'failed';
  readonly error?: string;
}

/** Mirrors `automation_runs.status` — the CHECK in migration 0047. */
export type RunStatus = 'succeeded' | 'failed' | 'refused' | 'skipped';

/**
 * Why a run did not proceed.
 *
 * Recorded rather than inferred: "my rule did not fire" is the question the run
 * history exists to answer, and a row with no reason answers it no better than
 * no row at all.
 */
export type RunReason =
  | 'condition_not_met'
  | 'rule_disabled'
  | 'org_suspended'
  | 'depth_exceeded'
  | 'self_trigger'
  | 'budget_exhausted'
  | 'unauthorized'
  | 'condition_unusable'
  | 'trigger_not_evaluable';

/** One rule's outcome for one event — what gets written to `automation_runs`. */
export interface RunOutcome {
  readonly automationId: string;
  readonly status: RunStatus;
  readonly reason?: RunReason;
  readonly actionResults: readonly ActionResult[];
  readonly depth: number;
  readonly durationMs: number;
}

/**
 * Executes one rule's actions. Implemented in slice 4 against `apps/api`'s own
 * service layer; injected so the decision pipeline can be tested without any
 * of it, and so nothing can act while the loop protection is still under
 * review.
 *
 * The executor is responsible for authorizing each action as the RULE OWNER
 * (§2) — the engine decides WHETHER to run, the executor decides whether the
 * owner may do each thing, because only it knows what resource each action
 * names.
 */
export interface ActionExecutor {
  execute(input: {
    readonly rule: AutomationRule;
    readonly event: TriggerEvent;
    /** The depth the actions' own events must carry — this run's depth plus one. */
    readonly nextDepth: number;
  }): Promise<readonly ActionResult[]>;
}

/** The claimed outbox row, narrowed to what the engine reads. */
export interface TriggerEvent {
  readonly id: string;
  readonly orgId: OrgId;
  readonly name: string;
  readonly payload: Record<string, unknown>;
  /** Absent on a human-initiated event, which is depth 0 — the root of a chain. */
  readonly causationDepth: number;
}
