import { z } from 'zod';
import { ChannelIdSchema } from '@taskflow/contracts';
import { schema } from '@taskflow/db';
import { memberRoute, route, router, selfRoute } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import type { RtcActor } from './shared.js';
import type { RtcDeps } from './deps.js';
import * as sessions from './session.service.js';
import * as recordings from './recording.service.js';
import { readCallPrefs, writeCallPrefs, type Ringtone } from './call-prefs.js';
import { issueIceServers } from './turn.service.js';

/**
 * The ringtone vocabulary, derived from the schema mirror rather than restated.
 *
 * Annotated with its output type rather than left to infer, so that adding a
 * tone to `schema.RINGTONES` (and its CHECK constraint) is the only edit
 * needed — a hand-written `z.enum(['classic', ...])` here would be a fourth
 * place the list lives and the one nobody updates, and the failure would be a
 * route rejecting a tone the database happily stores.
 */
const RingtoneSchema: z.ZodType<Ringtone, z.ZodTypeDef, unknown> = z.enum(
  schema.RINGTONES as unknown as readonly [Ringtone, ...Ringtone[]],
);

/**
 * In-app voice routes (ai/phase-13-webrtc.md §3.8).
 *
 * ## The route-level permission barely narrows anything, and that is expected
 *
 * `chat/router.ts` and `docs/router.ts` both say this about themselves, and the
 * same is true here: MEMBER holds `channel:read` and `message:create` for public
 * channels, so `route({ permission })` is a coarse layer-1 filter and the real
 * decision is made once the service has loaded the channel and can build a
 * `channelTarget` carrying `closed`. Every service function in this module does
 * that, on every call — see `session.service.ts`'s header.
 *
 * This is the opposite of `telephony/router.ts`, where the route-level check IS
 * the whole decision because telephony permissions are flat role grants. Reading
 * one router's reasoning into the other is the mistake worth naming.
 *
 * ## Why `start` and `join` carry different permissions (§3.8)
 *
 *   start  message:create — making everyone's phone ring is speaking.
 *   join   channel:read   — being in the call is reading.
 *
 * A `viewer` tuple grants the second and not the first, which is exactly the
 * distinction the relation exists to express.
 *
 * ## `leave`, `decline` and `incoming` are `memberRoute`
 *
 * All three act only on the CALLER's own participant row. There is no single
 * `Permission` that describes "stop being in a call I am in", and inventing one
 * would be wrong in the specific way `memberRoute`'s own header describes:
 * refusing someone the ability to leave a conversation because their channel
 * access was revoked mid-call would strand them in it.
 */

function actorOf(ctx: {
  principal: Parameters<typeof subjectOf>[0];
  requestId: RtcActor['requestId'];
}): RtcActor {
  return { subject: subjectOf(ctx.principal), requestId: ctx.requestId };
}

export function createRtcRouter(deps: RtcDeps) {
  return router({
    /**
     * Ring everyone in a conversation.
     *
     * `kind` accepts 'video' because the database does (Wave 3 is a client
     * change, not a migration), and Wave 1's clients send 'audio'. A server that
     * rejected the value would make Wave 3 a two-sided deploy for no reason.
     */
    start: route({ permission: 'message:create' })
      .input(
        z
          .object({ channelId: ChannelIdSchema, kind: z.enum(['audio', 'video']).default('audio') })
          .strict(),
      )
      .mutation(async ({ ctx, input }) =>
        sessions.startSession(actorOf(ctx), { channelId: input.channelId, kind: input.kind }),
      ),

    /**
     * Answer, or join one already in progress.
     *
     * One route for both, because the client cannot reliably know which case it
     * is in — the state it would branch on may already be stale by the time it
     * acts. First-answer-wins is a conditional UPDATE inside the service (§3.6).
     */
    join: route({ permission: 'channel:read' })
      .input(z.object({ sessionId: z.string().uuid() }).strict())
      .mutation(async ({ ctx, input }) =>
        sessions.joinSession(actorOf(ctx), { sessionId: input.sessionId }),
      ),

    leave: memberRoute({
      memberReason:
        'Leaving a call writes only the caller\'s own participant row. No permission describes "stop doing something", and refusing it would strand someone in a call after their channel access changed.',
    })
      .input(z.object({ sessionId: z.string().uuid() }).strict())
      .mutation(async ({ ctx, input }) => {
        await sessions.leaveSession(actorOf(ctx), { sessionId: input.sessionId });
      }),

    decline: memberRoute({
      memberReason:
        "Declining a call writes only the caller's own participant row — the same reasoning as leave.",
    })
      .input(z.object({ sessionId: z.string().uuid() }).strict())
      .mutation(async ({ ctx, input }) => {
        await sessions.declineSession(actorOf(ctx), { sessionId: input.sessionId });
      }),

    /** Cancel a call you started, before anyone picked up. Initiator only. */
    cancel: memberRoute({
      memberReason:
        'Cancelling is restricted to the session initiator, which is a fact about a row rather than a permission — see cancelSession.',
    })
      .input(z.object({ sessionId: z.string().uuid() }).strict())
      .mutation(async ({ ctx, input }) => {
        await sessions.cancelSession(actorOf(ctx), { sessionId: input.sessionId });
      }),

    get: route({ permission: 'channel:read' })
      .input(z.object({ sessionId: z.string().uuid() }).strict())
      .query(async ({ ctx, input }) =>
        sessions.getSession(actorOf(ctx), { sessionId: input.sessionId }),
      ),

    /** The live call in a conversation, or null. Feeds the chat header. */
    active: route({ permission: 'channel:read' })
      .input(z.object({ channelId: ChannelIdSchema }).strict())
      .query(async ({ ctx, input }) =>
        sessions.activeSessionForChannel(actorOf(ctx), { channelId: input.channelId }),
      ),

    /**
     * Every call this conversation has had, newest first (§6's listing gap).
     * Feeds the details panel's Calls tab and the message timeline's call
     * cards — see `session.service.ts`'s own header on why this is
     * `channel:read` rather than a narrower "was I on this call" check.
     */
    history: router({
      list: route({ permission: 'channel:read' })
        .input(
          z
            .object({
              channelId: ChannelIdSchema,
              limit: z.number().int().positive().max(50).default(50),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) =>
          sessions.listSessionsForChannel(actorOf(ctx), {
            channelId: input.channelId,
            limit: input.limit,
          }),
        ),
    }),

    /**
     * "Is anyone ringing me?"
     *
     * Keyed on the caller's own participant rows, so it discloses nothing about
     * calls they were not invited to — see `incomingCalls`' own header for why
     * it does not re-check `channel:read` per row.
     */
    incoming: memberRoute({
      memberReason:
        "Answers only from the caller's own rtc.participants rows. Every row is a call this person was explicitly rung for.",
    })
      .input(z.object({}).strict())
      .query(async ({ ctx }) => sessions.incomingCalls(actorOf(ctx))),

    /**
     * ICE servers, with a freshly minted TURN credential (§3.3, §3.4).
     *
     * A MUTATION, not a query, and not only because it writes. A client that
     * treats this as a cacheable read refetches it on every render, and each
     * refetch spends the org's daily relay allowance — declaring it a mutation
     * puts the cost where a reader looks for side effects.
     *
     * `channel:read` at the route, then the service asks `can()` about the
     * session's channel AND runs the spend gate. Two questions, deliberately not
     * merged: the first is "may you be in this conversation", the second is
     * "should this deployment relay your bytes".
     */
    iceServers: route({ permission: 'channel:read' })
      .input(z.object({ sessionId: z.string().uuid() }).strict())
      .mutation(async ({ ctx, input }) =>
        issueIceServers(actorOf(ctx), deps, { sessionId: input.sessionId }),
      ),

    /**
     * Ringing preferences (§7).
     *
     * `selfRoute`, not `memberRoute`: a ringtone is global per user, not per
     * org, so there is no org to resolve — the same reasoning
     * `notifications.prefs` gives, and the reason `identity.call_prefs` lives
     * in `identity` rather than in `rtc`.
     */
    prefs: router({
      get: selfRoute({
        selfReason:
          'Your own ringtone. Global per user, so there is no org to resolve — the same shape as notification preferences.',
      })
        .input(z.object({}).strict())
        /* `ctx.principal.userId` directly, not `actorOf(ctx)` — `selfRoute`
           resolves no org, so there is no `Subject` to build. */
        .query(async ({ ctx }) => readCallPrefs(ctx.principal.userId)),

      set: selfRoute({
        selfReason: "Writes only the calling user's own ringtone row.",
      })
        .input(
          z
            .object({
              ringtone: RingtoneSchema,
              ringEnabled: z.boolean(),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) =>
          writeCallPrefs(ctx.principal.userId, {
            ringtone: input.ringtone,
            ringEnabled: input.ringEnabled,
          }),
        ),
    }),

    /**
     * Recording, behind the consent gate (§3.9).
     *
     * Every route here is `channel:read` and the service re-checks it against
     * the loaded channel. There is deliberately NO admin permission anywhere in
     * this group: a capability that let an owner record over a participant's
     * objection would make the consent gate decorative, and the org's own admin
     * is exactly who somebody most needs to be able to refuse.
     *
     * `answer` and `stop` are `memberRoute` for the reason `leave` is — they
     * write the caller's own decision, and being unable to withdraw from a
     * recording because a grant changed mid-call is the wrong failure.
     */
    recording: router({
      status: route({ permission: 'channel:read' })
        .input(z.object({ sessionId: z.string().uuid() }).strict())
        .query(async ({ ctx, input }) =>
          recordings.recordingStatus(actorOf(ctx), { sessionId: input.sessionId }),
        ),

      request: route({ permission: 'channel:read' })
        .input(z.object({ sessionId: z.string().uuid() }).strict())
        .mutation(async ({ ctx, input }) => {
          await recordings.requestRecording(actorOf(ctx), { sessionId: input.sessionId });
        }),

      answer: memberRoute({
        memberReason:
          "Records the caller's own consent decision and nothing else. No permission describes 'agree to be recorded', and it must be answerable by anyone in the call.",
      })
        .input(z.object({ sessionId: z.string().uuid(), agreed: z.boolean() }).strict())
        .mutation(async ({ ctx, input }) => {
          await recordings.answerRecording(actorOf(ctx), {
            sessionId: input.sessionId,
            agreed: input.agreed,
          });
        }),

      start: route({ permission: 'channel:read' })
        .input(z.object({ sessionId: z.string().uuid() }).strict())
        .mutation(async ({ ctx, input }) =>
          recordings.startRecording(actorOf(ctx), { sessionId: input.sessionId }),
        ),

      stop: memberRoute({
        memberReason:
          'Stopping a recording must be available to anyone in the call, including somebody whose channel grant changed mid-call.',
      })
        .input(z.object({ sessionId: z.string().uuid() }).strict())
        .mutation(async ({ ctx, input }) => {
          await recordings.stopRecording(actorOf(ctx), { sessionId: input.sessionId });
        }),

      /**
       * A presigned PUT for the captured audio. See the service on why
       * `bytes` — the recording's real, now-known size — has to travel with
       * this call rather than being read off the deployment's ceiling.
       */
      presignUpload: route({ permission: 'channel:read' })
        .input(
          z.object({ recordingId: z.string().uuid(), bytes: z.number().int().positive() }).strict(),
        )
        .mutation(async ({ ctx, input }) =>
          recordings.presignRecordingUpload(actorOf(ctx), deps, {
            recordingId: input.recordingId,
            bytes: input.bytes,
          }),
        ),

      /**
       * Every recording this conversation has, for the details panel's Calls
       * tab (§6's listing gap — the rows and objects were always correct,
       * only a browsing surface was missing).
       */
      list: route({ permission: 'channel:read' })
        .input(
          z
            .object({
              channelId: ChannelIdSchema,
              limit: z.number().int().positive().max(50).default(50),
            })
            .strict(),
        )
        .query(async ({ ctx, input }) =>
          recordings.listRecordingsForChannel(actorOf(ctx), {
            channelId: input.channelId,
            limit: input.limit,
          }),
        ),

      /**
       * A presigned GET for a stored recording — how attendees listen to and
       * download it. A MUTATION, not a query: it mints a capability and
       * writes an audit event, the same reasoning `chat.attachments.download`
       * gives for its own shape.
       */
      presignDownload: route({ permission: 'channel:read' })
        .input(z.object({ recordingId: z.string().uuid() }).strict())
        .mutation(async ({ ctx, input }) =>
          recordings.presignRecordingDownload(actorOf(ctx), deps, {
            recordingId: input.recordingId,
          }),
        ),

      confirmUpload: route({ permission: 'channel:read' })
        .input(
          z
            .object({
              recordingId: z.string().uuid(),
              bytes: z.number().int().nonnegative(),
              durationSeconds: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .mutation(async ({ ctx, input }) => {
          await recordings.confirmRecordingUpload(actorOf(ctx), deps, {
            recordingId: input.recordingId,
            bytes: input.bytes,
            durationSeconds: input.durationSeconds,
          });
        }),
    }),
  });
}
