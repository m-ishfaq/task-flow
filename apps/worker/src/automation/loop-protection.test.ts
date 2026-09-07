import { describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import {
  MAX_DEPTH,
  checkDepth,
  checkLoopProtection,
  eventsEmittedBy,
  selfTriggers,
} from './loop-protection.js';
import { ACTION_TYPES, type AutomationAction, type AutomationRule } from './types.js';

/**
 * Loop protection, exhaustively — the one part of the engine where being
 * wrong does not produce a wrong answer, it produces a system that never
 * stops.
 *
 * These are the two PURE layers. The durable budget and the kill switch are
 * stateful and tested against a real database in `engine.test.ts`.
 */

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: '018f4d1e-7c3a-7b2e-8f1a-000000000001',
    orgId: unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-0000000000aa'),
    name: 'Rule',
    triggerEvent: 'card.status_changed',
    condition: null,
    actions: [{ type: 'chat.post_message', channelId: 'c', body: 'hi' }],
    enabled: true,
    createdBy: unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-0000000000bb'),
    ...overrides,
  };
}

describe('checkDepth — layer 1, the only layer that guarantees termination', () => {
  it('allows a chain up to the cap and refuses at it', () => {
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      expect(checkDepth(depth).allowed, `depth ${String(depth)} should be allowed`).toBe(true);
    }
    expect(checkDepth(MAX_DEPTH).allowed).toBe(false);
    expect(checkDepth(MAX_DEPTH).reason).toBe('depth_exceeded');
  });

  it('refuses beyond the cap rather than wrapping', () => {
    /* `>=`, not `===`. An off-by-one written as equality lets every depth past
       the cap through — the failure would be unbounded recursion, arrived at by
       a check that looks like it is doing something. */
    expect(checkDepth(MAX_DEPTH + 1).allowed).toBe(false);
    expect(checkDepth(999).allowed).toBe(false);
  });

  it('treats a human action as the root of a chain', () => {
    /* Depth 0 is what an event with no `causationDepth` reads as — every human
       mutation, and every event written before the field existed. */
    expect(checkDepth(0).allowed).toBe(true);
  });
});

describe('selfTriggers — layer 2, the usability layer', () => {
  it('catches the classic: updated -> set a field -> updated', () => {
    /* The rule a person actually builds by accident. Without this it costs
       MAX_DEPTH runs per user action and fills the history with noise; with it,
       one refusal naming the reason. */
    expect(
      selfTriggers({
        triggerEvent: 'card.updated',
        actions: [{ type: 'card.set_priority', priority: 'high' }],
      }),
    ).toBe(true);
  });

  it('catches a status rule whose action sets the status', () => {
    expect(
      selfTriggers({
        triggerEvent: 'card.status_changed',
        actions: [{ type: 'card.set_status', statusId: 's' }],
      }),
    ).toBe(true);
  });

  it('catches a chat rule that posts to chat', () => {
    expect(
      selfTriggers({
        triggerEvent: 'message.sent',
        actions: [{ type: 'chat.post_message', channelId: 'c', body: 'x' }],
      }),
    ).toBe(true);
  });

  it('catches it when only ONE of several actions loops', () => {
    /* The `some`, not `every`. A rule with three harmless actions and one that
       loops still loops. */
    expect(
      selfTriggers({
        triggerEvent: 'card.updated',
        actions: [
          { type: 'chat.post_message', channelId: 'c', body: 'x' },
          { type: 'card.add_label', labelId: 'l' },
        ],
      }),
    ).toBe(true);
  });

  it('permits an ordinary cross-product rule', () => {
    /* The whole point of the product: a card entering Done posts to a channel.
       Nothing about that is a cycle, and refusing it would make the engine
       useless. */
    expect(
      selfTriggers({
        triggerEvent: 'card.status_changed',
        actions: [{ type: 'chat.post_message', channelId: 'c', body: 'shipped' }],
      }),
    ).toBe(false);
  });

  it('has an entry for every action type', () => {
    /* An action type missing from the table returns [] and therefore never
       self-triggers — a silent hole that grows every time someone adds an
       action and forgets the table. This is what makes adding one a
       deliberate change. */
    for (const type of ACTION_TYPES) {
      expect(eventsEmittedBy(type).length, `${type} emits no known events`).toBeGreaterThan(0);
    }
  });

  it('lists card.updated for every card-mutating action', () => {
    /* Being conservative is the correct bias: a listed event that is not
       actually emitted costs a visible false refusal, a MISSING one costs a
       loop that only the depth cap catches. Every card action touches the row,
       so every one of them emits card.updated —

       except `card.create`, which is the one `card.*` action that does not
       MUTATE an existing row at all: it inserts a brand new card and emits
       only `card.created`, the same event `card.move`/`card.assign`/etc.
       emit `card.updated` ALONGSIDE. Listing `card.updated` for it would be
       the false-refusal cost the comment above warns about, for an event
       `createCard` never actually raises. */
    const cardActions = ACTION_TYPES.filter(
      (type) => type.startsWith('card.') && type !== 'card.create',
    );
    for (const type of cardActions) {
      expect(eventsEmittedBy(type), `${type} should list card.updated`).toContain('card.updated');
    }
  });
});

describe('checkLoopProtection — the two layers in order', () => {
  it('reports depth before self-trigger when both would refuse', () => {
    /* Order matters for the recorded reason, and depth is the more accurate
       explanation: the chain was already too deep to run regardless of what
       this particular rule looks like. */
    const looping = rule({
      triggerEvent: 'card.updated',
      actions: [{ type: 'card.set_priority', priority: 'high' }],
    });

    expect(checkLoopProtection(looping, MAX_DEPTH).reason).toBe('depth_exceeded');
    expect(checkLoopProtection(looping, 0).reason).toBe('self_trigger');
  });

  it('allows an ordinary rule at ordinary depth', () => {
    expect(checkLoopProtection(rule(), 0).allowed).toBe(true);
    expect(checkLoopProtection(rule(), MAX_DEPTH - 1).allowed).toBe(true);
  });

  it('refuses an unknown action type without crashing', () => {
    /* A rule written by a newer build, read by an older one. The `?? []`
       fallback means it does not self-trigger by this check — but it also must
       not throw, because one unreadable rule must not stop the queue for every
       rule behind it. */
    const exotic = rule({
      actions: [{ type: 'future.thing' } as unknown as AutomationAction],
    });
    expect(() => checkLoopProtection(exotic, 0)).not.toThrow();
    expect(checkLoopProtection(exotic, 0).allowed).toBe(true);
  });
});
