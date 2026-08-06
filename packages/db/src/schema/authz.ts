import { boolean, index, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgs } from './tenancy.js';
import { users } from './identity.js';

/**
 * Relationship tuples (migration 0005, PLAN.md §7.2, §8.2).
 *
 * The Zanzibar-lite half of the authorization model. The policy engine consumes
 * tuples already resolved to a single user; expanding a team-subject tuple
 * through identity.team_members is the loader's job, which is what keeps the
 * engine pure and identical across the API, workers, and the UI.
 */

const authz = pgSchema('authz');

export const relationshipTuples = authz.table(
  'relationship_tuples',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** 'user' or 'team'. A team subject is expanded by the loader. */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    /** One of RELATIONS from @taskflow/policy. */
    relation: text('relation').notNull(),

    /**
     * One of RESOURCE_TYPES from @taskflow/policy.
     *
     * There is deliberately no foreign key on `objectId`: the resources it
     * names arrive in later phases, and a dangling tuple grants access to
     * nothing anyway, because loading the resource fails before the engine is
     * consulted.
     */
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),

    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Whether this grant is GUEST access (migration 0021).
     *
     * Changes nothing about how the engine reads the tuple — a guest's row and
     * a member's are identical to `can()`, which is the point of the design.
     * It exists so an access review can ask "who here is external", which the
     * tuple could not otherwise answer.
     */
    isGuest: boolean('is_guest').notNull().default(false),

    /** Null means no expiry. Enforced in the loader's WHERE, not by a sweep. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tuples_unique_grant').on(
      table.orgId,
      table.subjectType,
      table.subjectId,
      table.relation,
      table.objectType,
      table.objectId,
    ),
    index('tuples_subject_idx').on(table.orgId, table.subjectType, table.subjectId),
    index('tuples_object_idx').on(table.orgId, table.objectType, table.objectId),
  ],
);
