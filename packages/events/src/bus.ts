import type { DomainEvent } from './envelope.js';

/**
 * Publishing and consuming (PLAN.md §8.6, §2.1 guardrail 11).
 *
 * The delivery mechanism is the **transactional outbox**, and the reason is the
 * one failure mode that makes an event-driven system untrustworthy: publishing
 * after the commit means a crash in between loses the event forever, and
 * publishing before it means a rollback emits an event for something that never
 * happened. Neither is recoverable, and both are invisible until an audit.
 *
 * Writing the event to a table INSIDE the mutation's own transaction makes the
 * mutation and its event atomic. A relay then moves rows from that table to
 * consumers, at-least-once. Consumers must therefore be idempotent — that cost
 * is real, and it is much smaller than the cost of not knowing whether the
 * stream is complete.
 */

/**
 * Appends events within a caller-supplied transaction.
 *
 * Generic over the transaction handle rather than importing `@taskflow/db`,
 * because this package has no business knowing what a database is — and a
 * dependency here would drag Postgres into the socket gateway and the UI.
 */
export interface OutboxWriter<Tx> {
  append(tx: Tx, events: readonly DomainEvent[]): Promise<void>;
}

export type EventHandler = (event: DomainEvent) => void | Promise<void>;

export interface EventBus {
  /** Subscribes to one event name, or `*` for all of them. */
  on(name: string, handler: EventHandler): () => void;
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/**
 * In-process bus, for tests and for the local dev loop before the relay exists.
 *
 * Explicitly NOT the production path: it has no durability, so a handler that
 * throws loses the event. `deliver` therefore reports failures instead of
 * swallowing them — a bus that silently drops events in tests would let the
 * consumer bugs it exists to catch pass CI.
 */
export class InMemoryEventBus implements EventBus {
  readonly #handlers = new Map<string, Set<EventHandler>>();

  on(name: string, handler: EventHandler): () => void {
    const existing = this.#handlers.get(name) ?? new Set<EventHandler>();
    existing.add(handler);
    this.#handlers.set(name, existing);

    return () => {
      existing.delete(handler);
    };
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    const failures: Error[] = [];

    for (const event of events) {
      const handlers = [
        ...(this.#handlers.get(event.name) ?? []),
        ...(this.#handlers.get('*') ?? []),
      ];

      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `${String(failures.length)} event handler(s) failed.`);
    }
  }
}

/**
 * Collects events without delivering them. For asserting WHICH events a service
 * method emitted, which is how guardrail 11 gets tested rather than merely
 * linted.
 */
export class RecordingEventBus implements EventBus {
  readonly events: DomainEvent[] = [];

  on(): () => void {
    return () => {
      /* nothing is delivered, so there is nothing to unsubscribe */
    };
  }

  publish(events: readonly DomainEvent[]): Promise<void> {
    this.events.push(...events);
    return Promise.resolve();
  }

  names(): readonly string[] {
    return this.events.map((event) => event.name);
  }
}
