import type { DomainEvent } from '@taskflow/events';
import { hasAuditDatabase } from '@taskflow/db';
import { drainOutboxFully } from '@taskflow/api/audit';
import { defineSeedModule } from '../registry.js';
import { attachmentsModule } from './platform.attachments.js';
import { tuplesModule } from './authz.tuples.js';

/**
 * The outbox, and the real hash-chained audit log it drains into.
 *
 * Every other module in this package only BUFFERS events, through `ctx.emit`
 * — this is the one that writes them, and the only module in the graph with
 * no output any other module reads. Its `requires` exist purely to pull in
 * the whole rest of the tree, so it runs last and sees every buffered event
 * every other module produced.
 *
 * The two steps are deliberately separate rather than one bulk audit insert:
 * `seq`, `prev_hash` and `hash` are assigned by a Postgres trigger under a
 * per-org chain-head lock (CLAUDE.md), so hand-writing rows into
 * `audit.audit_log` here — even with correct-looking values — would produce a
 * chain nothing computed. Going through `drainOutboxFully`, the exact function
 * the real relay uses, is what makes the result a genuine, independently
 * verifiable chain rather than a fixture that resembles one.
 */

export interface AuditOutput {
  readonly outboxCount: number;
  readonly auditProcessed: number;
}

export const auditModule = defineSeedModule({
  name: 'platform.audit',
  requires: [attachmentsModule, tuplesModule],
  tables: ['platform.outbox'],

  async seed(ctx): Promise<AuditOutput> {
    const events = ctx.bufferedEvents();
    if (events.length === 0) {
      ctx.log('platform.audit: no buffered events.');
      return { outboxCount: 0, auditProcessed: 0 };
    }

    const byOrg = new Map<string, DomainEvent[]>();
    for (const event of events) {
      const list = byOrg.get(event.orgId) ?? [];
      list.push(event);
      byOrg.set(event.orgId, list);
    }

    for (const [orgId, orgEvents] of byOrg) {
      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'platform.outbox',
          [
            'id',
            'org_id',
            'name',
            'version',
            'actor_id',
            'occurred_at',
            'request_id',
            'payload::jsonb',
          ],
          orgEvents.map((event) => [
            event.id,
            event.orgId,
            event.name,
            event.version,
            event.actorId,
            new Date(event.occurredAt),
            event.requestId ?? null,
            event.payload,
          ]),
        );
      });
    }

    ctx.log(`platform.audit: wrote ${String(events.length)} events to the outbox`);

    if (!hasAuditDatabase()) {
      ctx.log(
        'platform.audit: DATABASE_AUDIT_URL not configured — outbox left undrained. ' +
          'Set it and re-run `pnpm seed`, or start the API, which drains it on its own timer.',
      );
      return { outboxCount: events.length, auditProcessed: 0 };
    }

    const result = await drainOutboxFully();
    ctx.log(
      `platform.audit: drained ${String(result.processed)} entries into the hash-chained log`,
    );

    return { outboxCount: events.length, auditProcessed: result.processed };
  },
});
