/**
 * @taskflow/events — the typed domain event registry (PLAN.md §8.6).
 *
 * Guardrail 11: a service method that mutates state without emitting an event
 * from here fails lint. Audit, notifications, search indexing, and automation
 * all read the same stream, and all four are things nobody notices are missing
 * until it matters.
 */

export {
  defineEvent,
  findEvent,
  registeredEvents,
  __resetRegistryForTests,
  type EventDefinition,
  type AnyEventDefinition,
  type PayloadOf,
} from './registry.js';

export {
  createEvent,
  EventEnvelopeSchema,
  type DomainEvent,
  type EventContext,
  type EventId,
} from './envelope.js';

export {
  InMemoryEventBus,
  RecordingEventBus,
  type EventBus,
  type EventHandler,
  type OutboxWriter,
} from './bus.js';
