import { index, pgSchema, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgs } from './tenancy.js';

/**
 * Billing tables (migration 0059, Phase 12 Wave 3, ai/phase-12-wave3.md §3.2,
 * §3.5). As with every other schema file, this is the TypeScript mirror; the
 * migration is the source and carries the RLS policies and the reasoning no
 * generated diff can express.
 *
 * `customerOrgs` has **no RLS**, deliberately — the identical shape and
 * reasoning as `comms.subaccountOrgs`: the pre-tenant lookup an
 * unauthenticated Stripe webhook needs to find its org before any scope can
 * be opened, holding nothing but the mapping itself.
 */

const billing = pgSchema('billing');

export const customerOrgs = billing.table('customer_orgs', {
  stripeCustomerId: text('stripe_customer_id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
});

export const webhookEvents = billing.table(
  'webhook_events',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.providerEventId] }),
    index('billing_webhook_events_received_at_idx').on(table.receivedAt),
  ],
);
