import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PhoneNumberSchema, type OrgId, type PhoneNumber } from '@taskflow/contracts';
import { eq, isNull, and, schema, withOrgScope } from '@taskflow/db';
import {
  InboundRoute,
  menuChoiceToTwiml,
  routeToTwiml,
  type TwimlContext,
} from '@taskflow/telephony';
import { applyCallStatus, markAnnouncementPlayed, recordInboundCall } from './call.service.js';
import { applyMessageStatus, receiveSms } from './message.service.js';
import { registerRecording } from './recording.service.js';
import { storeTranscript } from './transcript.service.js';
import { commitWebhookNonce, verifyInboundWebhook } from './webhook.js';
import type { TelephonyDeps } from './deps.js';

/**
 * Inbound carrier webhooks (ai/phase-7-voice.md §3.11).
 *
 * ⚠ Human-review surface (CLAUDE.md §2.2 — "any webhook signature
 * verification"). This is the only unauthenticated write path in the system.
 *
 * ## Plain Fastify routes, not tRPC procedures
 *
 * Every mutation elsewhere goes through `route({ permission })` — an
 * authenticated principal calling a typed procedure. A carrier webhook has no
 * principal: it is an unauthenticated, form-encoded POST whose only proof is a
 * signature over the exact URL and body. Forcing that into tRPC's shape would
 * mean inventing a principal, which is the one thing that must not happen here.
 *
 * ## Every handler follows the same four steps, in this order
 *
 *   1. `verifyInboundWebhook` — resolve the org from the UNVERIFIED payload
 *      (a lookup key, not an assertion), then check the signature against that
 *      org's carrier token. Nothing is written before it passes.
 *   2. Do the work, inside `withOrgScope`.
 *   3. `commitWebhookNonce` in the SAME transaction as the effect, so a failed
 *      attempt rolls the nonce back and the carrier's retry can still land.
 *   4. Answer 200 with TwiML, or 204.
 *
 * ## Failures answer 403 with no detail, always the same detail
 *
 * "Unknown subaccount" and "bad signature" are the same response. Distinguishing
 * them tells an attacker whether a SID they guessed is real.
 */

/** Twilio posts `application/x-www-form-urlencoded`, never JSON. */
type FormBody = Record<string, string>;

export interface WebhookRouteDeps {
  readonly telephony: TelephonyDeps;
}

export function registerTelephonyWebhooks(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const telephony = deps.telephony;

  /* The carrier sends form-encoded bodies. The tRPC adapter replaces the JSON
     parser globally with a pass-through (CLAUDE.md), so this content type needs
     its own parser or `request.body` is a string here too. */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  /**
   * An inbound call arrived on one of our numbers.
   *
   * Answers with TwiML, so the carrier knows what to do with a live caller. A
   * slow or failing response here is a person listening to silence, which is
   * why nothing in this handler fetches anything external.
   */
  app.post<{ Params: { phoneNumberId: string } }>(
    '/telephony/voice/:phoneNumberId',
    async (request, reply) => {
      const verified = await verify(request, reply, telephony);
      if (verified === undefined) return;

      const params = request.body as FormBody;
      const from = parseNumber(params['From']);
      if (from === undefined) return reply.status(400).send();

      const number = await loadRoutableNumber(verified.orgId, request.params.phoneNumberId);
      if (number === undefined) return reply.status(404).send();

      const call = await recordInboundCall(verified.orgId, telephony, {
        from,
        phoneNumberId: request.params.phoneNumberId,
        providerSid: params['CallSid'] ?? '',
        requestId: request.id,
      });

      await withOrgScope(verified.orgId, async (tx) => {
        await commitWebhookNonce(tx, verified.orgId, verified.signature);
      });

      const route = InboundRoute.safeParse(number.inboundRoute);
      if (!route.success) {
        /* No usable routing config answers politely rather than erroring. A 500
           here drops a live call, and "this number is not configured" is the
           honest thing to say to a person who dialled it. */
        return reply
          .type('text/xml')
          .send(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not in service.</Say><Hangup/></Response>',
          );
      }

      return reply
        .type('text/xml')
        .send(
          routeToTwiml(
            route.data,
            contextFor(telephony, call.callId, false, call.announcementRequired),
          ),
        );
    },
  );

  /** A caller pressed a digit on an IVR menu. */
  app.post<{ Params: { phoneNumberId: string } }>(
    '/telephony/menu/:phoneNumberId',
    async (request, reply) => {
      const verified = await verify(request, reply, telephony);
      if (verified === undefined) return;

      const params = request.body as FormBody;
      const number = await loadRoutableNumber(verified.orgId, request.params.phoneNumberId);
      if (number === undefined) return reply.status(404).send();

      const route = InboundRoute.safeParse(number.inboundRoute);
      if (!route.success) return reply.status(404).send();

      return reply
        .type('text/xml')
        .send(
          menuChoiceToTwiml(
            route.data,
            params['Digits'] ?? '',
            contextFor(telephony, params['CallSid'] ?? '', false, false),
          ),
        );
    },
  );

  /** Call state changed: ringing, answered, completed. */
  app.post('/telephony/status/:callId', async (request, reply) => {
    const verified = await verify(request, reply, telephony);
    if (verified === undefined) return;

    const params = request.body as FormBody;
    const duration = Number.parseInt(params['CallDuration'] ?? '', 10);

    await applyCallStatus(verified.orgId, {
      providerSid: params['CallSid'] ?? '',
      status: normalizeStatus(params['CallStatus']),
      ...(Number.isFinite(duration) ? { durationSeconds: duration } : {}),
      requestId: request.id,
    });

    await withOrgScope(verified.orgId, async (tx) => {
      await commitWebhookNonce(tx, verified.orgId, verified.signature);
    });

    return reply.status(204).send();
  });

  /**
   * The consent announcement finished playing.
   *
   * Written from the carrier's own callback rather than optimistically when we
   * generated the markup: the CHECK constraint on `comms.calls` compares this
   * against `recording_started_at`, and a timestamp set when we ASKED for audio
   * to play would satisfy the constraint while proving nothing about what the
   * caller actually heard.
   */
  app.post<{ Params: { callId: string } }>(
    '/telephony/announced/:callId',
    async (request, reply) => {
      const verified = await verify(request, reply, telephony);
      if (verified === undefined) return;

      await markAnnouncementPlayed(verified.orgId, request.params.callId, request.id);

      await withOrgScope(verified.orgId, async (tx) => {
        await commitWebhookNonce(tx, verified.orgId, verified.signature);
      });

      return reply.status(204).send();
    },
  );

  /** A recording is ready. Registers it; the sweep fetches the bytes. */
  app.post<{ Params: { callId: string } }>(
    '/telephony/recording/:callId',
    async (request, reply) => {
      const verified = await verify(request, reply, telephony);
      if (verified === undefined) return;

      const params = request.body as FormBody;
      const url = params['RecordingUrl'];
      const sid = params['RecordingSid'];
      if (url === undefined || sid === undefined) return reply.status(400).send();

      const duration = Number.parseInt(params['RecordingDuration'] ?? '', 10);

      /* Registering only. The bytes are fetched by the ingest sweep, because a
         multi-megabyte download inside a callback the carrier expects answered
         in seconds means timeouts and retries under exactly the conditions that
         make it slow. */
      await registerRecording(verified.orgId, {
        callId: request.params.callId,
        providerSid: sid,
        providerUrl: url,
        durationSeconds: Number.isFinite(duration) ? duration : undefined,
        requestId: request.id,
      });

      await withOrgScope(verified.orgId, async (tx) => {
        await commitWebhookNonce(tx, verified.orgId, verified.signature);
      });

      return reply.status(204).send();
    },
  );

  /**
   * An inbound SMS (Wave 3, §3.8).
   *
   * Answers with an EMPTY TwiML response, deliberately. Twilio treats the body
   * of this response as an auto-reply to send back, so anything non-empty here
   * is an outbound message that never passed the spend gate or the suppression
   * list — including, in the STOP case, a message to someone who has just asked
   * not to receive any. Replies go through `sendSms` or not at all.
   */
  app.post<{ Params: { phoneNumberId: string } }>(
    '/telephony/sms/:phoneNumberId',
    async (request, reply) => {
      const verified = await verify(request, reply, telephony);
      if (verified === undefined) return;

      const params = request.body as FormBody;
      const from = parseNumber(params['From']);
      const body = params['Body'];
      if (from === undefined || body === undefined) return reply.status(400).send();

      await receiveSms(verified.orgId, telephony, {
        from,
        phoneNumberId: request.params.phoneNumberId,
        body,
        providerSid: params['MessageSid'] ?? '',
        requestId: request.id,
      });

      await withOrgScope(verified.orgId, async (tx) => {
        await commitWebhookNonce(tx, verified.orgId, verified.signature);
      });

      return reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    },
  );

  /** Delivery status for an outbound SMS. */
  app.post('/telephony/message-status/:messageId', async (request, reply) => {
    const verified = await verify(request, reply, telephony);
    if (verified === undefined) return;

    const params = request.body as FormBody;

    await applyMessageStatus(verified.orgId, {
      providerSid: params['MessageSid'] ?? '',
      status: params['MessageStatus'] ?? 'failed',
      errorCode: params['ErrorCode'],
      requestId: request.id,
    });

    await withOrgScope(verified.orgId, async (tx) => {
      await commitWebhookNonce(tx, verified.orgId, verified.signature);
    });

    return reply.status(204).send();
  });

  /** A transcript is ready. Redacted before it is stored (§3.7). */
  app.post<{ Params: { recordingId: string } }>(
    '/telephony/transcript/:recordingId',
    async (request, reply) => {
      const verified = await verify(request, reply, telephony);
      if (verified === undefined) return;

      const params = request.body as FormBody;
      const text = params['TranscriptionText'];
      if (text === undefined) return reply.status(400).send();

      await storeTranscript(verified.orgId, {
        recordingId: request.params.recordingId,
        rawText: text,
        language: params['Language'],
        requestId: request.id,
      });

      await withOrgScope(verified.orgId, async (tx) => {
        await commitWebhookNonce(tx, verified.orgId, verified.signature);
      });

      return reply.status(204).send();
    },
  );
}

/**
 * Verifies, or answers 403 and returns undefined.
 *
 * The URL is rebuilt from `TELEPHONY_WEBHOOK_ORIGIN`, never from the request's
 * own `Host` header: the signature covers the exact URL, so deriving it from
 * the request would let an attacker who controls `Host` control what we verify
 * against — and their forged request would then verify against a URL they chose.
 */
async function verify(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: TelephonyDeps,
): Promise<{ orgId: OrgId; signature: string } | undefined> {
  const origin = deps.webhookOrigin;
  if (origin === undefined) {
    /* No configured origin means no URL we can trust to verify against, and
       verifying against a guess is worse than refusing. */
    await reply.status(503).send();
    return undefined;
  }

  const verdict = await verifyInboundWebhook(
    {
      url: `${origin}${request.url}`,
      signature: request.headers['x-twilio-signature'] as string | undefined,
      params: (request.body ?? {}) as FormBody,
    },
    deps.keys,
  );

  if (!verdict.ok) {
    /* One response for every rejection. "Unknown subaccount" and "bad
       signature" are the same 403 — distinguishing them tells an attacker
       whether a SID they guessed is real. */
    await reply.status(403).send();
    return undefined;
  }

  return { orgId: verdict.orgId, signature: verdict.signature };
}

async function loadRoutableNumber(
  orgId: OrgId,
  phoneNumberId: string,
): Promise<{ readonly inboundRoute: unknown } | undefined> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ inboundRoute: schema.phoneNumbers.inboundRoute })
      .from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.id, phoneNumberId), isNull(schema.phoneNumbers.releasedAt)))
      .limit(1);
    return rows[0];
  });
}

function contextFor(
  deps: TelephonyDeps,
  callId: string,
  record: boolean,
  announcementRequired: boolean,
): TwimlContext {
  const origin = deps.webhookOrigin ?? '';
  return {
    /* Wave 2 has no per-member forwarding number surface yet — `people` owns
       phone numbers on a profile, and wiring that is Wave 3's when the People
       directory is the source. Until then a `dial_user` route answers
       "nobody is available" rather than dialling something unverified, which is
       the same refusal `leafToTwiml` gives for a member with no number. */
    forwardingNumberFor: () => undefined,
    recordingCallbackUrl: `${origin}/telephony/recording/${callId}`,
    menuActionUrl: `${origin}/telephony/menu/${callId}`,
    announcementRequired,
    record,
  };
}

function parseNumber(value: string | undefined): PhoneNumber | undefined {
  if (value === undefined) return undefined;
  const parsed = PhoneNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Twilio's status vocabulary onto ours. Unknown values are left alone. */
function normalizeStatus(status: string | undefined): string {
  switch (status) {
    case 'in-progress':
      return 'in_progress';
    case 'no-answer':
      return 'no_answer';
    case undefined:
      return 'failed';
    default:
      return status;
  }
}
