import type { z } from 'zod';

/**
 * The domain event registry — guardrail 11 (PLAN.md §2.1, §8.6).
 *
 * Every state-mutating service method emits a typed event from here, and four
 * separate subsystems consume the same stream: the audit log, notifications,
 * search indexing, and automation triggers.
 *
 * The reason that is a GUARDRAIL rather than a convention: those four are the
 * things nobody notices are missing. A card that updates without an event still
 * looks right on screen. The audit gap is found during an incident, the missing
 * notification when a customer complains, the stale search index when someone
 * cannot find their own work. Each one is discovered months later, by a person,
 * in a bad mood.
 *
 * Events are registered by the slice that owns them, not listed here. A central
 * list would either lag behind or become a dumping ground, and both make the
 * registry lie about what the system actually emits.
 */

export interface EventDefinition<Name extends string, Schema extends z.ZodTypeAny> {
  readonly name: Name;
  readonly schema: Schema;
  /**
   * Payload version. Consumers are long-lived and read events written by older
   * builds, so a payload change that is not additive means a new version rather
   * than an edit — the same expand/migrate/contract discipline as the schema
   * (§7.4).
   */
  readonly version: number;
}

/** Any registered definition, for code that handles events generically. */
export type AnyEventDefinition = EventDefinition<string, z.ZodTypeAny>;

/** The payload type of a definition. */
export type PayloadOf<D> = D extends EventDefinition<string, infer S> ? z.infer<S> : never;

const registry = new Map<string, AnyEventDefinition>();

/**
 * Defines and registers a domain event.
 *
 * Names are `<resource>.<past-tense-verb>` — `card.moved`, not `moveCard`. An
 * event is a statement that something HAS HAPPENED; naming it as a command
 * invites treating the stream as a work queue, and then a consumer that fails
 * starts looking like a mutation that failed.
 */
export function defineEvent<Name extends string, Schema extends z.ZodTypeAny>(
  name: Name,
  schema: Schema,
  version = 1,
): EventDefinition<Name, Schema> {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid event name "${name}". Expected <resource>.<past_tense_verb>, e.g. "card.moved".`,
    );
  }

  const existing = registry.get(name);
  if (existing) {
    // Two definitions under one name means consumers silently validate against
    // whichever module loaded last — a bug that reproduces only under a
    // particular import order.
    throw new Error(`Event "${name}" is already registered.`);
  }

  const definition: EventDefinition<Name, Schema> = { name, schema, version };
  registry.set(name, definition);
  return definition;
}

/** Looks up a registered definition. Returns undefined for unknown names. */
export function findEvent(name: string): AnyEventDefinition | undefined {
  return registry.get(name);
}

/** Every registered event. Used by the outbox relay and the admin event browser. */
export function registeredEvents(): readonly AnyEventDefinition[] {
  return [...registry.values()];
}

/**
 * Empties the registry. Tests only.
 *
 * Module-level state and test isolation are in tension; this is the seam that
 * resolves it. Exported from a `__test` name so a production import stands out
 * in review.
 */
export function __resetRegistryForTests(): void {
  registry.clear();
}
