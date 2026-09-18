import type { FastifyInstance } from 'fastify';
import { resolveUserByFeedToken } from './calendar-feed-tokens.js';
import { buildCalendarFeed } from '../work/calendar-feed.service.js';
import { formatIcsFeed } from '../work/ics.js';
import { getResolvedBranding } from '../platform-admin/branding-cache.js';

/**
 * `GET /calendar/:tokenFile` — a plain Fastify route, registered BEFORE the
 * tRPC plugin, the identical shape and reasoning as the carrier/billing/
 * connector webhook routes: the caller here is a calendar application
 * subscribing to a URL, which has no session to present and none of the
 * five tRPC route kinds (`route`, `memberRoute`, `selfRoute`,
 * `platformRoute`, `publicRoute`) is shaped for "resolve identity from a
 * bare bearer token with zero other context."
 *
 * ⚠ HUMAN REVIEW SURFACE — see `identity/calendar-feed.service.ts`'s own
 * header for the accepted tradeoff this route embodies (a long-lived
 * bearer token in a URL, a deliberate exception to this codebase's
 * otherwise-consistent "re-validate against RLS, never a bearer
 * capability" stance).
 *
 * ## No distinguishing 404
 *
 * An unknown token and a revoked one both answer a bare 404 — the same
 * discipline `docs.public.getPage` already applies for an unpublished
 * page, and the reason `resolveUserByFeedToken`'s own header states: a
 * calendar app that once had a working subscription and a script probing
 * random tokens must not be able to tell the two apart from the response
 * alone.
 *
 * ## Rate limiting: token entropy, not a request budget
 *
 * The global per-IP volumetric limiter (`middleware/rate-limit.ts`'s
 * `GLOBAL`, 300/min) already covers this route like every other — nothing
 * bespoke is added on top of it. `OPERATION_RULES` is keyed by tRPC
 * PROCEDURE name and is wired into the tRPC adapter's own middleware; it
 * has no meaning for a plain Fastify route with no procedure to name, so
 * copying that mechanism here would be decoration, not a real control. The
 * actual defense is the same one `tf_ev`/`tf_pr` email-delivered tokens
 * already rely on: 256 bits of CSPRNG output (`issueToken`), which makes
 * guessing infeasible regardless of how many requests an attacker is
 * allowed to make.
 */
export function registerCalendarFeedRoute(
  app: FastifyInstance,
  deps: { readonly webOrigin: string },
): void {
  app.get<{ Params: { tokenFile: string } }>('/calendar/:tokenFile', async (request, reply) => {
    const { tokenFile } = request.params;
    const rawToken = tokenFile.endsWith('.ics') ? tokenFile.slice(0, -4) : tokenFile;

    const userId = await resolveUserByFeedToken(rawToken);
    if (userId === undefined) return reply.status(404).send();

    const [cards, branding] = await Promise.all([
      buildCalendarFeed(userId, deps.webOrigin),
      getResolvedBranding(),
    ]);
    const ics = formatIcsFeed(cards, new Date(), branding.productName);

    return reply.type('text/calendar; charset=utf-8').send(ics);
  });
}
