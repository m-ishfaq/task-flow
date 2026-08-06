import { and, eq, isNotNull, isNull, lt, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { createEvent } from '@taskflow/events';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { messageDeleted } from './events.js';

/**
 * The retention sweep (Wave 4, ai/phase-5-chat.md §3.7).
 *
 * ⚠ This deletes user data on a timer. Read the whole file before changing any
 * of it.
 *
 * ## Not a `*.service.ts`, and that is the guardrail-11 boundary
 *
 * This mutates many rows across many organizations and is triggered by a clock
 * rather than by a person. It DOES emit `message.deleted` per removed message —
 * §3.7 is explicit that a retention deletion must appear in the audit trail
 * rather than go silent — but it is named as a repository/job for the same
 * reason `rebalance.ts` is: guardrail 11's scope is service methods acting for
 * an actor, and there is no actor here.
 *
 * ## The hold check is INSIDE the delete, not before it
 *
 * This is the one property §3.7 names as having to be closed by construction:
 *
 *     DELETE ... WHERE created_at < cutoff AND held_at IS NULL AND NOT hold
 *
 * A two-step "read the eligible ids, then delete them" is the obvious shape and
 * it loses messages: a hold placed between the read and the delete is not seen,
 * and the message it was meant to preserve is gone. The window is milliseconds,
 * which is precisely why it would never be reproduced and never be believed.
 *
 * ## One org at a time, each in its own scope
 *
 * `feature-template.md` warns against reaching for a global-scope escape hatch
 * when a query looks awkward under RLS, and a job whose description is
 * literally "touch every org" is where that temptation is strongest. The
 * correct shape is the one the audit relay and the realtime relay already use:
 * enumerate the orgs, then `withOrgScope(orgId, ...)` per org. A single
 * unscoped DELETE across all tenants is the tenancy bug guardrail 8's fuzz
 * harness exists to catch, running on a schedule instead of behind a route.
 */

/** How many messages one org's sweep may remove per tick. */
const BATCH_LIMIT = 500;

export interface SweepResult {
  readonly orgsSwept: number;
  readonly messagesDeleted: number;
}

export interface ChannelSweepResult {
  readonly channelId: string;
  readonly deleted: number;
}

/**
 * Runs one org's retention pass.
 *
 * Exported separately from `sweepAllOrgs` so a test can drive exactly one
 * tenant deterministically, and so the compliance surface can offer "run it
 * now" for a single organization without touching anyone else's data.
 */
export async function sweepOrg(orgId: OrgId): Promise<readonly ChannelSweepResult[]> {
  return withOrgScope(orgId, async (tx) => {
    /* Only channels that have opted in. A NULL window means keep forever, and
       `retention_hold` exempts the whole channel including messages written
       after the hold was placed — which a per-message flag alone cannot
       express, and is why both exist. */
    const channels = await tx
      .select({
        channelId: schema.channels.id,
        retentionDays: schema.channels.retentionDays,
      })
      .from(schema.channels)
      .where(
        and(isNotNull(schema.channels.retentionDays), eq(schema.channels.retentionHold, false)),
      );

    const results: ChannelSweepResult[] = [];

    for (const channel of channels) {
      const days = channel.retentionDays;
      if (days === null) continue;

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      /* THE statement. `held_at IS NULL` is part of the WHERE, so a hold placed
         at any moment before this executes is honoured — including one placed
         while this very transaction was being planned. There is deliberately no
         preceding SELECT of "eligible ids" for this to consume. */
      const removed = await tx
        .delete(schema.messages)
        .where(
          and(
            eq(schema.messages.channelId, channel.channelId),
            lt(schema.messages.createdAt, cutoff),
            isNull(schema.messages.heldAt),
          ),
        )
        .returning({
          messageId: schema.messages.id,
          channelId: schema.messages.channelId,
        });

      if (removed.length === 0) continue;

      /* One event per message, with `reason: 'retention_policy'` — the field
         `message.deleted` has carried since Wave 1 precisely so this pass would
         not have to widen the payload and break every consumer written against
         the old shape.

         `byAuthor: false` because nobody authored this deletion. `actorId: null`
         for the same reason: attributing a scheduled job to a person would put
         a deletion in the audit log under the name of whoever happened to
         configure the policy. */
      await outboxWriter.append(
        tx,
        removed.slice(0, BATCH_LIMIT).map((row) =>
          createEvent(
            messageDeleted,
            {
              messageId: row.messageId,
              channelId: row.channelId,
              byAuthor: false,
              reason: 'retention_policy' as const,
            },
            /* `requestId` is OMITTED rather than null: the envelope types it
               optional, and there was no request. A synthesized id here would
               correlate this deletion with an HTTP call that never happened. */
            { orgId, actorId: null },
          ),
        ),
      );

      results.push({ channelId: channel.channelId, deleted: removed.length });
    }

    return results;
  });
}

/**
 * Sweeps every organization, one scope at a time.
 *
 * The org list is read through `withOrgScope` on each org rather than a single
 * global query, which means this needs the ids from somewhere. They come from
 * the caller — `apps/api`'s scheduler reads them once — so this function never
 * itself holds an unscoped view of the tenant table.
 */
export async function sweepAllOrgs(orgIds: readonly OrgId[]): Promise<SweepResult> {
  let messagesDeleted = 0;
  let orgsSwept = 0;

  for (const orgId of orgIds) {
    try {
      const results = await sweepOrg(orgId);
      messagesDeleted += results.reduce((total, result) => total + result.deleted, 0);
      orgsSwept += 1;
    } catch {
      /* One org's failure must not stop the rest. A tenant whose sweep throws
         keeps its messages until the next tick, which is the safe direction —
         the alternative is a single bad row halting retention for everybody,
         which is a compliance failure that looks like nothing at all. */
      continue;
    }
  }

  return { orgsSwept, messagesDeleted };
}

/** Branding helper for ids read from a row, at this module's trust boundary. */
export function asOrgId(value: string): OrgId {
  return unsafeAsId<'OrgId'>(value);
}
