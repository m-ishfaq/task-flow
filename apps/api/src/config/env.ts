import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TrustProxy } from './trust-proxy.js';
import { DEFAULT_PRODUCT_NAME } from '../platform-admin/branding-cache.js';

/**
 * Validated environment — guardrail 7 (PLAN.md §2.1, §8.7).
 *
 * The rest of the workspace is forbidden by lint from touching `process.env`.
 * Everything arrives through this schema, so a missing or malformed variable
 * fails at BOOT with a message naming the variable, rather than surfacing as
 * `undefined` inside a request handler three weeks later — which is how a
 * misconfigured signing key becomes an authentication bypass instead of a crash.
 */

const NonEmpty = z.string().min(1);

/** 32 bytes, base64. Rejecting a short key here beats an AES error at runtime. */
const Base64Key = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be 32 bytes of base64-encoded key material' },
);

/**
 * A PEM key block (PKCS8 private or SPKI public), base64-encoded so it
 * survives a single-line `.env` file the same way `Base64Key` above does.
 * Only checks it decodes to something PEM-shaped — `importAccessTokenPrivateKey`
 * / `importAccessTokenPublicKey` do the real structural validation at boot,
 * where a malformed key fails loudly with jose's own error rather than
 * silently here.
 */
const Base64PemKey = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').toString('utf8').includes('-----BEGIN');
    } catch {
      return false;
    }
  },
  { message: 'must be a base64-encoded PEM key block' },
);

/* An optional variable arrives as the EMPTY STRING whenever a compose file or
   .env entry is present-but-blank — compose.prod.yaml passes every optional
   variable through `${VAR:-}`, which yields '' for an unset one — and
   present-but-empty is exactly the same thing as "not set". Rejecting it made
   a valid deployment with unconfigured OAuth/telephony providers fail to boot
   (found by the first real `docker compose up` of compose.prod.yaml).

   Applied to every optional CONFIG string. The DATABASE_*_URL optionals
   (DATABASE_AUDIT_URL etc.) are deliberately exempt: compose.prod.yaml always
   builds those from a required password, so they cannot arrive empty, and a
   blank one is a misconfiguration that should fail loudly rather than read as
   "role disabled". */
function optionalSetting<S extends z.ZodTypeAny>(schema: S) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

const OptionalNonEmpty = optionalSetting(NonEmpty);
const OptionalUrl = optionalSetting(z.string().url());
const OptionalKey = optionalSetting(Base64Key);

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    /* Two URLs, never one. taskflow_app cannot bypass RLS and has no DDL
       rights; collapsing them would hand the runtime role the ability to drop
       its own RLS policies (§8.3). */
    DATABASE_URL: NonEmpty,
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

    /* A THIRD role, for the audit projection (§8.6). taskflow_audit holds
       INSERT and SELECT on audit.audit_log and no UPDATE or DELETE anywhere, so
       the compliance record cannot be rewritten even by the process that writes
       it.

       Optional, and the consequence of omitting it is deliberately loud rather
       than silent: `withAuditScope` throws instead of falling back to the
       application role, which could not write an audit entry anyway. An API
       instance that only serves requests does not need it; the one running the
       outbox relay does. */
    DATABASE_AUDIT_URL: NonEmpty.optional(),

    /* A FIFTH role, for the backlinks relay (Phase 6 Wave 3, ai/phase-6-docs.md
       §3.10; migration 0025's own header). taskflow_backlinks holds only a
       COLUMN-LEVEL grant on docs.page_versions — id/org_id/page_id/created_at,
       never state — so this role can discover which pages changed and can
       never read a byte of what changed.

       Optional, matching DATABASE_AUDIT_URL's own reasoning exactly: an API
       instance that only serves requests does not need it; the one running
       the relay does, and `withBacklinksScope` throws rather than silently
       falling back to the application role, which cannot see across every
       tenant's page_versions in one claim. */
    DATABASE_BACKLINKS_URL: NonEmpty.optional(),

    /* A NINTH role, for the search indexer's claim (Phase 8 Wave 2,
       ai/phase-8-search.md §2.3; migration 0045's own header).
       taskflow_search can SELECT from platform.outbox and read/write its own
       outbox_dispatch rows (consumer = 'search') across every tenant, and
       holds NOTHING on search.documents — the indexing happens per event,
       over DATABASE_URL, under ordinary org scoping. Optional, matching
       DATABASE_BACKLINKS_URL: an instance that only serves requests does
       not need it; the one running the relay does, and `withSearchScope`
       throws rather than silently falling back to the application role,
       which cannot see across every tenant's outbox in one claim. */
    DATABASE_SEARCH_URL: NonEmpty.optional(),

    /* A SIXTH role, for the due-reminder sweep (Phase 9 Wave 2,
       ai/phase-9-notifications.md §3.8; migration 0029's own header).
       taskflow_notification_sweep holds a COLUMN-LEVEL grant on work.cards
       — id/org_id/board_id/title/number/due_date/assignee_ids, nothing else
       — so this role can discover which cards are due and can never read a
       card's description or rank. Optional, matching DATABASE_BACKLINKS_URL:
       an instance that only serves requests does not need it; the one
       running the sweep does, and `withSweepScope` throws rather than
       silently falling back to the application role, which cannot see across
       every tenant's cards in one scan. */
    DATABASE_NOTIFICATION_SWEEP_URL: NonEmpty.optional(),

    /* An EIGHTH role, for the platform-admin console (Phase 12 Wave 1,
       ai/phase-12-admin.md §3.7; migration 0035's own header).
       taskflow_platform_admin reads identity.orgs and identity.memberships
       across every tenant (the org directory) and writes orgs.status — it
       holds nothing on any product table. Optional, matching every other
       consumer role: an instance that never serves a platform console
       request does not need it, and `withPlatformAdminScope` throws rather
       than silently falling back to the application role, which cannot see
       across every tenant's orgs in one pass. */
    DATABASE_PLATFORM_ADMIN_URL: NonEmpty.optional(),

    /* The API-token auth lookup (Phase 10 Wave 3, ai/phase-10-automation.md
       §6.2; migration 0050). taskflow_api_token_auth holds a COLUMN-LEVEL
       grant on platform.api_tokens — token_hash/org_id/created_by/scopes/
       revoked_at, never name/token_prefix/last_used_at — with a USING (true)
       policy, because the presented token's row NAMES its org and the
       lookup therefore has no app.org_id that is correct. Optional, matching
       every other consumer role: an instance without it simply refuses every
       token request (withApiTokenAuthScope throws, and the auth path answers
       unauthenticated) — fail-closed, never a silent fallback to the
       application role, which cannot read across every org anyway. */
    DATABASE_API_TOKEN_URL: NonEmpty.optional(),

    /* The inbound-connector lookup connection, on its own role and pool
       (Phase 10 Wave 4, §7.2; migration 0056). The api_token_auth recipe
       applied to a webhook instead of a token: an inbound Slack/GitHub
       request must be resolved to an org BEFORE any scope is open — the body
       names a team_id / repository full_name, and the row mapping that scope
       to an org is a tenant row, so no value of app.org_id is correct for the
       read. Optional for the same reason every consumer pool is, and when it
       is absent withIntegrationAuthScope throws, the inbound routes answer
       SERVICE_UNAVAILABLE, and every connector webhook fails CLOSED rather
       than falling back to the application role, which cannot read across
       every org anyway. */
    DATABASE_INTEGRATION_URL: NonEmpty.optional(),

    /* The operations dashboard's writer (migration 0061). taskflow_ops_events
       holds INSERT/SELECT on platform.operational_events, which carries no
       org_id at all — mail delivery frequently has no org yet. Optional,
       same convention as every other consumer role above: an instance
       without it simply gets no dashboard rows for mail/webhook outcomes
       (recordOperationalEvent() catches the missing-connection error itself
       rather than letting it break the mail queue or the webhook route) —
       never a silent fallback to the application role, which holds no grant
       on this table at all. */
    DATABASE_OPS_EVENTS_URL: NonEmpty.optional(),

    /* Web Push (Phase 9 Wave 2, ai/phase-9-notifications.md §3.7). VAPID
       identifies the application server to the push service: a mailto: URL
       as the subject, and a P-256 key pair generated by
       `@taskflow/security`'s `generateVapidKeys`. Optional, unlike MAIL_HOST:
       an instance with no keys is a valid deployment that simply does not
       send push — the preferences UI reports that honestly instead of
       pretending the channel works. The private key is signing material and
       never leaves the server. */
    VAPID_SUBJECT: OptionalNonEmpty,
    VAPID_PUBLIC_KEY: OptionalNonEmpty,
    VAPID_PRIVATE_KEY: OptionalNonEmpty,

    /* Native mobile push (Phase 14 §9, ai/phase-14-mobile.md). Unlike VAPID
       above, `ExpoPushProvider` needs no secret to construct at all — see
       that class's own header in `push-provider.ts` — so this is NOT a
       "push is on" gate the way the VAPID trio is; the provider is always
       constructed in `main.ts`. This token only raises Expo's per-project
       rate limits and scopes sends to this Expo project specifically, so
       it stays optional even once set for one deployment. */
    EXPO_ACCESS_TOKEN: OptionalNonEmpty,

    /* OAuth sign-in (Phase 12 Wave 2 §3.3). Optional per provider, the same
       "an unconfigured integration is a valid deployment" convention as VAPID
       above: a provider whose client id/secret are unset simply does not
       render its button, rather than the app failing to boot. */
    GOOGLE_CLIENT_ID: OptionalNonEmpty,
    GOOGLE_CLIENT_SECRET: OptionalNonEmpty,
    GITHUB_CLIENT_ID: OptionalNonEmpty,
    GITHUB_CLIENT_SECRET: OptionalNonEmpty,

    /* The NATIVE (mobile) counterpart (ai/phase-14-mobile.md §4.4) — a
       SEPARATE provider registration, not the pair above reused. Google's
       native client is a public/installed-app type with no secret to
       configure (`NativeOAuthProviderCredentials`'s own comment in
       oauth.service.ts); GitHub's is a second, dedicated OAuth App whose one
       callback URL is the native deep link, so it still carries a secret. */
    GOOGLE_NATIVE_CLIENT_ID: OptionalNonEmpty,
    GITHUB_NATIVE_CLIENT_ID: OptionalNonEmpty,
    GITHUB_NATIVE_CLIENT_SECRET: OptionalNonEmpty,

    MASTER_KEY_ID: NonEmpty,
    MASTER_KEY_BASE64: Base64Key,

    /* Access token signing/verifying key pair (RS256) — this API is the only
       process that holds JWT_PRIVATE_KEY. apps/realtime and apps/collab hold
       only JWT_PUBLIC_KEY, so a leak from either can read a token but never
       forge one. See packages/security/src/jwt.ts's file header. */
    JWT_PRIVATE_KEY: Base64PemKey,
    JWT_PUBLIC_KEY: Base64PemKey,

    /* TOTP challenge / OAuth state / connector state tokens — single-process
       (signed and verified by this API alone), so these stay HS256 on their
       own secret rather than the access token's key pair. */
    JWT_STATE_SECRET: Base64Key,

    /* Mail (§8.1). Mailpit locally, a real provider in deployed environments.
       Verification and reset links are the credential for the flow that issues
       them, so delivery is not a "nice to have" that can be stubbed out — an
       unset MAIL_HOST must fail at boot, not at the first signup. */
    MAIL_HOST: NonEmpty,
    MAIL_PORT: z.coerce.number().int().positive().max(65_535).default(1025),
    MAIL_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    MAIL_FROM: NonEmpty,
    /* Optional: most real relays (Gmail, SendGrid, Postmark, Resend, SES SMTP)
       require AUTH, unlike Mailpit. Absent when the relay is reachable without
       credentials (a local/allowlisted relay) — SmtpMailer only attempts AUTH
       when both are present, since sending an empty AUTH is rejected outright
       by servers that do require it. */
    MAIL_USER: OptionalNonEmpty,
    MAIL_PASSWORD: OptionalNonEmpty,
    /**
     * Whether `MailQueue` checks a recipient's domain for MX/A/AAAA records
     * before ever opening an SMTP connection to it (`@taskflow/mail`'s
     * `domain-check.ts`).
     *
     * OFF BY DEFAULT, and the default is the safe one — parsed from the
     * string 'true' rather than with `z.coerce.boolean()`, the
     * RETENTION_SWEEP_ENABLED lesson. Mailpit does not care what the
     * recipient domain is, so leaving this off locally costs nothing; a real
     * relay does, and `packages/seed`'s users all share `taskflow.seed.test`
     * — a domain on the reserved, never-resolving `.test` TLD — so turning
     * this on against a real relay is what stops every seeded account's
     * notification mail from burning a full SMTP retry budget for a
     * recipient that was never going to accept it. */
    MAIL_VALIDATE_RECIPIENT_DOMAIN: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    /* Object storage (§5, §8.4). MinIO locally, Cloudflare R2 on the free tier,
       S3 past 10 GB — all three speak the same API, so only these values
       change.

       Required rather than optional, for the same reason as MAIL_HOST: an
       attachment upload that fails at presign time because a bucket name was
       never set is a broken feature discovered by a user, where an unset
       variable is a boot failure discovered by whoever deployed it. */
    STORAGE_ENDPOINT: NonEmpty,
    STORAGE_REGION: z.string().default('us-east-1'),
    STORAGE_ACCESS_KEY_ID: NonEmpty,
    STORAGE_SECRET_ACCESS_KEY: NonEmpty,
    STORAGE_BUCKET_ATTACHMENTS: NonEmpty,
    STORAGE_BUCKET_EXPORTS: NonEmpty,
    /* Path-style addressing. Required by MinIO, which has no per-bucket DNS;
       R2 and S3 accept either. Defaults to true because the local stack is the
       one a developer runs without setting anything. */
    STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /* Largest attachment accepted, in bytes. Pinned into the upload signature
       and used as the ceiling on the server-side read during scanning, so it
       bounds memory as well as storage. */
    STORAGE_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(500 * 1024 * 1024)
      .default(25 * 1024 * 1024),

    /* Virus scanning (§8.4). An attachment is not downloadable until clamd has
       looked at it, and an unreachable scanner fails CLOSED — so these being
       wrong makes uploads stop working, which is the correct direction for a
       misconfiguration to fail in. */
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().positive().max(65_535).default(3310),

    /* Telephony (§8.5; ai/phase-7-voice.md §6.4, Wave 1).

       All optional, and the consequence of omitting them is that this instance
       cannot provision a subaccount or place anything — NOT that it silently
       spends without controls. `buildTelephonyDeps` returns undefined when the
       credentials are absent, and every telephony route is unregistered rather
       than registered-and-broken, which is the same fail-closed direction
       DATABASE_AUDIT_URL's own comment describes.

       Unlike MAIL_HOST, these must NOT be required at boot: an API instance
       that serves Work and Chat is a completely valid deployment, and making a
       carrier credential a boot requirement would mean every developer needs a
       Twilio account to run the app. */
    TWILIO_ACCOUNT_SID: OptionalNonEmpty,
    TWILIO_AUTH_TOKEN: OptionalNonEmpty,
    /* Twilio Verify service, for the MFA fallback (§3.12). Separate because
       Verify is a distinct product with its own SID, and an instance can
       legitimately have telephony without it. */
    TWILIO_VERIFY_SERVICE_SID: OptionalNonEmpty,

    /* The per-org default spend cap in CENTS (§7.2 — 2500, roughly 12x
       PLAN.md §14's expected ~$2/month). Applied to orgs with no explicit
       comms.spend_policy row; an existing row always wins, so changing this
       never silently re-caps an org an operator has already decided about. */
    TELEPHONY_DEFAULT_SPEND_CAP_CENTS: z.coerce.number().int().nonnegative().default(2500),

    /* The ceiling no self-service path may raise an org's cap past (§7.2).

       This is the reason "Owner can raise the cap" is not the same as "an
       Owner credential is unlimited spend". A compromised Owner account is a
       realistic path to toll fraud precisely BECAUSE raising the cap is a
       legitimate Owner action, and an environment-level ceiling is the one
       bound that a stolen credential cannot move. */
    TELEPHONY_MAX_SPEND_CAP_CENTS: z.coerce.number().int().nonnegative().default(50_000),

    /* Public origin the carrier reaches this API on, used to build the webhook
       URLs it will sign. NOT derived from the incoming request: the signature
       covers the exact URL, and deriving it from a request means an attacker
       controlling `Host` controls what we verify against. */
    TELEPHONY_WEBHOOK_ORIGIN: OptionalUrl,

    /* Blind-index key for counterparty phone numbers (Wave 2, migration 0033).

       Separate key material from MASTER_KEY_BASE64 on purpose: one compromise
       should not both decrypt the column and let an attacker generate indexes
       to confirm guesses against it. Rotating it invalidates every existing
       index — lookups stop matching, calls are still readable — so a rotation
       is a reindex, not a restart. */
    TELEPHONY_INDEX_KEY: OptionalKey,

    /* Phase 10 Wave 4 (§5.5): whether the cost-bearing automation actions
       (`call.place`, `sms.send`) exist in the rule builder at all.

       OFF BY DEFAULT, and the default is the safe one — parsed from the
       string 'true' rather than with `z.coerce.boolean()`, which treats every
       non-empty string as true, so `=false` would enable it (the
       RETENTION_SWEEP_ENABLED lesson).

       This is NOT a security control and must never be read as one: it gates
       a product surface. Every security control — the geo table, the org
       freeze, subaccount status, the rolling cap, the velocity limiter, and
       the automation sub-budget — runs unconditionally on both sides of it,
       through the identical `checkOutboundAllowed` chokepoint a human's call
       passes. Turning the flag on adds a caller to an existing gate; turning
       it off is defence in depth, not the defence (§9 decision 3). */
    AUTOMATION_TELEPHONY_ACTIONS_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    /* Phase 10 Wave 4 — the Slack/GitHub connectors (§7.2). ALL optional,
       the oauth.service precedent: an unconfigured provider's connect route
       refuses with NOT_FOUND rather than the app failing to boot.

       These are a SEPARATE Slack app and GitHub OAuth app from the login-
       linking ones (the GOOGLE_CLIENT_* and GITHUB_CLIENT_* above) — different
       scope, different trust, never shared credentials. SLACK_SIGNING_SECRET
       is the Slack APP's signing secret (D3 — shared by every workspace,
       deployment env, never a per-org column), consumed by slice 3's inbound
       route. */
    SLACK_CONNECTOR_CLIENT_ID: OptionalNonEmpty,
    SLACK_CONNECTOR_CLIENT_SECRET: OptionalNonEmpty,
    SLACK_SIGNING_SECRET: OptionalNonEmpty,
    GITHUB_CONNECTOR_CLIENT_ID: OptionalNonEmpty,
    GITHUB_CONNECTOR_CLIENT_SECRET: OptionalNonEmpty,
    /* The absolute origin the UI builds each connector's WEBHOOK URL from
       (Slack app config takes one URL, deployment-wide; GitHub one per
       org's repo). Absent = the webhook URLs are hidden and slice 3's
       inbound routes are unregistered — the connect flow still works. */
    INTEGRATION_WEBHOOK_ORIGIN: OptionalUrl,

    /* Where call recordings land. Optional, like every telephony setting: an
       instance with no carrier has nothing to store. */
    STORAGE_BUCKET_RECORDINGS: OptionalNonEmpty,

    /* ------------------------------------------------------------------ *
     * In-app voice / WebRTC (Phase 13 Wave 1, ai/phase-13-webrtc.md §3.3-§3.4)
     * ------------------------------------------------------------------ */

    /* ICE servers, comma-separated, in the form the browser's
       RTCPeerConnection takes (`stun:host:3478`, `turn:host:3478?transport=udp`).
       Two variables rather than one list because they are governed differently:
       a STUN server learns your public address and relays nothing, so it costs
       nothing and needs no credential. A TURN server relays every byte. */
    RTC_STUN_URLS: z.string().default('stun:localhost:3478'),
    /* OptionalNonEmpty, not z.string().optional(): the compose convention is
       that a present-but-blank variable is unset, and a TURN list that
       reached the browser as [''] would be a malformed `turn:` URL no
       candidate could ever connect through. */
    RTC_TURN_URLS: OptionalNonEmpty,

    /* coturn's `static-auth-secret`. OPTIONAL, and its absence is a valid
       deployment: STUN alone works on most networks. What it must never be is
       present-but-shipped — this value stays server-side and only
       `mintTurnCredential` ever sees it (§3.3).

       Deliberately NOT Base64Key. coturn takes an arbitrary string here, and
       requiring a 32-byte base64 value would mean a secret that this app
       accepts and the TURN server was never configured with. */
    RTC_TURN_SECRET: OptionalNonEmpty,

    /* How long a minted credential lives. Long enough to cover ICE gathering
       and a renegotiation, short enough that a leaked pair is worthless by the
       time anyone finds it in a log. The floor is the same 30 seconds the
       `turn_issuance_ttl_sane` CHECK enforces. */
    RTC_TURN_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),

    /* The DURABLE issuance budget, per org, over a rolling 24 hours (§3.4).
       This is the TURN analogue of TELEPHONY_DEFAULT_SPEND_CAP_CENTS, and it
       exists for the same reason: an open relay carries strangers' traffic on
       this deployment's bill, and the control that actually stops it has to
       survive a restart. */
    RTC_TURN_ISSUANCE_CAP_PER_DAY: z.coerce.number().int().nonnegative().default(500),

    /**
     * `all` (default) or `relay`, passed through to the browser.
     *
     * `relay` forces every candidate through TURN. It is not the production
     * setting — it is how the TURN path gets exercised deliberately, because
     * STUN alone works on most developer networks and the relay path therefore
     * stays untested until someone is behind a symmetric NAT, in production.
     *
     * A literal union rather than a boolean: the value is handed to
     * `RTCPeerConnection` verbatim, and inventing a second vocabulary to
     * translate would be a place for the translation to be wrong.
     */
    RTC_ICE_TRANSPORT_POLICY: z.enum(['all', 'relay']).default('all'),

    /* Ceiling on one uploaded call recording, PINNED into the presigned PUT's
       signature rather than merely checked — which is what makes it a limit
       instead of advice (packages/storage/src/s3.ts). At roughly 32 kbit/s for
       Opus in a WebM container, 64 MB is about four hours. */
    RTC_MAX_RECORDING_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(64 * 1024 * 1024),

    /* A SEVENTH database role, for the recording-ingest sweep (Wave 2,
       migration 0033). taskflow_recording_ingest holds a COLUMN-LEVEL grant on
       comms.recordings and NOTHING on comms.calls — so the role that fetches a
       recording cannot learn whose conversation it is. Optional, matching every
       other consumer role: an instance that only serves requests does not need
       it, and `withRecordingIngestScope` throws rather than silently falling
       back to the application role, which cannot see across tenants. */
    DATABASE_RECORDING_INGEST_URL: NonEmpty.optional(),

    /**
     * Whether THIS instance runs the recording-ingest sweep.
     *
     * Off by default, and the default is the safe one — the same reasoning
     * RETENTION_SWEEP_ENABLED gives. Parsed from the string 'true' rather than
     * with `z.coerce.boolean()`, which treats EVERY non-empty string as true,
     * so `=false` would enable it.
     */
    RECORDING_INGEST_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    API_PORT: z.coerce.number().int().positive().max(65_535).default(3000),
    API_HOST: z.string().default('0.0.0.0'),
    API_TRUST_PROXY: TrustProxy,

    /**
     * Whether THIS instance runs the chat retention sweep (Wave 4, §3.7).
     *
     * Off by default, and the default is the safe one. The sweep has no
     * SKIP-LOCKED claim, so two instances ticking together both issue the same
     * DELETE — the second removes nothing but still emits a batch of
     * `message.deleted` events, putting duplicate deletions in the compliance
     * record. Exactly one instance should enable it, until pg-boss provides a
     * schedule with a real lock.
     *
     * Parsed from the string 'true' rather than with `z.coerce.boolean()`,
     * which is a trap here: it treats EVERY non-empty string as true, so
     * `RETENTION_SWEEP_ENABLED=false` would enable the sweep. For a flag that
     * gates deleting user data, that failure runs the wrong way.
     */
    RETENTION_SWEEP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    WEB_ORIGIN: z.string().url(),

    /* ------------------------------------------------------------------ *
     * Billing & org lifecycle (Phase 12 Wave 3, ai/phase-12-wave3.md §3.3)
     * ------------------------------------------------------------------ */

    /**
     * Which `PaymentProvider` implementation boots — EXPLICIT, not
     * credential-sniffed the way telephony's `ACtest` marker is. A named
     * switch is what "swap processors later with minimal changes" means in
     * practice: a second implementation is a new `PAYMENTS_PROVIDER` value
     * plus a `packages/payments` class, never a call-site change.
     *
     * Defaults to `fake` so an unconfigured instance boots clean — the
     * identical "a developer must not need a real account" reasoning
     * `buildTelephonyDeps` gives for its own marker-SID fallback.
     */
    PAYMENTS_PROVIDER: z.enum(['stripe', 'fake']).default('fake'),

    /* Required only when PAYMENTS_PROVIDER=stripe — deps.ts refuses at boot
       rather than at the first checkout call, the TELEPHONY_WEBHOOK_ORIGIN
       precedent. Optional here because `fake` needs neither. */
    STRIPE_SECRET_KEY: OptionalNonEmpty,
    STRIPE_WEBHOOK_SECRET: OptionalNonEmpty,

    /* BILLING_STRIPE_PRICE_ID_PRO was here until Phase 12 Wave 4, holding the
       Stripe Price id of the one hardcoded plan. It is GONE, not renamed.

       Plans and their prices are rows now — `billing.plans` and
       `billing.plan_prices`, created through the operator console, which
       writes the Product and Price to Stripe itself — and
       `createCheckoutSession` resolves the current price per request. A
       variable that configured THE one plan has no meaning once plans are
       data, and keeping it would mean two sources for the same fact with the
       stale one winning silently at boot.

       Recorded here rather than simply deleted so the next person to find it
       in an old .env learns why it stopped being read. They will find out
       either way: it is no longer in KNOWN_VARIABLES, so
       `assertNoMisspelledVariables` now REFUSES to boot on it rather than
       ignoring it — which is the right direction for a variable someone still
       believes is doing something. */

    /* Business constants, not security boundaries — tunable per deployment
       with no migration, the same reasoning TELEPHONY_DEFAULT_SPEND_CAP_CENTS
       already gives for its own default. */
    BILLING_TRIAL_DAYS: z.coerce.number().int().positive().default(14),
    BILLING_PAST_DUE_GRACE_DAYS: z.coerce.number().int().positive().default(7),
  })
  /* NOT `.strict()`, unlike every other schema in this codebase.

     `process.env` carries a few hundred variables belonging to the OS, the
     shell, and whatever launched the process. Rejecting unknown keys here means
     the API cannot start on any real machine — which is exactly what happened
     the first time this was booted, after a unit test suite that fed it a tidy
     fixture object had passed. The typo protection that `.strict()` was reaching
     for is provided by `assertNoMisspelledVariables` below, which knows which
     names are ours. */
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.MASTER_KEY_BASE64 === env.JWT_STATE_SECRET) {
      // Reusing one secret for two purposes means compromising either
      // compromises both, and key rotation stops being independent. Compared
      // against JWT_STATE_SECRET, not JWT_PRIVATE_KEY/JWT_PUBLIC_KEY — those
      // are PEM key blocks, a different shape entirely, and not the kind of
      // value someone accidentally reuses across an AES key and a JWT secret.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MASTER_KEY_BASE64 and JWT_STATE_SECRET must be different values.',
      });
    }

    /* A TURN URL with no secret, or a secret with no URL, is half a
       configuration — and the half that is missing fails SILENTLY. The browser
       is handed a `turn:` server it cannot authenticate against, ICE quietly
       falls back to the STUN candidates that work on most networks, and the
       relay path is discovered to be broken by the first user behind a
       symmetric NAT. This is the TELEPHONY_WEBHOOK_ORIGIN precedent: refuse at
       boot rather than degrade invisibly. */
    const hasTurnUrls = (env.RTC_TURN_URLS ?? '').trim().length > 0;
    const hasTurnSecret = env.RTC_TURN_SECRET !== undefined;

    if (hasTurnUrls !== hasTurnSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasTurnUrls ? 'RTC_TURN_SECRET' : 'RTC_TURN_URLS'],
        message:
          'RTC_TURN_URLS and RTC_TURN_SECRET must be set together. One without the other ' +
          'hands the browser a relay it cannot authenticate against, and ICE falls back to ' +
          'STUN without reporting anything.',
      });
    }

    /* `relay` with no relay configured refuses EVERY call — the policy tells
       the browser to discard every non-relay candidate, and there is no relay
       to produce one. Silent again: the peer connection simply never reaches
       `connected`. */
    if (env.RTC_ICE_TRANSPORT_POLICY === 'relay' && !hasTurnUrls) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RTC_ICE_TRANSPORT_POLICY'],
        message:
          "'relay' discards every non-relay ICE candidate, so with no RTC_TURN_URLS configured " +
          'no call can ever connect.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Every Rinavai environment variable, across ALL services — not just the ones
 * this app reads.
 *
 * Kept in sync with .env.example. The API does not consume the storage or mail
 * settings, but they are legitimately present in a developer's environment, so
 * the misspelling check has to know about them or it would reject a correct
 * setup.
 *
 * The list below is that catalog, and the schema's own keys are unioned into
 * it rather than typed a second time: a variable THIS app validates cannot be
 * a typo, so a hand-copied duplicate of it is nothing but a way for the two
 * lists to disagree. `DATABASE_SEARCH_URL` (Phase 8 Wave 2) is what proved it
 * — added to the schema and to .env.example, missed here, and the API then
 * refused to boot naming a variable it parses itself, which reads as a typo in
 * a name that is spelled correctly. `innerType()` unwraps the `.superRefine()`
 * above; ZodEffects has no `.shape` of its own.
 *
 * What the catalog still carries by hand is every OTHER service's variables,
 * which no schema in this file knows about.
 */
const KNOWN_VARIABLES = new Set([
  ...Object.keys(EnvSchema.innerType().shape),
  'NODE_ENV',
  'LOG_LEVEL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_AUDIT_URL',
  'DATABASE_BACKLINKS_URL',
  'DATABASE_NOTIFICATION_SWEEP_URL',
  'DATABASE_PLATFORM_ADMIN_URL',
  'DATABASE_AUTOMATION_URL',
  'DATABASE_WEBHOOK_URL',
  /* The billing sweep's scan role (Phase 12 Wave 3, migration 0060) — read by
     apps/worker, never here, and the next variable of this exact class to stop
     a correctly-configured process booting. */
  'DATABASE_BILLING_SWEEP_URL',
  'DATABASE_API_TOKEN_URL',
  'DATABASE_INTEGRATION_URL',
  'DATABASE_OPS_EVENTS_URL',
  'VAPID_SUBJECT',
  'VAPID_PUBLIC_KEY',
  'BILLING_TRIAL_ENDING_WARNING_HOURS',
  'VAPID_PRIVATE_KEY',
  /* apps/realtime's own consumer role (Phase 4 §3.5). Listed here — as the
     comment above this set explains — because a developer's environment
     legitimately carries variables this app does not read, and the misspelling
     check would otherwise reject a correct setup. */
  'DATABASE_REALTIME_URL',
  /* apps/collab's write-exception role (Phase 6 Wave 2, migration 0024). Same
     reasoning as DATABASE_REALTIME_URL: it is in .env.example, this app does
     not read it, and an unlisted one makes the API refuse to boot over a
     correctly-spelled variable the moment a developer copies the example. */
  'DATABASE_COLLAB_URL',
  'DATABASE_POOL_MAX',
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_BUCKET_ATTACHMENTS',
  'STORAGE_BUCKET_EXPORTS',
  'STORAGE_FORCE_PATH_STYLE',
  'STORAGE_MAX_UPLOAD_BYTES',
  'CLAMAV_HOST',
  'CLAMAV_PORT',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_SECURE',
  'MAIL_FROM',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_NATIVE_CLIENT_ID',
  'GITHUB_NATIVE_CLIENT_ID',
  'GITHUB_NATIVE_CLIENT_SECRET',
  'MASTER_KEY_ID',
  'MASTER_KEY_BASE64',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_STATE_SECRET',
  'API_PORT',
  'API_HOST',
  'API_TRUST_PROXY',
  'RETENTION_SWEEP_ENABLED',
  /* Phase 10 Wave 4 — the connectors (§7.2). Listed so a misspelled
     SLACK_CONNECTOR_CLIENT_SECRETT is caught wherever it is made. */
  'SLACK_CONNECTOR_CLIENT_ID',
  'SLACK_CONNECTOR_CLIENT_SECRET',
  'SLACK_SIGNING_SECRET',
  'GITHUB_CONNECTOR_CLIENT_ID',
  'GITHUB_CONNECTOR_CLIENT_SECRET',
  'INTEGRATION_WEBHOOK_ORIGIN',
  /* Telephony (Phase 7 Wave 1). Listed for the same reason as every other
     variable in this set — a typo must be caught wherever it is made. */
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID',
  'TELEPHONY_DEFAULT_SPEND_CAP_CENTS',
  'TELEPHONY_MAX_SPEND_CAP_CENTS',
  'TELEPHONY_WEBHOOK_ORIGIN',
  'TELEPHONY_INDEX_KEY',
  'STORAGE_BUCKET_RECORDINGS',
  'DATABASE_RECORDING_INGEST_URL',
  'RECORDING_INGEST_ENABLED',
  'WEB_ORIGIN',
  /* Read by apps/web's vite.config.ts, never by a server — but they carry the
     `WEB_` prefix, so `assertNoMisspelledVariables` treats them as ours and
     REJECTS them unless they are listed here. A developer who set either one in
     .env to point the dev server at a non-default backend would find both the
     API and the gateway refusing to boot, with an error naming a variable that
     is spelled perfectly correctly. */
  'WEB_API_ORIGIN',
  'WEB_REALTIME_ORIGIN',
  /* Read by apps/web's vite.config.ts for its /collab proxy target. Same
     class as the two above: `WEB_` prefix, never read by a server, must be
     listed or it is rejected. */
  'WEB_COLLAB_ORIGIN',
  /* Read by apps/web's vite.config.ts for `server.allowedHosts` — the hosts
     the dev server accepts besides localhost (tunnels such as ngrok). Same
     class as the three above: `WEB_` prefix, never read by a server, must
     be listed or it is rejected. */
  'WEB_ALLOWED_HOSTS',
  /* apps/realtime (Phase 4). Same reasoning as DATABASE_REALTIME_URL above —
     this set is every Rinavai variable across ALL services, not the ones this
     app reads, so that a typo is caught wherever it is made. */
  'REALTIME_PORT',
  'REALTIME_HOST',
  'REALTIME_TRUST_PROXY',
  'REALTIME_REAUTH_LEAD_SECONDS',
  'REALTIME_POLL_INTERVAL_MS',
  'REALTIME_MAX_CONNECTIONS_PER_IP_PER_MINUTE',
  'REALTIME_MAX_JOINS_PER_MINUTE',
  'REALTIME_MAX_REFUSED_JOINS_PER_MINUTE',
  /* apps/realtime's signalling limiter (Phase 13 Wave 1) — read by the gateway,
     not by this app, and listed here for the same reason as the six above. */
  'REALTIME_MAX_SIGNALS_PER_MINUTE',
  /* In-app voice (Phase 13 Wave 1). */
  'RTC_STUN_URLS',
  'RTC_TURN_URLS',
  'RTC_TURN_SECRET',
  'RTC_TURN_TTL_SECONDS',
  'RTC_TURN_ISSUANCE_CAP_PER_DAY',
  'RTC_ICE_TRANSPORT_POLICY',
  'RTC_MAX_RECORDING_BYTES',
  /* Billing & org lifecycle (Phase 12 Wave 3). Same reasoning as every other
     variable in this set — a typo must be caught wherever it is made. */
  'PAYMENTS_PROVIDER',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'BILLING_TRIAL_DAYS',
  'BILLING_PAST_DUE_GRACE_DAYS',
]);

/**
 * Prefixes that mark a variable as ours.
 *
 * Deliberately excludes `NODE_` and `LOG_`, which collide with tooling that has
 * nothing to do with this project.
 */
const TASKFLOW_PREFIXES = [
  'DATABASE_',
  'STORAGE_',
  'MAIL_',
  'MASTER_KEY',
  'JWT_',
  'API_',
  'WEB_',
  'CLAMAV_',
  'REALTIME_',
  'TWILIO_',
  'TELEPHONY_',
  'RTC_',
  'PAYMENTS_',
  'STRIPE_',
  'BILLING_',
  /* Phase 10 Wave 4 — the automation telephony flag is this app's own, and a
     misspelled `AUTOMATION_TELEPHONY_ACTIONS_EBABLED` is exactly the near-miss
     this list exists to catch. */
  'AUTOMATION_',
  /* Phase 10 Wave 4 — the connectors (§7.2). `GITHUB_` is shared with the
     login-linking `GITHUB_CLIENT_*` (already listed as known); the prefix is
     what makes a `GITHUB_CONNECTOR_CLIENT_SECRETT` typo refuse to boot. */
  'SLACK_',
  'GITHUB_',
  'INTEGRATION_',
];

/**
 * Rejects a variable that looks like ours but is not one of ours.
 *
 * The failure being prevented: `MASTER_KEY_BASE_64` set instead of
 * `MASTER_KEY_BASE64`. Zod would report the real name as missing, which is
 * already a decent error, but naming the near-miss turns a five-minute stare
 * into a one-line fix.
 *
 * Scoped to our own prefixes rather than to everything, because "everything"
 * includes the operating system.
 */
function assertNoMisspelledVariables(source: Record<string, string | undefined>): void {
  const suspects = Object.keys(source).filter(
    (key) =>
      !KNOWN_VARIABLES.has(key) && TASKFLOW_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );

  if (suspects.length > 0) {
    throw new Error(
      `Unrecognized ${DEFAULT_PRODUCT_NAME} environment variable(s): ${suspects.join(', ')}.\n` +
        'Check the spelling against .env.example — a near-miss name means the real\n' +
        'variable is unset and something is running on a default it should not be.',
    );
  }
}

/**
 * Parses an environment source. Takes the source as an argument so tests do not
 * have to mutate the real `process.env` and leak state between files.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  assertNoMisspelledVariables(source);
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment:\n${detail}`);
  }
  return result.data;
}

/**
 * Reads the real environment, loading a repo-root `.env` first if one exists.
 *
 * Lives here rather than in `main.ts` because this module is the one place
 * permitted to touch `process.env` — the guardrail that enforces that is the
 * reason a validated config exists at all, and routing the process entry point
 * around it would be the first crack.
 *
 * `loadEnvFile` follows `--env-file` semantics and does NOT overwrite variables
 * that are already set, so injected production secrets always beat a file that
 * happens to be on disk.
 */
export function loadEnv(): Env {
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = resolve(here, '..', '..', '..', '..', '.env');

  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseEnv(process.env);
}
