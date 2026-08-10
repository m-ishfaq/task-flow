import { MESH_PARTICIPANT_CAP } from '@taskflow/api/rtc/session';
import { defineSeedModule } from '../registry.js';
import { daysBefore, minutesAfter } from '../support.js';
import type { Rng } from '../rng.js';
import { channelsModule, type SeededChannel } from './chat.channels.js';
import type { SeededMembership } from './tenancy.orgs.js';

/**
 * In-app voice call history (Phase 13, ai/phase-13-webrtc.md).
 *
 * ## Only `dm` and `group_dm` channels ring
 *
 * Calls in public channels are one of the explicitly-still-open items the
 * phase's own status notes name — the ring list a public channel would need
 * is its member tuples and a public channel has none. Seeding a session
 * against a public channel would be a row the product cannot yet produce, the
 * exact "impossible row" this package's other modules are built to avoid. So
 * this module filters to direct and group-direct channels only, the same
 * `isDirect` boundary `chat.channels.ts` itself draws.
 *
 * ## `participants` is a record, not this module reasoning about authorization
 *
 * Exactly as `packages/db/src/schema/rtc.ts`'s own header warns: this module
 * is not deciding who MAY have joined a call, only writing rows that describe
 * what a finished one looked like. The roster is drawn straight from the
 * channel's real membership.
 *
 * ## Every session is `ended` — this is a call HISTORY, not a live call
 *
 * `sessions_one_live_per_channel` is a partial unique index scoped to
 * `status <> 'ended'`, so any number of ended sessions can coexist per
 * channel with no conflict — a seeded call log is just a channel's finished
 * calls, one row per past call.
 *
 * ## Two shapes, not every shape
 *
 * A real deployment's history has more variety than this (declined calls,
 * empty ones nobody joined), but the two seeded here — answered, and
 * unanswered — are the two the UI actually needs demo data for: the call
 * timeline card (`CallTimelineCard`) and the notification bell's
 * `call.missed` badge each read one of exactly these two shapes.
 */

const END_REASONS = ['hung_up', 'no_answer'] as const;

interface CallPlan {
  readonly channel: SeededChannel;
  readonly initiator: SeededMembership;
  readonly participants: readonly SeededMembership[];
  readonly answered: boolean;
}

function isDirect(type: SeededChannel['type']): boolean {
  return type === 'dm' || type === 'group_dm';
}

/** 1–3 past calls per eligible channel, mixing answered and missed. */
function planCalls(rng: Rng, channel: SeededChannel): CallPlan[] {
  if (channel.members.length < 2) return [];

  const count = rng.int(1, 3);
  const plans: CallPlan[] = [];

  for (let i = 0; i < count; i += 1) {
    const roster = rng.sample(
      channel.members,
      Math.min(MESH_PARTICIPANT_CAP, channel.members.length),
    );
    const initiator = rng.pick(roster);
    plans.push({
      channel,
      initiator,
      participants: roster,
      /* Weighted toward answered — a call log that is mostly missed calls
         reads as a broken product, not a realistic one. */
      answered: rng.chance(0.7),
    });
  }
  return plans;
}

export const rtcModule = defineSeedModule({
  name: 'rtc.calls',
  requires: [channelsModule],
  /* Teardown order is the reverse of this list (registry.ts) — recordings
     and participants both carry a real foreign key to sessions, so they
     must clear first, which means sessions is listed FIRST here. */
  tables: ['rtc.sessions', 'rtc.participants', 'rtc.recordings'],

  async seed(ctx) {
    const rng = ctx.rng.fork('rtc.calls');
    const { channels } = ctx.use(channelsModule);

    let sessionCount = 0;
    let recordingCount = 0;

    const byOrg = new Map<string, SeededChannel[]>();
    for (const channel of channels) {
      if (!isDirect(channel.type)) continue;
      const list = byOrg.get(channel.orgId) ?? [];
      list.push(channel);
      byOrg.set(channel.orgId, list);
    }

    for (const [orgId, orgChannels] of byOrg) {
      const sessionRows: unknown[][] = [];
      const participantRows: unknown[][] = [];
      const recordingRows: unknown[][] = [];

      for (const channel of orgChannels) {
        for (const plan of planCalls(rng, channel)) {
          const sessionId = rng.uuid(ctx.now);
          const kind = rng.chance(0.2) ? 'video' : 'audio';
          const endReason = plan.answered ? END_REASONS[0] : END_REASONS[1];

          const ringingAt = daysBefore(ctx.now, rng.int(1, 180));
          /* A short answer delay — the seconds between the ring and someone
             picking up — rather than starting the instant it rings. */
          const startedAt = plan.answered ? minutesAfter(ringingAt, rng.int(0, 1)) : null;
          const durationMinutes = plan.answered ? rng.int(1, 24) : 0;
          const endedAt = plan.answered
            ? minutesAfter(ringingAt, durationMinutes)
            : minutesAfter(ringingAt, rng.int(1, 2));

          const joinedRoster = plan.answered ? plan.participants : [plan.initiator];
          let recording: { readonly id: string; readonly bytes: number } | null = null;

          if (plan.answered && rng.chance(0.25)) {
            const durationSeconds = durationMinutes * 60;
            recording = {
              id: rng.uuid(endedAt),
              /* ~32 kbit/s Opus in a WebM container — the same estimate
                 CLAUDE.md's own note on RTC_MAX_RECORDING_BYTES uses. */
              bytes: Math.round(durationSeconds * 4000),
            };
          }

          sessionRows.push([
            sessionId,
            orgId,
            channel.id,
            kind,
            'ended',
            plan.initiator.user.id,
            MESH_PARTICIPANT_CAP,
            joinedRoster.length,
            recording !== null ? 'stopped' : 'none',
            recording !== null ? plan.initiator.user.id : null,
            recording !== null ? startedAt : null,
            recording !== null ? joinedRoster.length : 0,
            startedAt,
            endedAt,
            endReason,
            ringingAt,
            endedAt,
          ]);
          sessionCount += 1;

          for (const member of plan.participants) {
            /* Never both: the initiator is always in `joinedRoster` (they are
               the one who placed the call), so an unjoined member is never
               the initiator — no separate branch needed for that case. */
            const joined = joinedRoster.includes(member);
            const state = joined ? 'left' : 'missed';

            participantRows.push([
              sessionId,
              orgId,
              member.user.id,
              state,
              ringingAt,
              joined ? startedAt : null,
              joined ? endedAt : null,
              joined && recording !== null ? startedAt : null,
              null,
            ]);
          }

          if (recording !== null) {
            recordingRows.push([
              recording.id,
              orgId,
              sessionId,
              'stored',
              `rtc/${orgId}/${sessionId}/${recording.id}.webm`,
              'audio/webm',
              recording.bytes,
              durationMinutes * 60,
              plan.initiator.user.id,
              startedAt,
              endedAt,
            ]);
            recordingCount += 1;
          }
        }
      }

      if (sessionRows.length === 0) continue;

      await ctx.orgScope(orgId, async () => {
        await ctx.db.insert(
          'rtc.sessions',
          [
            'id',
            'org_id',
            'channel_id',
            'kind',
            'status',
            'initiated_by',
            'max_participants',
            'joined_count',
            'recording_state',
            'recording_requested_by',
            'recording_started_at',
            'consent_count',
            'started_at',
            'ended_at',
            'end_reason',
            'created_at',
            'updated_at',
          ],
          sessionRows,
        );
        await ctx.db.insert(
          'rtc.participants',
          [
            'session_id',
            'org_id',
            'user_id',
            'state',
            'invited_at',
            'joined_at',
            'left_at',
            'recording_consent_at',
            'recording_declined_at',
          ],
          participantRows,
        );
        if (recordingRows.length > 0) {
          await ctx.db.insert(
            'rtc.recordings',
            [
              'id',
              'org_id',
              'session_id',
              'status',
              'storage_key',
              'content_type',
              'bytes',
              'duration_seconds',
              'created_by',
              'created_at',
              'stored_at',
            ],
            recordingRows,
          );
        }
      });
    }

    ctx.log(
      `rtc.calls: ${String(sessionCount)} sessions across dm/group_dm channels ` +
        `(${String(recordingCount)} with a recording)`,
    );

    return { sessionCount, recordingCount };
  },
});
