import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * "Email me this project's standup" (migration 0108). See
 * `subscription.service.ts`'s own header for why this is opt-in rather than
 * automatic, and `apps/api/src/tenancy/audit.projection.ts` for the
 * resource mapping added in this same change.
 */

export const standupSubscriptionCreated = defineEvent(
  'standup_subscription.created',
  z.object({ projectId: z.string(), userId: z.string() }).strict(),
);

export const standupSubscriptionRemoved = defineEvent(
  'standup_subscription.removed',
  z.object({ projectId: z.string(), userId: z.string() }).strict(),
);
