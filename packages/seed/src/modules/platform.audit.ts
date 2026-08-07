import type { DomainEvent } from '@taskflow/events';
import { hasAuditDatabase } from '@taskflow/db';
import { drainOutboxFully } from '@taskflow/api/audit';
import { defineSeedModule } from '../registry.js';
import { attachmentsModule } from './platform.attachments.js';
import { tuplesModule } from './authz.tuples.js';
import { viewsModule } from './work.views.js';
import { contentModule } from './docs.content.js';
import { commentsModule } from './docs.comments.js';
import { suggestionsModule } from './docs.suggestions.js';

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
  /* Nothing reads `work.views`', `docs.content`'s, `docs.comments`' or
     `docs.suggestions`' output, so they are named here rather than somewhere
     more meaningful — this module's `requires` is what pulls the whole graph
     in, and a module no other module depends on has to be reached from the
     root or it silently never runs. `docs.content` reaches `docs.spaces`
     through its own `requires`, and `docs.comments`/`docs.suggestions` each
     reach both `docs.spaces` and `docs.content` through theirs. */
  requires: [
    attachmentsModule,
    tuplesModule,
    viewsModule,
    contentModule,
    commentsModule,
    suggestionsModule,
  ],
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

    /**
     * Sized to what this run actually wrote, not left at the default.
     *
     * `drainOutboxFully`'s defaults are 100 × 50 batches — a ceiling of 5,000,
     * and deliberately bounded, because in the API it is a scheduled tick and
     * "an unbounded drain competing with live traffic is a job that never
     * returns". A seed run is the opposite situation: it knows exactly how many
     * events it just buffered, there is no live traffic to yield to, and it is
     * finished the moment the backlog is clear.
     *
     * Leaving the default here would silently truncate. Adding Chat took the
     * demo profile past five thousand events, and the symptom was not an error
     * but a smaller number in the line below — a hash-chained log missing its
     * last few dozen entries, reported as success. The loop still exits early
     * on the first short batch, so the extra allowance costs one empty claim.
     */
    const batchSize = 100;
    const batches = Math.ceil(events.length / batchSize) + 1;

    const result = await drainOutboxFully(batchSize, batches);
    ctx.log(
      `platform.audit: drained ${String(result.processed)} entries into the hash-chained log`,
    );

    return { outboxCount: events.length, auditProcessed: result.processed };
  },
});
