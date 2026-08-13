import {
  claimPending,
  insertAuditEntry,
  markDispatched,
  withAuditScope,
  type OutboxRow,
} from '@taskflow/db';

/**
 * The audit projection — outbox in, hash-chained log out (PLAN.md §8.6, §10.6).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): this is the only writer of the compliance
 * record.
 *
 * ## Exactly-once, not at-least-once
 *
 * Claiming events, writing their audit entries, and marking them published all
 * happen in ONE transaction as `taskflow_audit`. That is why this consumer does
 * not need to be idempotent, and it is the reason the relay and the audit
 * writer are the same role in this phase: a crash mid-batch rolls back the
 * audit rows along with the claim, so the next run redoes the whole batch and
 * duplicates nothing.
 *
 * Consumers added later — notifications, realtime, search, automation — do NOT
 * get this property, and as of migration 0015 they no longer SHARE this one's
 * bookkeeping either: each claims and marks its own rows in `outbox_dispatch`
 * under its own consumer name, so one falling behind or erroring never
 * starves another. They will be dispatched by pg-boss after their own commit
 * and must be idempotent, which is the normal outbox contract. Audit is
 * treated differently because a duplicated audit entry is not a cosmetic
 * problem: it breaks the hash chain's meaning, since the chain would then
 * attest to something that happened once as though it happened twice.
 *
 * ## Where this will live
 *
 * In `apps/worker`, on a pg-boss schedule, once that app exists (Phase 4). It
 * is here now because the outbox has real traffic from Phase 2 and an audit log
 * that nothing writes to is not a control. `drainOutbox` takes no ambient state
 * so moving it is a change of caller, not of code.
 */

/**
 * How a domain event names the thing it happened to.
 *
 * An explicit table rather than guessing from the payload. Inferring "the first
 * key ending in Id" would work for most events and quietly mis-attribute the
 * ones where it does not — `member.added` carries both a membershipId and a
 * userId, and an audit trail that attributes a role change to the wrong subject
 * is worse than one that attributes it to nothing.
 *
 * Exported, with `NEVER_AUDITED`, for `audit.projection.test.ts` alone. A phase
 * that registers an event and forgets this table writes audit entries with no
 * subject at all, and nothing fails to say so — which is what happened to all
 * nine Docs events, and to the twenty-five that test's `UNMAPPED` records.
 */
export const RESOURCE_OF: Readonly<Record<string, { type: string; key: string }>> = {
  /* People (Phase 11.5). All three resolve to `member` keyed on `userId`,
     matching `member.role_changed` above: the subject of the entry is the
     account, and "what has this account been called / who did they report
     to" is the question a reader of an old entry has when a name or an org
     chart no longer matches anyone. `profile.updated` replaces the retired
     `user.display_name_changed` entry this block used to hold. */
  'profile.updated': { type: 'member', key: 'userId' },
  'membership_profile.updated': { type: 'member', key: 'userId' },
  'reporting_line.changed': { type: 'member', key: 'userId' },

  'org.created': { type: 'org', key: 'orgId' },
  'org.updated': { type: 'org', key: 'orgId' },
  'member.added': { type: 'member', key: 'userId' },
  'member.role_changed': { type: 'member', key: 'userId' },
  'member.removed': { type: 'member', key: 'userId' },
  /* Phase 12 Wave 1. The handoff resolves to the ORG — the fact being
     recorded is "this org changed owners", and the org is what an access
     review asks about. */
  'member.ownership_transferred': { type: 'org', key: 'orgId' },
  'team.created': { type: 'team', key: 'teamId' },
  'team.member_added': { type: 'team', key: 'teamId' },
  'team.member_removed': { type: 'team', key: 'teamId' },
  'grant.created': { type: 'member', key: 'subjectId' },
  'grant.revoked': { type: 'member', key: 'subjectId' },

  /* Work (Phase 3). Lists resolve to their BOARD, matching the authorization
     model: there is no `list` resource type, because a list is not
     independently grantable and no tuple can point at one. An audit entry
     naming a resource type the policy engine has never heard of would be
     unusable by the permission debug endpoint that reads the same vocabulary. */
  'project.created': { type: 'project', key: 'projectId' },
  'project.updated': { type: 'project', key: 'projectId' },
  'project.archived': { type: 'project', key: 'projectId' },
  'board.created': { type: 'board', key: 'boardId' },
  'board.updated': { type: 'board', key: 'boardId' },
  'board.archived': { type: 'board', key: 'boardId' },
  'list.created': { type: 'board', key: 'boardId' },
  'list.updated': { type: 'board', key: 'boardId' },
  'list.reordered': { type: 'board', key: 'boardId' },
  'list.archived': { type: 'board', key: 'boardId' },
  'list.rebalanced': { type: 'board', key: 'boardId' },
  'card.created': { type: 'card', key: 'cardId' },
  'card.updated': { type: 'card', key: 'cardId' },
  'card.moved': { type: 'card', key: 'cardId' },
  'card.assigned': { type: 'card', key: 'cardId' },
  'card.archived': { type: 'card', key: 'cardId' },

  /* Sprints (Phase 10.5, migration 0054) resolve to their PROJECT, on exactly
     the reasoning `list.*` resolves to its board: there is no `sprint`
     resource type, because a sprint is not independently grantable — nobody
     shares one iteration of a project's plan — so the resource an entry names
     is the thing a grant could actually name. Every one of these payloads
     carries `projectId`, which is what makes the key honest rather than
     convenient.

     `card.sprint_changed` is the exception and resolves to the CARD, like
     every other per-card event: the fact recorded is "this card's membership
     changed", and its payload carries no `projectId` to key on anyway. */
  'sprint.created': { type: 'project', key: 'projectId' },
  'sprint.started': { type: 'project', key: 'projectId' },
  'sprint.completed': { type: 'project', key: 'projectId' },
  'sprint.cancelled': { type: 'project', key: 'projectId' },
  'sprint.updated': { type: 'project', key: 'projectId' },
  'card.sprint_changed': { type: 'card', key: 'cardId' },

  /* Card detail. Labels and custom field DEFINITIONS resolve to their project,
     because that is what they belong to and what a grant could name; the
     per-card events resolve to the card. Checklists and their items have no
     resource type of their own for the same reason lists do not — nobody shares
     one checklist — so they resolve to the card that owns them. */
  'label.created': { type: 'project', key: 'projectId' },
  'label.updated': { type: 'project', key: 'projectId' },
  'label.deleted': { type: 'project', key: 'projectId' },
  'card.labeled': { type: 'card', key: 'cardId' },
  'checklist.created': { type: 'card', key: 'cardId' },
  'checklist.deleted': { type: 'card', key: 'cardId' },
  'checklist_item.created': { type: 'card', key: 'cardId' },
  'checklist_item.updated': { type: 'card', key: 'cardId' },
  'checklist_item.deleted': { type: 'card', key: 'cardId' },
  'custom_field.created': { type: 'project', key: 'projectId' },
  'custom_field.updated': { type: 'project', key: 'projectId' },
  'custom_field.archived': { type: 'project', key: 'projectId' },
  'card.field_set': { type: 'card', key: 'cardId' },
  'comment.created': { type: 'comment', key: 'commentId' },
  'comment.updated': { type: 'comment', key: 'commentId' },
  'comment.deleted': { type: 'comment', key: 'commentId' },

  /* Chat (Phase 5). Membership changes resolve to the CHANNEL rather than to
     the member, which is the opposite of what `member.added` does one section
     up — and the difference is what a reader of the audit log is looking for.
     An org membership change is a fact about a PERSON ("what happened to this
     account?"); a channel membership change is a fact about a private space
     ("who has had access to this conversation, and when?"). Resolving these to
     the user would scatter one channel's access history across as many resource
     ids as it has members, which is precisely the query an access review needs
     to be able to run.

     Messages resolve to the message, not the channel, for the ordinary reason
     `card.moved` resolves to the card: the compliance record should name the
     thing that changed. */
  'channel.created': { type: 'channel', key: 'channelId' },
  'channel.updated': { type: 'channel', key: 'channelId' },
  'channel.archived': { type: 'channel', key: 'channelId' },
  'channel.member_added': { type: 'channel', key: 'channelId' },
  'channel.member_removed': { type: 'channel', key: 'channelId' },
  'message.sent': { type: 'message', key: 'messageId' },
  'message.edited': { type: 'message', key: 'messageId' },
  'message.deleted': { type: 'message', key: 'messageId' },

  /* Wave 3 — file sharing and link previews.

     The attachment events resolve to the ATTACHMENT, not the message: "who
     downloaded which file" is the question an incident asks, and attributing it
     to the message would collapse every file in a thread into one resource id.
     `message.unfurled` resolves to the message, because that is the thing that
     changed. */
  'message_attachment.presigned': { type: 'attachment', key: 'attachmentId' },
  'message_attachment.uploaded': { type: 'attachment', key: 'attachmentId' },
  'message_attachment.rejected': { type: 'attachment', key: 'attachmentId' },
  'message_attachment.downloaded': { type: 'attachment', key: 'attachmentId' },
  'message_attachment.deleted': { type: 'attachment', key: 'attachmentId' },
  'message.unfurled': { type: 'message', key: 'messageId' },
  'message.attachments_changed': { type: 'message', key: 'messageId' },

  /* Wave 4 — retention, legal hold, guests, export.

     All resolve to the CHANNEL rather than to the message or the person, and
     for the reason the membership events above give: these are facts about a
     space and its governance. "What was the retention history of this channel,
     and who held or exported it" is one query against one resource id, which is
     exactly what a compliance review needs. `legal_hold.changed` resolves to
     the channel even when it names a single message, so a per-message hold and
     a channel-wide one appear in the same history. */
  'channel.retention_changed': { type: 'channel', key: 'channelId' },
  'legal_hold.changed': { type: 'channel', key: 'channelId' },
  'channel.guest_changed': { type: 'channel', key: 'channelId' },
  'compliance.exported': { type: 'channel', key: 'channelId' },
  'message.reaction_added': { type: 'message', key: 'messageId' },
  'message.reaction_removed': { type: 'message', key: 'messageId' },
  'message.pinned': { type: 'message', key: 'messageId' },
  'message.unpinned': { type: 'message', key: 'messageId' },

  /* `channel.read_advanced` is deliberately ABSENT from this table. It is
     never looked up here because it never reaches `insertAuditEntry` at all
     — see `NEVER_AUDITED` below, which is where the exclusion actually
     happens. */

  /* Docs (Phase 6). Pages resolve to the PAGE and spaces to the SPACE, which is
     the ordinary "name the thing that changed" rule — and both are real entries
     in `RESOURCE_TYPES`, so a tuple can point at either and the permission debug
     endpoint reads the same vocabulary back.

     `page.siblings_rebalanced` is the one that does not follow it, for the
     reason `list.rebalanced` resolves to its board rather than to a card: the
     event is a fact about a CONTAINER whose children were rewritten, and it
     carries no single page id to name. It resolves to the space rather than to
     the parent page because `parentPageId` is null for a rebalance among a
     space's root pages — keying on it would drop `resource_id` to null for
     exactly the rows at the top of the tree, where the blast radius is largest.

     `page.version_saved` and `page.version_restored` resolve to the page, not
     to the version: a version is not independently grantable, so it has no
     resource type, and `versionId` travels in the payload where a reader can
     still see which save point was involved.

     `page.suggestion_created`/`page.suggestion_decided` resolve to the PAGE,
     not to a `suggestion` type — mirroring `page.version_saved` above,
     there is no independently grantable `suggestion` resource in
     `RESOURCE_TYPES` (§8.2's precedent: "no list resource type,
     deliberately" — a suggestion is not independently shareable either),
     and `suggestionId` is still in the payload for a reader to see. Comments
     DO resolve to `comment` — Work's `comment.*` already established that
     type for card comments, and Docs' comments are the same kind of
     resource under a different container. `page.content_updated` has no
     entry here at all — see `NEVER_AUDITED` below. */
  'space.created': { type: 'space', key: 'spaceId' },
  'space.archived': { type: 'space', key: 'spaceId' },
  'page.created': { type: 'page', key: 'pageId' },
  'page.moved': { type: 'page', key: 'pageId' },
  'page.updated': { type: 'page', key: 'pageId' },
  'page.archived': { type: 'page', key: 'pageId' },
  'page.siblings_rebalanced': { type: 'space', key: 'spaceId' },
  'page.version_saved': { type: 'page', key: 'pageId' },
  'page.version_restored': { type: 'page', key: 'pageId' },
  'page.comment_created': { type: 'comment', key: 'commentId' },
  'page.comment_updated': { type: 'comment', key: 'commentId' },
  'page.comment_resolved': { type: 'comment', key: 'commentId' },
  'page.comment_deleted': { type: 'comment', key: 'commentId' },
  'page.suggestion_created': { type: 'page', key: 'pageId' },
  'page.suggestion_decided': { type: 'page', key: 'pageId' },
  /* Wave 4. `page.template_created`/`page.template_deleted` resolve to the
     SPACE, mirroring `page.siblings_rebalanced` above — a template is the
     space's vocabulary, not an independently grantable resource, and
     `templateId` stays in the payload for a reader to see. */
  'page.published': { type: 'page', key: 'pageId' },
  'page.template_created': { type: 'space', key: 'spaceId' },
  'page.template_deleted': { type: 'space', key: 'spaceId' },

  /* Automation (Phase 10 Wave 1). MAPPED rather than ledgered as unmapped,
     unlike `view.*` and the saved-search events, and the difference is that
     `automation` is a real entry in RESOURCE_TYPES — so the audit row can name
     the rule it is about, and "show me everything that happened to this rule"
     is a query somebody will actually run after a rule misbehaves.

     These record changes to the RULES, never what the rules did. A rule's
     executions live in `platform.automation_runs` (operational telemetry, its
     own retention), and the ACTIONS those runs performed appear in this log
     under their own resources, written by the service layer the executor
     calls — so a card an automation moved is an ordinary `card.moved` entry
     whose actor is the rule's owner. */
  'automation.created': { type: 'automation', key: 'automationId' },
  'automation.updated': { type: 'automation', key: 'automationId' },
  'automation.deleted': { type: 'automation', key: 'automationId' },

  /* Billing & org lifecycle (Phase 12 Wave 3). All six resolve to the ORG —
     every one of them is a fact about the org's subscription state, which is
     exactly what an Owner reviewing their own audit log would ask about, and
     none names an independently grantable resource of its own. Distinct from
     `platform.*`'s billing-adjacent events (Wave 1's `org_suspended`/
     `org_reactivated`): those run as `taskflow_platform_admin` with no outbox
     grant and reach `platform.operator_audit_log` instead — these six run as
     the ordinary app role inside `withOrgScope` and reach this consumer like
     any other tenant event. */
  'billing.trial_started': { type: 'org', key: 'orgId' },
  'billing.subscription_activated': { type: 'org', key: 'orgId' },
  'billing.payment_failed': { type: 'org', key: 'orgId' },
  'billing.org_suspended_for_nonpayment': { type: 'org', key: 'orgId' },
  'billing.subscription_canceled': { type: 'org', key: 'orgId' },
  'billing.grace_extended': { type: 'org', key: 'orgId' },

  /* Connectors (Phase 10 Wave 4, §7.8). MAPPED for the same reason the
     automation events are: `integration` has been a real entry in
     RESOURCE_TYPES (and the tuples object_type CHECK) since 0005, and "show
     me everything that happened to this connector" is a query an access
     review will actually run. These record changes to the CONNECTION, never
     what it carried — the outbound actions those connectors enable are
     ordinary `chat.message`/`issue.*` work recorded under their own
     resources by the service layer. */
  'integration.connected': { type: 'integration', key: 'integrationId' },
  'integration.disconnected': { type: 'integration', key: 'integrationId' },
  /* The credential-stored-but-no-repo-yet fact — the ONLY record of a GitHub
     connect the person abandons at the picker. Same resource as the other
     two: the connector row itself, which is exactly what it names. */
  'integration.pending': { type: 'integration', key: 'integrationId' },
  /* The OUTBOUND effects (§7.6's own header, above `integrationMessagePosted`
     in integration-events.ts): what this deployment did to a provider under a
     rule, as opposed to what a provider told us. These carry `integrationId`
     and resolve to the connector for the identical reason the connection
     lifecycle events above do — "show me everything this connector did" is
     the same query as "show me everything that happened to it". The inbound
     triggers these actions are keyed off of (`integration.slack_event`,
     `integration.github_event`) are NOT mapped here — see NEVER_AUDITED. */
  'integration.message_posted': { type: 'integration', key: 'integrationId' },
  'integration.issue_created': { type: 'integration', key: 'integrationId' },
};

/**
 * Events that reach this consumer and are claimed/marked exactly like any
 * other, but must never become an `audit.audit_log` row (ai/phase-5-chat.md
 * §3.6; migration 0018's header comment).
 *
 * `channel.read_advanced` fires on ordinary scrolling — the highest-frequency
 * write this phase introduces — and "user read up to message X" is not a
 * compliance-relevant fact at the volume it will actually see. Excluding it
 * here rather than not emitting it at all keeps guardrail 11 satisfied (every
 * state-mutating service method still emits a typed event, so the outbox
 * still drives unread-badge sync and any future consumer) while keeping the
 * append-only, hash-chained log free of a write nobody will ever audit.
 *
 * `page.content_updated` (Wave 3) is the identical shape: it fires from the
 * backlinks relay every time it folds a NEW `docs.page_versions` row —
 * including compaction's own periodic 'autosave' rows — into
 * `docs.backlinks`, which is exactly as frequent as live editing itself.
 * "This page's content changed, again" is not a compliance-relevant fact at
 * that volume, and the two events that ARE (`page.updated` for a title
 * rename, `page.version_saved` for an explicit on-demand save) already have
 * their own real `RESOURCE_OF` entries above.
 */
export const NEVER_AUDITED: ReadonlySet<string> = new Set([
  'channel.read_advanced',
  'page.content_updated',
  /* Every platform-admin event (Phase 12 Wave 1 §3.8, Wave 2 §3.1).
     Different reason from the two above, same outcome: these never reach
     THIS consumer at all. They publish through the system `EventBus`
     (SYSTEM_ORG's own mechanism, apps/api/src/identity/identity.service.ts)
     rather than `outboxWriter.append`, because the mutations run as
     `taskflow_platform_admin` — a role holding no grant on `platform.outbox`
     — and because a global fact has no target org for the outbox's
     `NOT NULL REFERENCES identity.orgs` to point at.

     "Never audited" names this projection's path, not accountability. Every
     one of these IS recorded: `platform.operator_audit_log` for all of them,
     and the two org events additionally write the TARGET ORG's own
     `audit.audit_log` chain directly from `org-directory.service.ts`, so an
     Owner sees "a platform operator suspended this org" without operator
     access. The user events have no such second chain on purpose — a person
     may belong to several orgs or none, so there is no single tenant chain
     to pick (see `platform-admin/events.ts` on `userSuspended`).

     Listed explicitly so the registered-event accounting test in
     `audit.projection.test.ts` has a real answer here rather than reading as
     an oversight — which is exactly what it WAS until Phase 12 Wave 2: that
     test never imported `platform-admin/events.js`, so none of these were
     ever actually checked by it. */
  'platform.org_suspended',
  'platform.org_reactivated',
  /* §3.5 (Phase 12 Wave 2). Same reason and then some: the org is GONE — its
     outbox rows deleted with it, and no outbox entry can name a row that no
     longer exists. The one durable record is the `orgs.delete` operator-log
     entry, and the published event carries the SYSTEM_ORG envelope (see
     events.ts on orgDeleted). */
  'platform.org_deleted',
  'platform.operator_granted',
  'platform.flag_override_set',
  'platform.flag_override_cleared',
  'platform.user_suspended',
  'platform.user_reactivated',
  /* Phase 10 Wave 4's inbound connector triggers (§7.5, integration-events.ts's
     own header on `connectorTriggerPayload`). One fires for every Slack
     workspace event or GitHub repository event a connected integration
     receives — the same high-frequency shape as `channel.read_advanced` and
     `page.content_updated` above, not a decision an access review would ever
     query for. They carry no `integrationId`, only `providerScope` (a team_id
     or repository full_name, not a UUID), so there is no resource for
     RESOURCE_OF to name even if the volume argument did not already settle
     it. The compliance-relevant half of a connector doing something is the
     OUTBOUND effect it triggers — `integration.message_posted` /
     `integration.issue_created`, both mapped above — which is what an access
     review actually needs to trace a rule's action back to its owner. */
  'integration.slack_event',
  'integration.github_event',
]);

interface Resource {
  readonly type: string | null;
  readonly id: string | null;
}

/** UUID shape, so a payload field that is not an id never lands in `resource_id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resourceOf(row: OutboxRow): Resource {
  const mapping = RESOURCE_OF[row.name];
  if (!mapping) return { type: null, id: null };

  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return { type: mapping.type, id: null };

  const value = (payload as Record<string, unknown>)[mapping.key];
  if (typeof value !== 'string' || !UUID.test(value)) return { type: mapping.type, id: null };

  return { type: mapping.type, id: value };
}

/**
 * This consumer's name in `outbox_dispatch` (migration 0015). Fixed and
 * never derived from anything the caller supplies — a wrong value here would
 * silently start a NEW, empty backlog under a different name rather than
 * failing, since `outbox_dispatch` has no registry of valid consumer names
 * to reject an unrecognized one against.
 */
const CONSUMER = 'audit';

export interface DrainResult {
  readonly processed: number;
}

/**
 * Moves one batch from the outbox into the audit log.
 *
 * Returns how many were processed, so a caller can loop until the backlog is
 * empty without this function owning a scheduling policy.
 */
export async function drainOutbox(limit = 100): Promise<DrainResult> {
  return withAuditScope(async (tx) => {
    const pending = await claimPending(tx, CONSUMER, limit);
    if (pending.length === 0) return { processed: 0 };

    /**
     * ONE LOCK ORDER, or two drainers deadlock.
     *
     * `audit.chain_entry()` takes a per-org lock on `audit.chain_heads` for
     * every entry — and its FIRST statement is an `INSERT ... ON CONFLICT
     * (org_id) DO NOTHING`, which has to wait on any transaction that has
     * already touched that head row before it can know whether the conflict
     * is real. A claimed batch is ordered by `occurred_at`, so it walks the
     * orgs in whatever order the events happened to interleave, and two
     * drainers claim DISJOINT batches whose org sequences are unrelated. One
     * ends up holding org A's head and waiting on org B's while the other
     * holds B and waits on A, and Postgres kills one of them:
     *
     *   deadlock detected (40P01)
     *   while inserting index tuple in relation "chain_heads"
     *
     * The relay survives that — a failed tick retries on the next one — but a
     * `pnpm seed` run beside a running API does not, and it dies partway
     * through with drizzle reporting only the statement, never the 40P01.
     * That is the whole bug: two audit projections is a SUPPORTED
     * configuration (a second API instance is the point of `SKIP LOCKED` in
     * `claimPending`), and it was never a safe one.
     *
     * Sorting by org gives every writer the same acquisition order, which is
     * what makes a cycle impossible rather than merely unlikely. The sort is
     * STABLE, so each org's own entries keep their `occurred_at` order — the
     * only ordering the chain actually encodes, since `seq` and `prev_hash`
     * are per-org. Cross-org order was never meaningful and is not preserved.
     *
     * A retry loop was the alternative and is the wrong one: it treats a
     * deadlock as bad luck when it is a fixed property of the lock order, so
     * it would fire on essentially every concurrent batch and turn a
     * correctness bug into a throughput one.
     */
    /* A plain code-unit comparison, never `localeCompare`: the ordering has to
       be identical in every process that writes audit entries, and
       `localeCompare` answers according to the runtime's ICU locale. Two API
       instances started with different `LANG` values would sort two org ids
       differently and reintroduce exactly the cycle this prevents — a
       deadlock that reappears only on the machine whose locale disagrees. */
    const ordered = [...pending].sort((left, right) =>
      left.orgId < right.orgId ? -1 : left.orgId > right.orgId ? 1 : 0,
    );

    for (const row of ordered) {
      if (NEVER_AUDITED.has(row.name)) continue;

      const resource = resourceOf(row);

      /* `id` is the EVENT's id, reused as the audit entry's id. One event
         produces one entry, so sharing the identifier makes "which event is
         this entry?" answerable by equality rather than by correlation — and
         makes a double insert a primary key violation rather than a silent
         duplicate.

         seq, prev_hash and hash are absent: the trigger assigns all three under
         the chain-head lock, which is what stops a writer choosing its own
         position in the chain. */
      await insertAuditEntry(tx, {
        id: row.id,
        orgId: row.orgId,
        occurredAt: row.occurredAt,
        actorId: row.actorId,
        action: row.name,
        resourceType: resource.type,
        resourceId: resource.id,
        changes: row.payload,
        requestId: row.requestId,
      });
    }

    await markDispatched(
      tx,
      CONSUMER,
      pending.map((row) => row.id),
    );

    return { processed: pending.length };
  });
}

/**
 * Drains until the backlog is empty.
 *
 * Bounded by `maxBatches` rather than looping until clear. An unbounded drain
 * competing with live traffic is a job that never returns, and the caller — a
 * scheduled tick — would then never run its next iteration.
 */
export async function drainOutboxFully(batchSize = 100, maxBatches = 50): Promise<DrainResult> {
  let processed = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await drainOutbox(batchSize);
    processed += result.processed;
    if (result.processed < batchSize) break;
  }

  return { processed };
}
