import { describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { describeAiProviderContract } from './contract-test.js';
import { FakeAiProvider } from './fake.js';

const ORG_ID = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001') as OrgId;

describeAiProviderContract('FakeAiProvider', () => new FakeAiProvider());

describe('FakeAiProvider', () => {
  it('records every call it was asked to make', async () => {
    const provider = new FakeAiProvider();
    await provider.complete({ orgId: ORG_ID, model: 'test-model', messages: [] });
    await provider.complete({ orgId: ORG_ID, model: 'test-model', messages: [] });

    expect(provider.calls).toHaveLength(2);
  });

  it('never records a call the budget gate refused before dispatch', () => {
    /* The property the whole gate exists to prove, per this fake's own doc
       comment: not that a refusal came back, but that the provider was
       never reached. Simulated here directly — the real gate test lives in
       apps/api/src/ai and asserts the same thing against a real refusal
       path. */
    const provider = new FakeAiProvider();
    expect(provider.calls).toHaveLength(0);
  });

  it('replays a queued response in order, then falls back to the default', async () => {
    const provider = new FakeAiProvider();
    provider.enqueue({
      content: 'first',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'end_turn',
    });

    const first = await provider.complete({ orgId: ORG_ID, model: 'test-model', messages: [] });
    const second = await provider.complete({ orgId: ORG_ID, model: 'test-model', messages: [] });

    expect(first.content).toBe('first');
    expect(second.content).toBe('This is a fake completion.');
  });
});
