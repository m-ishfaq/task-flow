import type { AiCompletionRequest, AiCompletionResult, AiProvider } from '@taskflow/contracts';

/**
 * In-memory `AiProvider` — every AI route must work end-to-end against this
 * with zero API key, the identical non-negotiable `FakeTelephonyProvider`
 * and `FakePaymentProvider` already set: a developer cloning this repo must
 * not need an Anthropic account to run `pnpm verify`.
 *
 * `calls` is public and growing, the same reason `FakePaymentProvider`
 * exposes `invoiceItems`: the single most important property the budget
 * gate (§3.2) needs to prove is "the provider was never reached" for a
 * refused request, and the only way to assert that is to inspect what this
 * fake was actually asked to do, not merely that a refusal came back.
 */
export class FakeAiProvider implements AiProvider {
  readonly isLive = false;

  readonly calls: AiCompletionRequest[] = [];

  /**
   * Canned per-model response queue. Defaults to a short, deterministic
   * completion with a fixed token count — tests that care about the exact
   * usage numbers push their own response first via `enqueue`.
   */
  private readonly queue: AiCompletionResult[] = [];

  enqueue(result: AiCompletionResult): void {
    this.queue.push(result);
  }

  complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.calls.push(request);

    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);

    return Promise.resolve({
      content: 'This is a fake completion.',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 8 },
      stopReason: 'end_turn',
    });
  }
}
