import { describe, expect, it } from 'vitest';
import { buildAutomationActionSchema } from './router.js';

/**
 * The write boundary's action union, as a function of the deployment flag
 * (ai/phase-10-automation.md §5.5, §9 decision 3).
 *
 * The property under test is the one the schema's own header states: with
 * AUTOMATION_TELEPHONY_ACTIONS_ENABLED off (the default), the cost-bearing
 * telephony actions are NOT part of the union — so a rule containing one
 * cannot be SAVED at all, with the same error a mistyped action type gets.
 * This is the "does the action exist in the builder" half of the gate; the
 * worker's executor owns the "does it run" half, and every security control
 * runs unconditionally at execution regardless of the flag.
 */

const TELEPHONY_CALL = {
  type: 'call.place' as const,
  to: '+14155550100',
  fromPhoneNumberId: '018f4d1e-7c3a-7b2e-8f1a-0000000000ab',
};
const TELEPHONY_SMS = {
  type: 'sms.send' as const,
  to: '+14155550100',
  fromPhoneNumberId: '018f4d1e-7c3a-7b2e-8f1a-0000000000ab',
  body: 'hello',
};

describe('buildAutomationActionSchema — the product-surface flag', () => {
  it('refuses a telephony action while the flag is off', () => {
    const schema = buildAutomationActionSchema(false);

    expect(schema.safeParse(TELEPHONY_CALL).success).toBe(false);
    expect(schema.safeParse(TELEPHONY_SMS).success).toBe(false);
  });

  it('admits the telephony actions when the flag is on', () => {
    const schema = buildAutomationActionSchema(true);

    expect(schema.safeParse(TELEPHONY_CALL).success).toBe(true);
    expect(schema.safeParse(TELEPHONY_SMS).success).toBe(true);
  });

  it('never lets the flag change the non-telephony actions', () => {
    /* The base actions must be identical on both sides of the flag — a flag
       that also gated card moves would be a feature flag wearing the wrong
       hat, and a rule that validated with the flag on must still validate
       with it off. */
    const base = { type: 'card.move' as const, listId: '018f4d1e-7c3a-7b2e-8f1a-0000000000cc' };

    expect(buildAutomationActionSchema(false).safeParse(base).success).toBe(true);
    expect(buildAutomationActionSchema(true).safeParse(base).success).toBe(true);
  });

  it('validates `to` against the same E.164 schema the click-to-call route uses', () => {
    const schema = buildAutomationActionSchema(true);

    /* The destination is the one free-text value in either telephony action;
       a rule must store a real E.164 number or nothing. */
    const bad = schema.safeParse({ ...TELEPHONY_CALL, to: 'not-a-number' });
    expect(bad.success).toBe(false);
  });
});

/**
 * The outbound connector actions (§7.6, slice 4) at the WRITE boundary.
 *
 * What the schema decides is what may reach the database at all, so the
 * assertions here are about shape refusals — the execution-time refusals
 * (`integration:manage`, a disconnected connector) belong to
 * `integration.service.test.ts`.
 */
describe('the connector action schema (Wave 4 §7.6)', () => {
  const SLACK = {
    type: 'slack.post_message' as const,
    integrationId: '018f4d1e-7c3a-7b2e-8f1a-0000000000f1',
    channel: '#general',
    text: 'shipped',
  };
  const GITHUB = {
    type: 'github.create_issue' as const,
    integrationId: '018f4d1e-7c3a-7b2e-8f1a-0000000000f2',
    title: 'Something broke',
    body: '',
  };

  it('admits both regardless of the telephony flag', () => {
    /* Not flag-gated, unlike the telephony pair: these cost nothing and reach
       only a provider the org authorized through its own consent screen. */
    for (const enabled of [false, true]) {
      const schema = buildAutomationActionSchema(enabled);
      expect(schema.safeParse(SLACK).success).toBe(true);
      expect(schema.safeParse(GITHUB).success).toBe(true);
    }
  });

  it('refuses a repository named by the rule', () => {
    /* `.strict()` is the control. The repo is the connector row's own scope —
       an action that could carry one would let a single connector open issues
       on every repository its token reaches. */
    const schema = buildAutomationActionSchema(true);
    const withRepo = { ...GITHUB, repository: 'acme/other' };

    expect(schema.safeParse(withRepo).success).toBe(false);
  });

  it('refuses a connector named by anything but a row id', () => {
    const schema = buildAutomationActionSchema(true);

    /* A workspace name, a team id, a URL — none of them are one of the org's
       own rows, which is what makes "a rule cannot reach a connector the org
       did not authorize" true by construction. */
    expect(schema.safeParse({ ...SLACK, integrationId: 'T0001' }).success).toBe(false);
    expect(schema.safeParse({ ...GITHUB, integrationId: 'acme/todo' }).success).toBe(false);
  });

  it('allows an empty GitHub body but never an empty title', () => {
    /* A title-only issue is ordinary. An empty title is one GitHub would
       reject, and the rule author would only find out at execution. */
    const schema = buildAutomationActionSchema(true);

    expect(schema.safeParse({ ...GITHUB, body: '' }).success).toBe(true);
    expect(schema.safeParse({ ...GITHUB, title: '' }).success).toBe(false);
    expect(schema.safeParse({ ...SLACK, text: '' }).success).toBe(false);
  });
});
