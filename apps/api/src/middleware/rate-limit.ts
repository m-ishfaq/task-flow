import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errors } from '@taskflow/contracts';
import { hashToken } from '@taskflow/security';
import { SlidingWindowLimiter, type RateLimitRule } from './sliding-window.js';

/**
 * Per-IP rate limiting at the gateway (PLAN.md §8.9).
 *
 * ## Two tiers, because they stop different things
 *
 * 1. A **volumetric** limit on every request from an address. This is the one
 *    that keeps a single host from consuming the process, and it applies to
 *    health checks and product routes alike.
 * 2. A **per-operation** limit on the authentication routes, keyed by address
 *    AND by the account being acted on where the body names one.
 *
 * The account in the key is the part that took two attempts to get right. A flat
 * "5 login attempts per IP per 15 minutes" reads like the spec (§8.9) and is
 * unusable: one office behind one NAT address shares that budget, so the sixth
 * person to arrive in the morning cannot sign in. Keying on address AND email
 * gives the same 5-per-15-minutes protection against guessing one account from
 * one source, while a hundred colleagues signing into a hundred accounts never
 * collide.
 *
 * ## What this is NOT
 *
 * Not the per-account defence. That is the lockout in identity.service.ts, which
 * lives in Postgres and therefore survives a restart and applies across every
 * instance. These counters are in-process (§12 free-tier position), so a restart
 * forgives everyone — acceptable for volumetric abuse, useless as the only thing
 * standing between an attacker and a password. The two are deliberately
 * different mechanisms rather than one mechanism used twice.
 */

/** Every request from one address, regardless of route. */
const GLOBAL: RateLimitRule = { limit: 300, windowMs: 60_000 };

/**
 * Per-operation limits.
 *
 * The numbers are chosen against a legitimate user's worst realistic day, not
 * against a comfortable average: someone who mistypes a password four times and
 * then requests a reset must not be throttled.
 */
const OPERATION_RULES: Readonly<Record<string, RateLimitRule>> = {
  /* §8.9's "5 per 15 min", scoped per account rather than per address. */
  'auth.login': { limit: 5, windowMs: 15 * 60_000 },

  /* §8.9's "3 per hour". Each one sends mail to an address the requester does
     not control, so this doubles as anti-spam for other people's inboxes. */
  'auth.requestPasswordReset': { limit: 3, windowMs: 60 * 60_000 },

  /* Also sends mail. Slightly looser than reset because a genuine signup can
     legitimately be retried after a typo'd address. */
  'auth.register': { limit: 5, windowMs: 60 * 60_000 },

  /* Token guessing. No account is named, so this one is per address — and a
     legitimate client hits it once per link, never in a loop. */
  'auth.verifyEmail': { limit: 20, windowMs: 60 * 60_000 },
  'auth.resetPassword': { limit: 20, windowMs: 60 * 60_000 },

  /* A well-behaved client refreshes about six times an hour. Generous, because
     no account is named and a shared address must not throttle a whole office
     out of their sessions — reuse detection is the real control here. */
  'auth.refresh': { limit: 240, windowMs: 60 * 60_000 },

  /* Chat (ai/phase-5-chat.md §6.5, which names this obligation explicitly:
     "message-send rate per user per channel (spam)").

     Sixty a minute is well above what a person types and well below what a
     script sends. The number is chosen against the worst realistic HUMAN case —
     somebody pasting a stack trace as eight consecutive messages, or a fast
     back-and-forth during an incident — rather than a comfortable average,
     because a limit that throttles a real conversation is one that gets raised
     until it stops protecting anything.

     Per ACCOUNT, not per channel, despite §6.5's wording. Per-channel is the
     weaker control for the abuse that matters: someone flooding an
     organization posts across many channels, and a per-channel budget grants
     them the full rate in each. `accountOf` already keys on the caller for
     `auth.login`, so this reuses a mechanism rather than adding a second one. */
  'chat.messages.send': { limit: 60, windowMs: 60_000 },

  /* An upload is a presigned PUT — a capability to place bytes in this org's
     bucket — and each one costs a scan. Tighter than sending, because nobody
     attaches thirty files a minute by hand. */
  'chat.attachments.presign': { limit: 30, windowMs: 60_000 },

  /* Opening a DM writes membership tuples. Bounded so that enumerating the
     member directory by opening a conversation with everybody is slow enough
     to notice. */
  'chat.channels.openDirect': { limit: 30, windowMs: 60_000 },

  /* Self-serve org creation (Phase 12 §3.4, §7 decision 3). Generous for a
     legitimate person setting up a company and a personal workspace in the
     same day, cheap to raise later, expensive to have shipped unset. No
     `email` field on this route's input, so `accountOf` returns null and the
     key falls back to `bearerScope` — per-caller, exactly what this needs. */
  'tenancy.orgs.create': { limit: 3, windowMs: 24 * 60 * 60_000 },
};

export interface RateLimitOptions {
  /** Injected so tests can assert against a limiter they control. */
  readonly limiter?: SlidingWindowLimiter;
  /** Disables enforcement while still exercising the path. Tests only. */
  readonly enabled?: boolean;
}

/**
 * The tRPC procedure(s) a request targets.
 *
 * A batched call names several in one path (`/trpc/a.b,c.d?batch=1`), so this
 * returns all of them and the caller applies every matching rule. Missing that
 * would make batching a bypass: wrap the throttled procedure next to a cheap one
 * and the strict rule never gets looked up.
 */
export function proceduresOf(url: string): readonly string[] {
  const path = url.split('?')[0] ?? '';
  const match = /^\/trpc\/(.+)$/.exec(path);
  if (!match?.[1]) return [];

  return decodeURIComponent(match[1])
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Largest body this will parse to find an account.
 *
 * A login body is a couple of hundred bytes. Parsing up to the 1 MB body limit
 * on every request, inside a hook whose job is to make abuse cheap to refuse,
 * would be its own denial-of-service. Anything larger falls back to keying by
 * address, which is stricter rather than looser.
 */
const MAX_BODY_FOR_KEYING = 4_096;

/**
 * The account a request is about, if its body names one.
 *
 * ## Why this parses
 *
 * The tRPC Fastify adapter REPLACES the JSON content-type parser with a
 * pass-through that leaves `request.body` as a string (see its
 * `addContentTypeParser('application/json', { parseAs: 'string' })`). So on
 * every `/trpc` route the body is text, and the obvious `body.email` reads
 * undefined.
 *
 * That is not a cosmetic bug. It silently downgraded per-account keying to
 * per-address keying — which is the office-NAT behaviour this design exists to
 * avoid — and the first test written for it passed anyway, because five
 * attempts followed by a refusal looks identical under both keys.
 *
 * Only ever an email, and only from the field where one legitimately appears.
 * Reading an arbitrary caller-supplied field into a rate limit key would let a
 * caller pick a fresh key per attempt and opt out of the limit entirely.
 */
export function accountOf(body: unknown): string | null {
  const parsed = asRecord(body);
  if (parsed === null) return null;

  const direct = normalizeAccount(parsed['email']);
  if (direct !== null) return direct;

  /* A batched call nests each input under its index: `{"0":{"email":…}}`. Taking
     the first email present is deliberately blunt — a batch that names an
     account gets keyed to it, which is the strict direction. */
  for (const value of Object.values(parsed)) {
    const nested = asRecord(value);
    if (nested === null) continue;

    const email = normalizeAccount(nested['email']);
    if (email !== null) return email;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_BODY_FOR_KEYING) return null;
    try {
      return asRecord(JSON.parse(value));
    } catch {
      // Malformed JSON is tRPC's problem to report, not this hook's.
      return null;
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeAccount(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 254 ? normalized : null;
}

/**
 * Registers both tiers on a Fastify instance.
 *
 * The volumetric tier runs `onRequest` — before body parsing, so a flood costs
 * as little as possible. The per-operation tier runs `preValidation`, which is
 * the earliest hook where the parsed body is available and therefore the
 * earliest point the account can enter the key.
 */
export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions = {}): void {
  const limiter = options.limiter ?? new SlidingWindowLimiter();
  const enabled = options.enabled ?? true;

  app.addHook('onRequest', async (request, reply) => {
    if (!enabled) return undefined;

    const verdict = limiter.check(`ip:${clientKey(request)}`, GLOBAL);
    return verdict.allowed ? undefined : refuse(request, reply, verdict.retryAfterSeconds);
  });

  app.addHook('preValidation', async (request, reply) => {
    if (!enabled) return undefined;

    const account = accountOf(request.body);

    for (const procedure of proceduresOf(request.url)) {
      const rule = OPERATION_RULES[procedure];
      if (rule === undefined) continue;

      /* The account, when there is one, REPLACES the address in the key rather
         than joining it. Otherwise an attacker guessing one account from a
         thousand addresses gets a thousand separate budgets, which is the
         distributed case this is supposed to cover. */
      const scope = account ?? bearerScope(request) ?? `ip:${clientKey(request)}`;
      const verdict = limiter.check(`op:${procedure}:${scope}`, rule);

      if (!verdict.allowed) return refuse(request, reply, verdict.retryAfterSeconds);
    }
    return undefined;
  });
}

/**
 * The address a request is attributed to.
 *
 * `request.ip` honours `trustProxy`, which is configured from the environment
 * rather than left on — see the note in config/env.ts. With it wrongly enabled,
 * `X-Forwarded-For` is caller-controlled and every one of these limits becomes
 * opt-out.
 */
function clientKey(request: FastifyRequest): string {
  return request.ip.length > 0 ? request.ip : 'unknown';
}

/**
 * A per-CALLER key for authenticated operations, from the bearer token.
 *
 * ## Why not the address, and why not the account
 *
 * `accountOf` reads an email out of the body, which only the auth routes send.
 * Every other operation would therefore fall back to the ADDRESS — and an
 * office behind one NAT would share a single sixty-messages-a-minute budget,
 * which throttles a real conversation. A limit that does that gets raised until
 * it stops protecting anything, which is worse than not having it.
 *
 * ## This is NOT an authentication decision
 *
 * The token is not verified here and nothing is trusted from it. It is an
 * opaque bucket key: two requests carrying the same token share a budget, and
 * that is the entire claim. A forged token gets its own bucket and is then
 * rejected by the real authentication a layer later — which is the right
 * outcome, because it means an attacker cannot present somebody else's token to
 * consume THEIR budget, only their own.
 *
 * ## Hashed rather than used raw
 *
 * Through `@taskflow/security`, because a bearer token should not sit in a
 * long-lived in-process map even one that never leaves the process: the next
 * person to add a debug log over these keys would be printing credentials.
 */
function bearerScope(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;

  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  return token.length === 0 ? null : `tok:${hashToken(token)}`;
}

/**
 * tRPC's JSON-RPC code for TOO_MANY_REQUESTS.
 *
 * A literal because tRPC exports its code table only from
 * `unstable-core-do-not-import`, and pinning this repo to that path would make a
 * patch release of a dependency a build break. `rate-limit.test.ts` asserts the
 * emitted body is one the real client can read, so a change on their side fails
 * a test rather than surfacing as an unreadable error in a browser.
 */
const TRPC_TOO_MANY_REQUESTS = -32029;

/**
 * Answers 429 and stops the hook chain.
 *
 * Returning the reply is what stops it — a Fastify async hook that merely calls
 * `send` and returns undefined lets the request continue to the handler, which
 * here would mean the throttled login runs anyway and the 429 is decoration.
 *
 * ## The body has to match the PROTOCOL of the route being refused
 *
 * This hook runs before tRPC, on every route, so it is the one place that has to
 * know there are two error envelopes in this system:
 *
 *   REST   `{ error: { code, message, requestId, retryAfterSeconds } }`
 *   tRPC   `{ error: { message, code: <number>, data: { code, httpStatus, … } } }`
 *
 * It used to send the REST envelope everywhere, with a comment claiming it was
 * "the same envelope the tRPC layer produces". It is not, and the consequence
 * was specific and bad: the tRPC client could not parse it at all — it failed
 * with "Unable to transform response from server" and `error.data` undefined —
 * so the browser rendered its generic "something went wrong, the server did not
 * say what" for the ONE failure that is completely self-explanatory and arrives
 * with a `retry-after` telling you exactly how long to wait.
 *
 * Nothing failed. The header was right, the status was right, the JSON was
 * well-formed, and the message was unreachable.
 */
async function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  retryAfterSeconds: number,
): Promise<FastifyReply> {
  const error = errors.rateLimited(retryAfterSeconds);
  const envelope = error.toResponse(request.id);

  const body = request.url.startsWith('/trpc')
    ? {
        error: {
          message: envelope.error.message,
          code: TRPC_TOO_MANY_REQUESTS,
          data: {
            code: envelope.error.code,
            httpStatus: 429,
            requestId: envelope.error.requestId,
            retryAfterSeconds,
          },
        },
      }
    : envelope;

  await reply.status(429).header('retry-after', String(retryAfterSeconds)).send(body);

  return reply;
}
