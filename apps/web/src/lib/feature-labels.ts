/**
 * Human copy for the feature flags a plan can grant.
 *
 * ## Why this is client-side rather than sent by the server
 *
 * The registry in `packages/feature-flags` already carries a `description`,
 * and the server does send it on some routes — but those strings are written
 * for DEVELOPERS ("Chat module: channels, DMs, threads"). A customer choosing
 * a plan and an operator pricing one need different sentences from the ones a
 * release checklist needs, and rewriting the registry to serve all three would
 * make it worse at its actual job.
 *
 * So this is PRESENTATION, and it lives with the presentation layer.
 *
 * ## Unknown keys must degrade, never throw
 *
 * The registry is the source of truth for which flags EXIST; this map is only
 * copy. A flag added there and not here renders its raw name — slightly ugly,
 * always correct. Every call site uses `?? flagName` for exactly that reason:
 * a plan must never fail to render because someone shipped a module before
 * writing marketing copy for it.
 */

export interface FeatureCopy {
  /** Short product name, for a chip or a checklist row. */
  readonly label: string;
  /** One sentence: what the customer gets. Shown under the label. */
  readonly description: string;
}

export const FEATURE_COPY: Readonly<Record<string, FeatureCopy>> = {
  chat: {
    label: 'Chat',
    description: 'Channels, direct messages, threads and file sharing.',
  },
  docs: {
    label: 'Docs',
    description: 'Collaborative documents with live editing, comments and version history.',
  },
  telephony: {
    label: 'Voice & messaging',
    description: 'Phone numbers, calls, SMS, recordings and transcripts.',
  },
  tqlTextSyntax: {
    label: 'Advanced search',
    description: 'Write queries as text instead of building them with the visual filter.',
  },
  automation: {
    label: 'Automation',
    description: 'Rules that react to activity — assign, notify, move, or call out to Slack.',
  },
  publicApi: {
    label: 'Public API',
    description: 'Scoped API tokens for building against this workspace programmatically.',
  },
  analytics: {
    label: 'Analytics',
    description: 'Dashboards and reporting across projects, people and throughput.',
  },
};

/** Short label, falling back to the raw flag name. */
export function featureLabel(flagName: string): string {
  return FEATURE_COPY[flagName]?.label ?? flagName;
}

/** One-sentence explanation, or null when there is no copy for this flag yet. */
export function featureDescription(flagName: string): string | null {
  return FEATURE_COPY[flagName]?.description ?? null;
}

/**
 * What each plan LIMIT means, for the operator console's editor.
 *
 * Written for whoever is setting the number, not for whoever is billed by it —
 * an operator typing into these fields needs to know what the number bounds
 * and what happens at zero, which is not something a field label can carry.
 */
export const LIMIT_COPY: Readonly<Record<string, string>> = {
  telephonyCapCents:
    'The most an organization on this plan may spend on calls and SMS in a rolling 30 days. This is a CEILING, not an allocation — an owner can set their own cap anywhere up to it, and never above. Empty means unlimited; 0 refuses all outbound calls and messages.',
  automationRunsPerHour:
    'How many automation rules may execute per hour. A runaway rule burns its own allowance and stops, leaving the rest of the product working. Empty means unlimited; 0 disables automation execution.',
  turnIssuancePerDay:
    'How many relay credentials may be issued per day for in-app calls. Relayed call media is bandwidth billed to this deployment, and the count is kept in the database so a restart does not reset it. Empty means unlimited; 0 forces every call to connect directly or not at all.',
  telephonyIncludedCents:
    'How much call and SMS usage the subscription already covers each period. Past this, overage accrues to the next invoice at the markup below. Requires a paid plan — there is no subscription to bill a free tier against.',
  telephonyMarkupPct:
    'What is added to the carrier’s own cost when billing usage past the included allowance. 0 bills exactly what the carrier charged; 50 bills one and a half times it. This is the platform’s margin on metered usage.',
  aiTokenBudgetMonthlyCents:
    'The most an organization on this plan may spend on AI assistant completions in a rolling month, at each provider’s own published rates. Same CEILING convention as the telephony cap above — an owner can set their own budget anywhere up to it, never above. Empty means unlimited; 0 refuses every completion.',
};
