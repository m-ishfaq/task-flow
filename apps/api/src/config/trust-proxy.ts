import { z } from 'zod';

/**
 * How far to trust `X-Forwarded-For`.
 *
 * The default is `false`, and that default is the point. Fastify's `trustProxy:
 * true` — which this app previously hardcoded — means the client address is
 * whatever the leftmost entry of a caller-supplied header says it is. Every
 * per-IP rate limit then becomes opt-out (send a fresh `X-Forwarded-For` per
 * request and each one is a new address), and every audit entry records an
 * attacker-chosen origin.
 *
 * Accepted forms:
 *   false           no proxy — the client address is the socket address
 *   <n>             trust exactly n hops, counted from the right
 *   <cidr>,<cidr>   trust these proxy addresses
 *
 * `true` is rejected on purpose: there is no deployment it is correct for that a
 * hop count does not also cover, and the error is cheaper than the silent
 * disabling of a control.
 *
 * ## Why this lives in its own module
 *
 * `apps/realtime` needs the identical decision for its per-IP connection limit
 * (ai/phase-4-realtime.md §6.5), and a socket gateway that got this wrong would
 * make that limit opt-out in exactly the same way. Two copies of a schema whose
 * whole value is the ONE case it refuses is how the refusal goes missing from
 * one of them. Both apps parse the same schema, and the output form is the one
 * `proxy-addr` accepts — which is also what Fastify feeds to `proxy-addr`
 * internally, so the two apps resolve a client address identically.
 */
export const TrustProxy = z
  .string()
  .default('false')
  .superRefine((value, ctx) => {
    if (value.trim() === 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'TRUST_PROXY=true trusts an X-Forwarded-For header from anyone, which makes every ' +
          'per-IP rate limit opt-out. Use a hop count (e.g. 1) or a CIDR list instead.',
      });
    }
  })
  .transform((value): boolean | number | string => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'false') return false;
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  });

/** The parsed form: `false`, a hop count, or a CIDR list. */
export type TrustProxyValue = z.infer<typeof TrustProxy>;
