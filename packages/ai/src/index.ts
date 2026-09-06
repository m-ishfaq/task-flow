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
export { OpenAiProvider, OpenAiApiError, type OpenAiConfig } from './openai.js';
export { GeminiProvider, GeminiApiError, type GeminiConfig } from './gemini.js';

/* `describeAiProviderContract` is DELIBERATELY not re-exported from this
   entry, even though a future `AiProvider` in another package must be able to
   run the suite: `contract-test.ts` imports vitest at its top level, and
   re-exporting it would drag vitest into the runtime graph of every consumer.
   apps/api boots through `@taskflow/ai` and crashed outside a test worker with
   "Vitest failed to access its internal state." (the eager `createExpect` in
   vitest's `vi` chunk throws when no worker state exists) — the exact failure
   `packages/telephony/src/index.ts`'s own header already documents once for
   `describeTelephonyProviderContract`; this package repeated the mistake
   rather than following that precedent. The suite stays reachable to other
   packages through the `@taskflow/ai/contract-test` subpath export
   (package.json) — import that only from test code, never from a runtime
   module. */
