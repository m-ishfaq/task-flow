import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Connector governance events (ai/phase-10-automation.md §7.8, Wave 4).
 *
 * The audit facts around the org's provider authorizations — who connected
 * this Slack workspace, when it was disconnected. The names use the lowercase
 * `integration.*` resource per the registry's convention (the `integration`
 * entry has been in RESOURCE_TYPES and the tuples object_type CHECK since
 * 0005, waiting for exactly this surface).
 *
 * Two things never appear in an event:
 *
 *   - the outbound credential, obviously — it is envelope-encrypted at rest
 *     and exists in plaintext only inside the connect flow's own process;
 *   - the GitHub per-org verify secret — the same rule the webhook events
 *     apply: the audit log must not carry a fragment of a secret. It is
 *     shown exactly once, by the mutation that mints it.
 *
 * `providerScope` IS carried: \"which workspace / repository\" is the question
 * an access review of a connector asks, and the row is keyed on it.
 */
export const integrationConnected = defineEvent(
  'integration.connected',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
      name: z.string(),
    })
    .strict(),
);

/**
 * A GitHub connect's credential was stored but no repository chosen yet.
 *
 * Emitted by `complete` for GitHub — the row is written (status
 * 'disconnected', awaiting `selectRepo`) and guardrail 11 demands the write be
 * observable: if the person abandons the picker, this event is the ONLY record
 * that the org's credential for this login ever existed. `selectRepo` then
 * emits `integration.connected` and the connect completes; a row that never
 * gets one stays pending in the audit trail, which is the honest shape of "who
 * authorized what" when an access review asks.
 *
 * `provider` is always 'github' in practice; the enum is shared with the
 * other two events so the three read alike and a future provider with a
 * two-step connect inherits the shape without a schema change.
 */
export const integrationPending = defineEvent(
  'integration.pending',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
    })
    .strict(),
);

export const integrationDisconnected = defineEvent(
  'integration.disconnected',
  z
    .object({
      integrationId: z.string(),
      provider: z.enum(['slack', 'github']),
      providerScope: z.string(),
    })
    .strict(),
);
