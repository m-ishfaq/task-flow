import { z } from 'zod';
import { ProjectIdSchema, type KeyProvider } from '@taskflow/contracts';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { WorkActor } from '../work/shared.js';
import { queryStandup } from './standup.service.js';
import { narrateStandup } from './narrate.js';
import { isSubscribed, subscribe, unsubscribe } from './subscription.service.js';

/**
 * The standup view (ai/phase-15-ai-copilot-and-permissions.md §5).
 *
 * `query` floors on `project:read`, not `analytics:read` — see
 * `standup.service.ts`'s own header for why this is a daily team surface,
 * not an admin report. `narrate` floors on `ai:use` + `aiAssistant`
 * additionally, the identical two-gate shape `ai.chat.send` already uses
 * (§2.4): whether this member may use the assistant AT ALL, and whether the
 * org's plan includes it — both independent of, and in addition to,
 * `queryStandup`'s own `project:read` check, which `narrate` re-runs itself
 * by calling `queryStandup` rather than accepting a client-supplied blob of
 * "standup data" to narrate. A route that trusted the client's own copy of
 * this data would let a caller narrate cards belonging to a project they
 * cannot read by simply typing the JSON themselves.
 *
 * `query` alone is a complete standup screen — `members` carries real
 * Yesterday/Today/Overdue/Urgent card lists and `headline` is a plain count,
 * neither needing AI. `narrate` adds exactly one optional thing on top: a
 * short team-wide `callout` paragraph, gated behind the two extra
 * permissions above — see `narrate.ts`'s own header on why per-member AI
 * lines were dropped entirely rather than kept alongside the real data.
 */

const StandupInput = z
  .object({
    projectId: ProjectIdSchema,
    /** Defaults to 24h — "since the last standup" for a daily meeting. */
    sinceHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 14)
      .optional(),
  })
  .strict();

const StandupCard = z
  .object({
    cardId: z.string(),
    reference: z.string(),
    title: z.string(),
    priority: z.string().nullable(),
    dueDate: z.string().nullable(),
  })
  .strict();

const StandupOutput = z
  .object({
    sprint: z
      .object({ sprintId: z.string(), name: z.string(), endsOn: z.string() })
      .strict()
      .nullable(),
    urgentSprintCards: z.array(StandupCard).readonly(),
    members: z
      .array(
        z
          .object({
            userId: z.string(),
            name: z.string().nullable(),
            yesterday: z.array(StandupCard).readonly(),
            today: z.array(StandupCard).readonly(),
            overdue: z.array(StandupCard).readonly(),
            urgent: z.array(StandupCard).readonly(),
          })
          .strict(),
      )
      .readonly(),
    headline: z.string(),
  })
  .strict();

export interface StandupRouterDeps {
  readonly keys: KeyProvider;
}

export function createStandupRouter(deps: StandupRouterDeps) {
  const actorOf = (ctx: {
    principal: Parameters<typeof subjectOf>[0];
    requestId: WorkActor['requestId'];
  }): WorkActor => ({ subject: subjectOf(ctx.principal), requestId: ctx.requestId });

  return router({
    query: route({ permission: 'project:read' })
      .input(StandupInput)
      .output(StandupOutput)
      .query(({ input, ctx }) =>
        queryStandup(actorOf(ctx), {
          projectId: input.projectId,
          ...(input.sinceHours === undefined ? {} : { sinceHours: input.sinceHours }),
        }),
      ),

    narrate: route({
      permission: 'ai:use',
      feature: { flag: 'aiAssistant', display: 'AI Assistant' },
    })
      .input(StandupInput)
      .output(z.object({ callout: z.string() }).strict())
      .mutation(async ({ input, ctx }) => {
        const actor = actorOf(ctx);
        const standup = await queryStandup(actor, {
          projectId: input.projectId,
          ...(input.sinceHours === undefined ? {} : { sinceHours: input.sinceHours }),
        });
        return narrateStandup(
          deps,
          {
            orgId: ctx.principal.org.orgId,
            userId: ctx.principal.userId,
            requestId: ctx.requestId,
          },
          standup,
        );
      }),

    /**
     * "Email me this project's standup" (migration 0108) — subscribing is
     * `project:read`, the same floor `query` above already uses: it is a
     * self-referential choice about one's own inbox, not a role-gated
     * action, so it needs no permission `query` does not already require.
     */
    subscribe: route({ permission: 'project:read' })
      .input(z.object({ projectId: ProjectIdSchema }).strict())
      .output(z.object({ subscribed: z.literal(true) }))
      .mutation(({ input, ctx }) => subscribe(actorOf(ctx), input)),

    unsubscribe: route({ permission: 'project:read' })
      .input(z.object({ projectId: ProjectIdSchema }).strict())
      .output(z.object({ unsubscribed: z.boolean() }))
      .mutation(({ input, ctx }) => unsubscribe(actorOf(ctx), input)),

    subscription: route({ permission: 'project:read' })
      .input(z.object({ projectId: ProjectIdSchema }).strict())
      .output(z.object({ subscribed: z.boolean() }))
      .query(({ input, ctx }) => isSubscribed(actorOf(ctx), input)),
  });
}
