/**
 * @taskflow/ai — the LLM carrier boundary (Phase 15 §2,
 * ai/phase-15-ai-copilot-and-permissions.md).
 *
 * Everything here is an `AiProvider` implementation. No prompt assembly, no
 * tool registry, no budget policy — those are database and product
 * questions and live in `apps/api/src/ai`, the same split
 * `@taskflow/telephony`/`apps/api/src/telephony` and
 * `@taskflow/payments`/`apps/api/src/billing` already keep.
 */

export { FakeAiProvider } from './fake.js';
export { AnthropicProvider, AnthropicApiError, type AnthropicConfig } from './anthropic.js';
export { describeAiProviderContract } from './contract-test.js';
