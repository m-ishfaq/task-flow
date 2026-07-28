import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { unsafeAsId } from '@taskflow/contracts';
import {
  InMemoryEventBus,
  RecordingEventBus,
  __resetRegistryForTests,
  createEvent,
  defineEvent,
  findEvent,
  registeredEvents,
  EventEnvelopeSchema,
  type DomainEvent,
} from './index.js';

const ORG = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-00000000000a');
const USER = unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001');

const context = { orgId: ORG, actorId: USER };

const cardMovedPayload = z
  .object({ cardId: z.string(), fromListId: z.string(), toListId: z.string() })
  .strict();

beforeEach(() => {
  __resetRegistryForTests();
});

afterEach(() => {
  __resetRegistryForTests();
});

describe('defineEvent', () => {
  it('registers an event so consumers can find it', () => {
    const definition = defineEvent('card.moved', cardMovedPayload);

    expect(definition.name).toBe('card.moved');
    expect(definition.version).toBe(1);
    expect(findEvent('card.moved')).toBe(definition);
    expect(registeredEvents()).toHaveLength(1);
  });

  it('rejects a second definition under the same name', () => {
    // Otherwise consumers validate against whichever module loaded last, and the
    // bug reproduces only under a particular import order.
    defineEvent('card.moved', cardMovedPayload);
    expect(() => defineEvent('card.moved', z.object({}))).toThrow(/already registered/);
  });

  it.each([
    ['a command rather than a fact', 'moveCard'],
    ['no resource prefix', 'moved'],
    ['camelCase resource', 'Card.moved'],
    ['a slash separator', 'card/moved'],
    ['empty', ''],
  ])('rejects %s', (_label, name) => {
    // An event is a statement that something HAS HAPPENED. Naming one as a
    // command invites treating the stream as a work queue, and then a failing
    // consumer starts looking like a failed mutation.
    expect(() => defineEvent(name, z.object({}))).toThrow(/Invalid event name/);
  });

  it('accepts a snake_case resource', () => {
    expect(() => defineEvent('phone_number.purchased', z.object({}))).not.toThrow();
  });
});

describe('createEvent', () => {
  it('builds an envelope with the fields every consumer needs', () => {
    const definition = defineEvent('card.moved', cardMovedPayload);
    const event = createEvent(
      definition,
      { cardId: 'c1', fromListId: 'l1', toListId: 'l2' },
      { ...context, occurredAt: new Date('2026-07-27T12:00:00.000Z') },
    );

    expect(event.name).toBe('card.moved');
    expect(event.orgId).toBe(ORG);
    expect(event.actorId).toBe(USER);
    expect(event.occurredAt).toBe('2026-07-27T12:00:00.000Z');
    expect(event.payload).toEqual({ cardId: 'c1', fromListId: 'l1', toListId: 'l2' });
    expect(EventEnvelopeSchema.parse(event)).toBeDefined();
  });

  it('gives every event a time-ordered id', () => {
    const definition = defineEvent('card.moved', cardMovedPayload);
    const ids = Array.from({ length: 500 }, () =>
      createEvent(definition, { cardId: 'c', fromListId: 'a', toListId: 'b' }, context),
    ).map((event) => event.id);

    expect(new Set(ids).size).toBe(500);
    // UUIDv7, so lexical order is emission order — which is what lets a consumer
    // resume from a cursor without a separate sequence column.
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects a payload that does not match the schema', () => {
    // Validating here rather than at publish is deliberate. By the time a bad
    // payload reaches the relay the transaction has committed, and the only
    // choices left are dropping the event or stalling the queue.
    const definition = defineEvent('card.moved', cardMovedPayload);

    expect(() => createEvent(definition, { cardId: 'c1' } as never, context)).toThrow();
  });

  it('rejects unknown keys in the payload', () => {
    const definition = defineEvent('card.moved', cardMovedPayload);

    expect(() =>
      createEvent(
        definition,
        { cardId: 'c', fromListId: 'a', toListId: 'b', secret: 'x' } as never,
        context,
      ),
    ).toThrow();
  });

  it('refuses to build an event that was never registered', () => {
    const orphan = { name: 'card.moved', schema: cardMovedPayload, version: 1 } as const;

    expect(() =>
      createEvent(orphan, { cardId: 'c', fromListId: 'a', toListId: 'b' }, context),
    ).toThrow(/not registered/);
  });

  it('distinguishes a system actor from a missing one', () => {
    // null means "the retention sweep did this". An absent field would mean "we
    // failed to record who did this", and those must not look the same in an
    // audit log.
    const definition = defineEvent('card.moved', cardMovedPayload);
    const event = createEvent(
      definition,
      { cardId: 'c', fromListId: 'a', toListId: 'b' },
      { orgId: ORG, actorId: null },
    );

    expect(event.actorId).toBeNull();
    expect('actorId' in event).toBe(true);
  });

  it('omits requestId rather than emitting undefined', () => {
    const definition = defineEvent('card.moved', cardMovedPayload);
    const event = createEvent(definition, { cardId: 'c', fromListId: 'a', toListId: 'b' }, context);

    expect('requestId' in event).toBe(false);
  });
});

describe('InMemoryEventBus', () => {
  function event(name: string): DomainEvent {
    const definition = findEvent(name) ?? defineEvent(name, z.object({}).passthrough());
    return createEvent(definition, {}, context);
  }

  it('delivers to name-specific and wildcard subscribers', async () => {
    const bus = new InMemoryEventBus();
    const specific: string[] = [];
    const all: string[] = [];

    bus.on('card.moved', (received) => {
      specific.push(received.name);
    });
    bus.on('*', (received) => {
      all.push(received.name);
    });

    await bus.publish([event('card.moved'), event('card.created')]);

    expect(specific).toEqual(['card.moved']);
    expect(all).toEqual(['card.moved', 'card.created']);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const off = bus.on('*', (received) => {
      seen.push(received.name);
    });

    await bus.publish([event('card.moved')]);
    off();
    await bus.publish([event('card.created')]);

    expect(seen).toEqual(['card.moved']);
  });

  it('reports handler failures instead of swallowing them', async () => {
    // A bus that silently drops events in tests lets the consumer bugs it exists
    // to catch pass CI.
    const bus = new InMemoryEventBus();
    bus.on('*', () => {
      throw new Error('handler exploded');
    });

    await expect(bus.publish([event('card.moved')])).rejects.toThrow(AggregateError);
  });

  it('still delivers to the other handlers when one fails', async () => {
    const bus = new InMemoryEventBus();
    const survived: string[] = [];

    bus.on('*', () => {
      throw new Error('first handler exploded');
    });
    bus.on('*', (received) => {
      survived.push(received.name);
    });

    await expect(bus.publish([event('card.moved')])).rejects.toThrow();
    expect(survived).toEqual(['card.moved']);
  });
});

describe('RecordingEventBus', () => {
  it('captures what a service emitted, in order', () => {
    // How guardrail 11 gets TESTED rather than merely linted: the lint rule
    // proves an emit call exists, this proves it emitted the right thing.
    const bus = new RecordingEventBus();
    const definition = defineEvent('card.moved', cardMovedPayload);

    void bus.publish([
      createEvent(definition, { cardId: 'c1', fromListId: 'a', toListId: 'b' }, context),
    ]);

    expect(bus.names()).toEqual(['card.moved']);
    expect(bus.events[0]?.payload).toEqual({ cardId: 'c1', fromListId: 'a', toListId: 'b' });
  });
});
