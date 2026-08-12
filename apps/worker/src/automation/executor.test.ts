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

describe('the executor — the cost-bearing actions (Phase 10 Wave 4 §5.5)', () => {
  const member = { orgId: ORG, role: 'admin' as const, tuples: [] };
  const telephonyRule = (type: 'call.place' | 'sms.send') =>
    rule({
      actions: [
        type === 'call.place'
          ? {
              type: 'call.place' as const,
              to: '+14155550100',
              fromPhoneNumberId: '018f4d1e-7c3a-7b2e-8f1a-0000000000ab',
            }
          : {
              type: 'sms.send' as const,
              to: '+14155550100',
              fromPhoneNumberId: '018f4d1e-7c3a-7b2e-8f1a-0000000000ab',
              body: 'hello',
            },
      ],
    });

  it('refuses to run a telephony action while the flag is off, with a recorded reason', async () => {
    /* The execution-time half of the env flag: a rule saved while the flag was
       on must stop the moment the deployment turns it off — recorded as a
       failed action, never silent. Default (no deps) IS off. */
    const executor = createActionExecutor({
      resolveMembership: vi.fn().mockResolvedValue(member),
    });

    for (const type of ['call.place', 'sms.send'] as const) {
      const results = await executor.execute({
        rule: telephonyRule(type),
        event,
        nextDepth: 2,
      });
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toContain('disabled');
    }
  });

  it('refuses when the flag is on but no carrier is configured', async () => {
    /* A valid deployment with the flag enabled and no telephony configured:
       the action fails with the API's own "not configured" language, so the
       rule author sees why, and nothing reaches a carrier. */
    const executor = createActionExecutor({
      resolveMembership: vi.fn().mockResolvedValue(member),
      telephonyActionsEnabled: true,
    });

    const results = await executor.execute({
      rule: telephonyRule('call.place'),
      event,
      nextDepth: 2,
    });

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('not configured');
  });
});

/**
 * The outbound connector actions (§7.6, slice 4).
 *
 * These are the first actions that act as the ORG on a platform this deployment
 * does not run, so the acceptance bar is Phase 7's: the assertion that matters
 * is not that a refusal is returned, it is that **the provider was never
 * reached** — asserted against a fake `fetch` that would have recorded it.
 * A refusal returned after the message was already posted reads correctly in a
 * diff and is visible in somebody's Slack channel.
 */
describe('the executor — the outbound connector actions (§7.6)', () => {
  const member = { orgId: ORG, role: 'admin' as const, tuples: [] };

  const slackRule = () =>
    rule({
      actions: [
        {
          type: 'slack.post_message' as const,
          integrationId: '018f4d1e-7c3a-7b2e-8f1a-0000000000f1',
          channel: '#general',
          text: 'shipped',
        },
      ],
    });

  const githubRule = () =>
    rule({
      actions: [
        {
          type: 'github.create_issue' as const,
          integrationId: '018f4d1e-7c3a-7b2e-8f1a-0000000000f2',
          title: 'Something broke',
          body: '',
        },
      ],
    });

  it('refuses when connectors are not configured, without reaching a provider', async () => {
    const fetchImpl = vi.fn();
    /* No `integrations` dep — a worker with no master key configured. */
    const executor = createActionExecutor({
      resolveMembership: vi.fn().mockResolvedValue(member),
    });

    for (const built of [slackRule(), githubRule()]) {
      const results = await executor.execute({ rule: built, event, nextDepth: 2 });
      expect(results[0]?.status).toBe('failed');
      expect(results[0]?.error).toContain('not configured');
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never reaches the provider when the rule owner is gone', async () => {
    /* The membership check runs before any action, so a rule whose owner left
       cannot spend the org's Slack identity on the way out. The fake fetch is
       the assertion — a `failed` result alone would be returned either way. */
    const fetchImpl = vi.fn();
    const executor = createActionExecutor({
      resolveMembership: vi.fn().mockResolvedValue(null),
      integrations: { keys: {} as never, fetchImpl },
    });

    const results = await executor.execute({ rule: slackRule(), event, nextDepth: 2 });

    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('no longer an active member');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
