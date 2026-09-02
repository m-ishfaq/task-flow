import { z } from 'zod';
import { withOrgScope, schema, countRows, maxColumn, countFiltered, eq } from '@taskflow/db';
import { route, router } from '../trpc/builder.js';
import {
  queryVelocity,
  queryBurndown,
  queryCfd,
  queryCycleTime,
  queryWorkload,
  queryVolume,
} from './dashboard.service.js';
import { backfillSyntheticCreationRows } from './backfill.js';
import { pruneOutbox } from './prune.js';
import { spendReport } from '../telephony/spend-report.service.js';

/**
 * Analytics router (Phase 11, ai/phase-11-analytics.md §3, §5).
 *
 * `analytics:read` is Admin-and-Owner only (§7 decision 4). Every dashboard
 * aggregates ACROSS boards, so a member who cannot read board X must not learn
 * X's throughput from a chart. The org-level permission is answered by ROLE
 * ALONE (§5), so `route({ permission: 'analytics:read' })` IS the whole
 * decision at this layer — no per-resource `can()` follows.
 */

const dateRangeInput = z
  .object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
  })
  .strict();

export function createAnalyticsRouter() {
  return router({
    /**
     * §3.1 — Velocity: cards entering done per day.
     */
    velocity: route({
      permission: 'analytics:read',
      quotaClass: 'expensive',
    })
      .input(
        dateRangeInput.extend({
          boardId: z.string().uuid().optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            date: z.string(),
            count: z.number().int(),
          }),
        ),
      )
      .query(async ({ ctx, input }) => {
        const points = await queryVelocity(ctx.principal.org.orgId, {
          startDate: input.startDate,
          endDate: input.endDate,
          ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
        });
        return points.map((p) => ({ date: p.date, count: p.count }));
      }),

    /**
     * §3.2 — Burndown: remaining not-done work over a sprint or date range.
     *
     * Sprint mode (§7 decision 1): filters to cards that were in the sprint
     * at the time of their transition. Date-range mode: all cards in the
     * project. Both share the same computation with different windows.
     */
    burndown: route({
      permission: 'analytics:read',
      quotaClass: 'expensive',
    })
      .input(
        z
          .object({
            projectId: z.string().uuid(),
            startDate: z.coerce.date(),
            endDate: z.coerce.date(),
            sprintId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .output(
        z.array(
          z.object({
            date: z.string(),
            remaining: z.number().int(),
          }),
        ),
      )
      .query(async ({ ctx, input }) => {
        const points = await queryBurndown(ctx.principal.org.orgId, {
          projectId: input.projectId,
          startDate: input.startDate,
          endDate: input.endDate,
          ...(input.sprintId === undefined ? {} : { sprintId: input.sprintId }),
        });
        return points.map((p) => ({ date: p.date, remaining: p.remaining }));
      }),

    /**
     * §3.3 — Cumulative Flow (CFD): cards in each category per day.
     */
    cfd: route({
      permission: 'analytics:read',
      quotaClass: 'expensive',
    })
      .input(
        dateRangeInput.extend({
          boardId: z.string().uuid(),
        }),
      )
      .output(
        z.array(
          z.object({
            date: z.string(),
            notStarted: z.number().int(),
            active: z.number().int(),
            done: z.number().int(),
          }),
        ),
      )
      .query(async ({ ctx, input }) => {
        const points = await queryCfd(ctx.principal.org.orgId, {
          boardId: input.boardId,
          startDate: input.startDate,
          endDate: input.endDate,
        });
        return points.map((p) => ({
          date: p.date,
          notStarted: p.notStarted,
          active: p.active,
          done: p.done,
        }));
      }),

    /**
     * §3.4 — Cycle Time: median and p85 time from active to done.
     */
    cycleTime: route({
      permission: 'analytics:read',
      quotaClass: 'expensive',
    })
      .input(
        z
          .object({
            projectId: z.string().uuid().optional(),
            boardId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .output(
        z.object({
          medianHours: z.number(),
          p85Hours: z.number(),
          count: z.number().int(),
          openCount: z.number().int(),
        }),
      )
      .query(async ({ ctx, input }) => {
        return queryCycleTime(ctx.principal.org.orgId, {
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
        });
      }),

    /**
     * §3.5 — Workload: open cards per assignee.
     */
    workload: route({
      permission: 'analytics:read',
      quotaClass: 'expensive',
    })
      .input(
        z
          .object({
            boardId: z.string().uuid().optional(),
          })
          .strict(),
      )
      .output(
        z.array(
          z.object({
            userId: z.string().uuid(),
            cardCount: z.number().int(),
          }),
        ),
      )
      .query(async ({ ctx, input }) => {
        const entries = await queryWorkload(ctx.principal.org.orgId, {
          ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
        });
        return entries.map((e) => ({ userId: e.userId, cardCount: e.cardCount }));
      }),

    /**
     * §3.6 — Volume: messages, calls, and in-app calls per day.
     */
    volume: route({
      permission: 'analytics:read',
      quotaClass: 'expensive',
    })
      .input(dateRangeInput)
      .output(
        z.array(
          z.object({
            date: z.string(),
            messages: z.number().int(),
            calls: z.number().int(),
            callDurationMinutes: z.number(),
            inAppCalls: z.number().int(),
          }),
        ),
      )
      .query(async ({ ctx, input }) => {
        const points = await queryVolume(ctx.principal.org.orgId, {
          startDate: input.startDate,
          endDate: input.endDate,
        });
        return points.map((p) => ({
          date: p.date,
          messages: p.messages,
          calls: p.calls,
          callDurationMinutes: p.callDurationMinutes,
          inAppCalls: p.inAppCalls,
        }));
      }),

    /**
     * §6 — Status: staleness and transition counts.
     *
     * Every dashboard shows when its data was last refreshed. Since we query
     * card_transitions directly (no materialized views), "last refreshed"
     * means when the most recent transition was indexed. This route also
     * returns the total transition count and the last indexed timestamp,
     * giving the UI enough to display staleness.
     */
    status: route({
      permission: 'analytics:read',
    })
      .output(
        z.object({
          totalTransitions: z.number().int(),
          lastIndexedAt: z.coerce.date().nullable(),
          syntheticCount: z.number().int(),
          rollupLastRefreshedAt: z.coerce.date().nullable(),
          rollupOrgCount: z.number().int(),
        }),
      )
      .query(async ({ ctx }) => {
        return withOrgScope(ctx.principal.org.orgId, async (tx) => {
          const stats = await tx
            .select({
              total: countRows(schema.cardTransitions.id).as('total'),
              lastIndexedAt: maxColumn<Date>(schema.cardTransitions.occurredAt).as(
                'last_indexed_at',
              ),
              syntheticCount: countFiltered(eq(schema.cardTransitions.synthetic, true)).as(
                'synthetic_count',
              ),
            })
            .from(schema.cardTransitions);

          const row = stats[0];

          // Rollup freshness: the most recent day in any rollup table.
          const rollupFreshness = await tx
            .select({
              lastRefreshedAt: maxColumn<Date>(schema.rollupVelocity.day).as('last_refreshed_at'),
            })
            .from(schema.rollupVelocity)
            .where(eq(schema.rollupVelocity.orgId, ctx.principal.org.orgId));

          return {
            totalTransitions: Number(row?.total ?? '0'),
            lastIndexedAt: row?.lastIndexedAt ?? null,
            syntheticCount: Number(row?.syntheticCount ?? '0'),
            rollupLastRefreshedAt: rollupFreshness[0]?.lastRefreshedAt ?? null,
            rollupOrgCount: 1,
          };
        });
      }),

    /**
     * §2.2 — Backfill: synthetic creation rows for never-moved cards.
     *
     * Manual trigger for one org. Safe to re-run (idempotent). Must be run
     * BEFORE pruneOutbox (§2.4 ordering constraint).
     */
    backfill: route({
      permission: 'analytics:read',
    })
      .output(z.object({ syntheticCreated: z.number().int() }))
      // A mutation, not a query: it INSERTS synthetic creation rows. A query
      // can be prefetched, refetched on focus, or retried, none of which may
      // trigger a write.
      .mutation(async ({ ctx }) => {
        const syntheticCreated = await backfillSyntheticCreationRows(ctx.principal.org.orgId);
        return { syntheticCreated };
      }),

    /**
     * §3.6 — Spend: comms cost attribution per kind.
     *
     * Wraps the existing `spendReport` from the telephony module (Phase 7
     * Wave 4). Already built with a route and test suite; this presents it
     * inside the analytics dashboard namespace.
     */
    spend: route({
      permission: 'analytics:read',
      quotaClass: 'expensive',
    })
      .input(
        z
          .object({
            sinceDays: z.number().int().min(1).max(365).default(30),
          })
          .strict(),
      )
      .output(
        z.array(
          z.object({
            kind: z.string(),
            count: z.number().int(),
            estimatedCents: z.number().int(),
            billedCents: z.number().int(),
          }),
        ),
      )
      .query(async ({ ctx, input }) => {
        const rows = await spendReport(ctx.principal.org.orgId, {
          sinceDays: input.sinceDays,
        });
        return rows.map((r) => ({
          kind: r.kind,
          count: r.count,
          estimatedCents: r.estimatedCents,
          billedCents: r.billedCents,
        }));
      }),

    /**
     * §7 decision 7 — Prune old outbox events.
     *
     * Must be run AFTER backfill (§2.4 ordering constraint). Removes outbox
     * events older than `retentionDays` that have been dispatched to every
     * consumer. Returns the counts of deleted rows.
     */
    prune: route({
      permission: 'analytics:read',
    })
      .input(
        z
          .object({
            retentionDays: z.number().int().min(1).max(365).default(30),
          })
          .strict(),
      )
      .output(
        z.object({
          eventsPruned: z.number().int(),
          dispatchesPruned: z.number().int(),
        }),
      )
      // A mutation, not a query: it DELETES outbox rows. See prune.ts's own
      // header for the correctness constraints this destructive operation
      // carries (it must run after the backfill, and the outbox is a shared
      // event store other consumers may still need to drain).
      .mutation(async ({ ctx, input }) => {
        return pruneOutbox(ctx.principal.org.orgId, input.retentionDays);
      }),
  });
}
