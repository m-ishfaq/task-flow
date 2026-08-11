import { z } from 'zod';
import { UuidSchema, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';
import { findEvent, type EventDefinition, type PayloadOf } from './registry.js';

/**
 * The envelope every domain event travels in (PLAN.md §8.6).
 *
 * Payload-independent fields live here because every consumer needs them and
 * none of them should be re-derived: the audit log needs the actor, the
 * notification worker needs the org, the search indexer needs ordering, and
 * support needs the request id to tie an event back to the HTTP call that
 * caused it.
 */

export type EventId = ReturnType<typeof newId<'EventId'>>;

export interface DomainEvent<Name extends string = string, Payload = unknown> {
  readonly id: EventId;
  readonly name: Name;
  readonly version: number;
  /** The tenant this happened in. Never inferred by a consumer. */
  readonly orgId: OrgId;
  /**
   * Who caused it, or null for the system (a retention sweep, a scheduled
   * automation). Null is a real value here rather than a missing one — "the
   * system did it" is different from "we forgot to record who did it", and an
   * optional field cannot express that difference.
   */
  readonly actorId: UserId | null;
  readonly occurredAt: string;
  /** Ties the event to the HTTP request that produced it (§14). */
  readonly requestId?: RequestId;
  /**
   * How many automation hops produced this event — loop protection's counter
   * (ai/phase-10-automation.md §4, §9 decision 2).
   *
   * ## Why it rides on the envelope rather than in a side table
   *
   * Because actions execute through the ordinary service layer, EVERY action
   * emits an event, and every event is a potential trigger. A rule whose action
   * fires its own trigger is an infinite loop, and "when a card is updated, set
   * a field" is a plausible thing for a person to build. The counter is what
   * stops the two-rule mutual cycle that no single-rule check can see.
   *
   * It is a property of the EVENT, so every consumer can see it for free. The
   * alternatives — a `platform.event_causation` table, or a lookup from the
   * triggering event id — both put a join on the hot path of the one loop that
   * must never be slow.
   *
   * ## Optional, and absent means zero
   *
   * A human action does not set it, and every event written before this field
   * existed does not carry it. Both read as depth 0, which is correct: they are
   * the ROOT of any chain they start. That is what makes this additive — the
   * schema below is `.strict()`, so an optional field is safe to add and a
   * required one would have rejected every row already in `platform.outbox`.
   */
  readonly causationDepth?: number;
  readonly payload: Payload;
}

/**
 * Validates an envelope read back off the wire — an outbox row, a queue message.
 *
 * Ids are validated for shape but not branded: the brand belongs to whichever
 * consumer parses the payload, not to the transport.
 */
export const EventEnvelopeSchema = z
  .object({
    id: UuidSchema,
    name: z.string().min(1),
    version: z.number().int().positive(),
    orgId: UuidSchema,
    actorId: UuidSchema.nullable(),
    occurredAt: z.string().datetime(),
    requestId: z.string().optional(),
    /* Optional, so every event already sitting in `platform.outbox` still
       validates — a required field here would have made this migration a
       rewrite of the queue rather than an addition to it. Bounded because an
       envelope read back off the wire is untrusted input like any other, and a
       depth of 2^31 would be a refusal the engine computes rather than one the
       parser catches. */
    causationDepth: z.number().int().min(0).max(100).optional(),
    payload: z.unknown(),
  })
  .strict();

export interface EventContext {
  readonly orgId: OrgId;
  readonly actorId: UserId | null;
  readonly requestId?: RequestId;
  /** Injectable for deterministic tests. Defaults to now. */
  readonly occurredAt?: Date;
  /**
   * Set ONLY by the automation engine, to its triggering event's depth plus
   * one. Every human-initiated mutation omits it, which is what makes a user's
   * action the root of a chain rather than a continuation of one. See
   * `DomainEvent.causationDepth`.
   */
  readonly causationDepth?: number;
}

/**
 * Builds an event, validating the payload against its registered schema.
 *
 * Validation happens at CONSTRUCTION, not at publish. By the time a bad payload
 * reaches the outbox relay the transaction has committed, so the choice there is
 * between dropping the event and stalling the queue — both bad. Failing here
 * rolls the whole mutation back, which is the only outcome that keeps the
 * "every mutation has an event" invariant true.
 */
export function createEvent<Name extends string, Schema extends z.ZodTypeAny>(
  definition: EventDefinition<Name, Schema>,
  payload: PayloadOf<EventDefinition<Name, Schema>>,
  context: EventContext,
): DomainEvent<Name, z.infer<Schema>> {
  if (!findEvent(definition.name)) {
    throw new Error(
      `Event "${definition.name}" is not registered. Define it with defineEvent() so consumers can validate it.`,
    );
  }

  const parsed = definition.schema.parse(payload) as z.infer<Schema>;

  return {
    id: newId<'EventId'>(),
    name: definition.name,
    version: definition.version,
    orgId: context.orgId,
    actorId: context.actorId,
    occurredAt: (context.occurredAt ?? new Date()).toISOString(),
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    /* Omitted rather than defaulted to 0, so an event carries the field only
       when something deliberately set it. `exactOptionalPropertyTypes` makes
       the difference between "absent" and "present and undefined" real, and a
       reader can tell an automation-produced event from a human one by the
       field's presence alone. */
    ...(context.causationDepth === undefined ? {} : { causationDepth: context.causationDepth }),
    payload: parsed,
  };
}
