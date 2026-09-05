/**
 * Per-model token pricing (ai/phase-15-ai-copilot-and-permissions.md §3.1:
 * "cost in cents, computed from a per-model rate table, same shape as
 * telephony's carrier rate tables").
 *
 * Cents per MILLION tokens, matching how every provider in this market
 * publishes its own price sheet — computing in that unit and dividing once
 * keeps the arithmetic in integers as long as possible rather than
 * accumulating floating-point cents across two multiplications.
 *
 * A model absent from this table is a configuration error, not a free
 * completion: `costCentsFor` throws rather than defaulting to zero, because
 * a silent zero-cost model is a silent hole in the budget gate it feeds.
 */

interface ModelRate {
  readonly inputCentsPerMillion: number;
  readonly outputCentsPerMillion: number;
}

const RATES: Readonly<Record<string, ModelRate>> = {
  /* Published list prices at the time this table was written. Anthropic
     prices output tokens well above input tokens, unlike telephony's flat
     per-minute rate — both numbers are carried rather than one blended
     figure so a rate change needs no shape change here, only new values. */
  'claude-opus-4': { inputCentsPerMillion: 1_500, outputCentsPerMillion: 7_500 },
  'claude-sonnet-4': { inputCentsPerMillion: 300, outputCentsPerMillion: 1_500 },
  'claude-haiku-4': { inputCentsPerMillion: 80, outputCentsPerMillion: 400 },

  /* OpenAI. Same "published list price, carried as two numbers" shape. */
  'gpt-4o': { inputCentsPerMillion: 250, outputCentsPerMillion: 1_000 },
  'gpt-4o-mini': { inputCentsPerMillion: 15, outputCentsPerMillion: 60 },

  /* Gemini. */
  'gemini-1.5-pro': { inputCentsPerMillion: 125, outputCentsPerMillion: 500 },
  'gemini-1.5-flash': { inputCentsPerMillion: 7.5, outputCentsPerMillion: 30 },
};

export class UnknownModelRateError extends Error {
  constructor(readonly model: string) {
    super(
      `No rate configured for AI model "${model}". Add it to RATES before this model can be used.`,
    );
    this.name = 'UnknownModelRateError';
  }
}

export function costCentsFor(
  model: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number },
): number {
  const rate = RATES[model];
  if (rate === undefined) throw new UnknownModelRateError(model);

  const inputCents = (usage.inputTokens * rate.inputCentsPerMillion) / 1_000_000;
  const outputCents = (usage.outputTokens * rate.outputCentsPerMillion) / 1_000_000;

  /* Rounded up, never down or to nearest: undercharging on every completion
     is a systematic revenue leak that compounds across every org, while
     overcharging by a fraction of a cent on rounding is invisible on a
     dashboard measured in dollars. */
  return Math.ceil(inputCents + outputCents);
}
