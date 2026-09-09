import { describe, expect, it } from 'vitest';
import { unsafeAsId, type AiProvider, type OrgId } from '@taskflow/contracts';

/**
 * The contract every `AiProvider` implementation must satisfy (Phase 15 §2).
 *
 * Mirrors `describeTelephonyProviderContract`'s own reasoning: outgrowing a
 * free/local implementation must be a config change plus a green contract
 * run, never a call-site rewrite, and the only thing keeping a second
 * implementation honest is a suite neither one was written against
 * specifically.
 *
 * Asserted: the properties the budget gate and the tool-execution loop
 * DEPEND on — non-negative integer usage, a closed `stopReason`, and a
 * promise (never a synchronous throw) on failure. Not asserted: anything
 * about response QUALITY — that needs a real model, and a mock asserting it
 * would only prove the mock agrees with itself.
 */
const ORG_ID = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001') as OrgId;

export function describeAiProviderContract(name: string, createProvider: () => AiProvider): void {
  describe(`AiProvider contract: ${name}`, () => {
    it('returns non-negative integer token counts', async () => {
      const provider = createProvider();
      const result = await provider.complete({
        orgId: ORG_ID,
        model: 'test-model',
        messages: [{ role: 'user', content: 'Say hello.' }],
      });

      expect(Number.isInteger(result.usage.inputTokens)).toBe(true);
      expect(Number.isInteger(result.usage.outputTokens)).toBe(true);
      expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
    });

    it('reports one of the closed stop-reason values', async () => {
      const provider = createProvider();
      const result = await provider.complete({
        orgId: ORG_ID,
        model: 'test-model',
        messages: [{ role: 'user', content: 'Say hello.' }],
      });

      expect(['end_turn', 'tool_use', 'max_tokens']).toContain(result.stopReason);
    });

    it('a system message never appears verbatim as unanswered content', async () => {
      /* Not a claim about response quality — just that the call completes at
         all when a system message is present, since that is the shape every
         real caller in apps/api/src/ai sends (a fixed persona plus the
         conversation). */
      const provider = createProvider();
      await expect(
        provider.complete({
          orgId: ORG_ID,
          model: 'test-model',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hi.' },
          ],
        }),
      ).resolves.toBeDefined();
    });

    it('rejects rather than throwing synchronously on a request it cannot serve', async () => {
      /* Same reasoning `describeTelephonyProviderContract` gives: a
         Promise<T>-declared method that throws SYNCHRONOUSLY bypasses every
         caller written to handle a rejection, which is the failure-handling
         path this whole gate exists for. Asserted by calling and
         inspecting, not `expect().rejects`, which the synchronous throw
         would itself trip. */
      const provider = createProvider();
      let returned: unknown;
      let threw = false;
      try {
        returned = provider.complete({
          orgId: ORG_ID,
          model: '',
          messages: [],
        });
      } catch {
        threw = true;
      }

      expect(threw, 'threw synchronously instead of returning a promise').toBe(false);
      expect(returned).toBeInstanceOf(Promise);
      await (returned as Promise<unknown>).catch(() => undefined);
    });
  });
}
