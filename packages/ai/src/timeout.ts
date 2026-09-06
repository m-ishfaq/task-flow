/**
 * Every real `AiProvider`'s outbound completion request bounds itself to
 * this — none of the three (`AnthropicProvider`, `OpenAiProvider`,
 * `GeminiProvider`) set any timeout on their own `fetch` call before this
 * existed, which meant a provider that stalled (a TLS hang, a connection
 * accepted and never answered — real, if rare, failure modes for a
 * third-party HTTPS endpoint) left `AiProvider.complete`'s promise pending
 * FOREVER. That is not a slow request; it is a wedged one, and nothing
 * downstream can tell the difference from the outside.
 *
 * Found from a real report: `ai.chat.send`'s tRPC mutation never settled,
 * so `apps/web`'s assistant page — whose Approve/Decline buttons, composer,
 * and send button are all gated on that ONE mutation's `isPending` — stayed
 * permanently disabled with no error to recover from and no way out short
 * of a hard reload. `AbortSignal.timeout` is what `apps/worker`'s own
 * webhook delivery already uses for the identical "bound a fetch to a third
 * party this deployment does not control" problem
 * (`apps/worker/src/webhooks/delivery.ts`'s `TIMEOUT_MS`); a timed-out
 * `fetch` REJECTS rather than hanging, which turns a wedged request back
 * into an ordinary thrown error — the same case every provider's `!response.ok`
 * branch already handles — so the tRPC route answers, `turn.isError` becomes
 * true, and the UI's buttons re-enable on their own, no reload required.
 *
 * 90 seconds, not `delivery.ts`'s 15: a webhook is one HTTP round trip to an
 * endpoint an operator configured; a completion is a real LLM inference
 * call, slower by nature and slower still with tools attached or a large
 * system prompt, so a much tighter bound would misclassify a legitimately
 * slow-but-working answer as wedged.
 */
export const COMPLETION_TIMEOUT_MS = 90_000;
