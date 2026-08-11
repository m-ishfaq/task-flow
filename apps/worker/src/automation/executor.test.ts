import { describe, expect, it, vi } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import { createActionExecutor } from './executor.js';
import type { AutomationRule, TriggerEvent } from './types.js';

/**
 * The executor's AUTHORIZATION behaviour (ai/phase-10-automation.md §2).
 *
 * The membership resolver is injected, so these assertions are about the one
 * decision this file owns — whose permissions an action runs with — without
 * standing up an identity fixture to reach it. Whether the SERVICES then
 * enforce correctly is their own suites' job and is already covered; what is
 * new here, and what nothing else can check, is that the executor asks the
 * right question at the right moment.
 *
 * The property under test is the one a simpler implementation silently loses:
 * a stored rule is a credential, and it must be re-checked on every execution
 * rather than trusted from the day it was saved.
 */

const ORG = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-0000000000aa');
const OWNER = unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-0000000000bb');

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: '018f4d1e-7c3a-7b2e-8f1a-000000000001',
    orgId: ORG,
    name: 'Rule',
    triggerEvent: 'card.status_changed',
    condition: null,
    actions: [{ type: 'card.set_status', statusId: '018f4d1e-7c3a-7b2e-8f1a-0000000000cc' }],
    enabled: true,
    createdBy: OWNER,
    ...overrides,
  };
}

const event: TriggerEvent = {
  id: '018f4d1e-7c3a-7b2e-8f1a-0000000000ee',
  orgId: ORG,
  name: 'card.status_changed',
  payload: { cardId: '018f4d1e-7c3a-7b2e-8f1a-0000000000dd' },
  causationDepth: 1,
};

describe('the executor — whose permissions an action runs with', () => {
  it('re-resolves the rule owner on EVERY execution', async () => {
    const resolveMembership = vi.fn().mockResolvedValue(null);
    const executor = createActionExecutor({ resolveMembership });

    await executor.execute({ rule: rule(), event, nextDepth: 2 });
    await executor.execute({ rule: rule(), event, nextDepth: 2 });

    /* Twice, not once and cached. A cached membership is a role frozen at
       whatever it was when the process started, which makes a demotion take
       effect on the next deploy rather than immediately — the same staleness
       the HTTP path spends a query per request to avoid. */
    expect(resolveMembership).toHaveBeenCalledTimes(2);
    expect(resolveMembership).toHaveBeenCalledWith(OWNER, ORG);
  });

  it('asks about the RULE OWNER, never the person who triggered it', async () => {
    const resolveMembership = vi.fn().mockResolvedValue(null);
    const executor = createActionExecutor({ resolveMembership });

    await executor.execute({ rule: rule(), event, nextDepth: 2 });

    /* Attributing an automation's action to whoever happened to trigger it
       would make the audit log assert that a person did something they did
       not do. */
    expect(resolveMembership).toHaveBeenCalledWith(OWNER, ORG);
  });

  it('stops the rule when the owner is no longer an active member', async () => {
    /* `resolveOrgMembership` returns null for a removed member, an inactive
       one, AND a suspended org — so all three cases arrive here as the same
       refusal, and none of them can be forgotten separately. */
    const executor = createActionExecutor({
      resolveMembership: vi.fn().mockResolvedValue(null),
    });

    const results = await executor.execute({ rule: rule(), event, nextDepth: 2 });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('no longer an active member');
  });

  it('reports every action as failed when the owner is gone, not just the first', async () => {
    /* The run history has to say the whole rule did nothing. Reporting only
       action 0 would read as "action 1 and 2 succeeded", which is the opposite
       of what happened. */
    const executor = createActionExecutor({
      resolveMembership: vi.fn().mockResolvedValue(null),
    });

    const results = await executor.execute({
      rule: rule({
        actions: [
          { type: 'card.set_priority', priority: 'high' },
          { type: 'card.add_label', labelId: '018f4d1e-7c3a-7b2e-8f1a-0000000000ff' },
        ],
      }),
      event,
      nextDepth: 2,
    });

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === 'failed')).toBe(true);
  });
});

describe('the executor — what it refuses to invent', () => {
  it('fails an action whose trigger names no card', async () => {
    /* A rule cannot name a different card than the event that fired it (see
       `cardIdOf`), so a trigger with no card leaves an action with nothing to
       act on. Failing loudly beats picking one. */
    const executor = createActionExecutor({
      resolveMembership: vi.fn().mockResolvedValue({ orgId: ORG, role: 'admin', tuples: [] }),
    });

    const results = await executor.execute({
      rule: rule(),
      event: { ...event, name: 'message.sent', payload: { messageId: 'm' } },
      nextDepth: 2,
    });

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('no cardId');
  });
});
