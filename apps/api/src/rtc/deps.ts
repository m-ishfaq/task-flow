import {
  mintTurnCredential,
  type MintTurnCredentialOptions,
  type TurnCredential,
} from '@taskflow/security';
import { S3StorageProvider } from '@taskflow/storage';
import type { StorageProvider } from '@taskflow/contracts';
import type { Env } from '../config/env.js';

/**
 * In-app voice dependencies (ai/phase-13-webrtc.md §3.3).
 *
 * ## Why the minter is injected rather than imported at the call site
 *
 * §3.4's acceptance bar for the TURN gate is the one Phase 7 Wave 1 set for the
 * spend gate, and it is not "a refusal is returned". It is that **the secret was
 * never used** — asserted against a stand-in that would have recorded the call.
 * A gate that answers `{ allowed: false }` after minting reads perfectly in a
 * diff and hands out a working credential.
 *
 * That assertion is only expressible if the minting step is a seam. So it is
 * one, defaulted to the real primitive so no production path can accidentally
 * get a different implementation.
 */

export type TurnMinter = (options: MintTurnCredentialOptions) => TurnCredential;

export interface RtcDeps {
  /** ICE servers the browser gets unconditionally. Relay nothing, cost nothing. */
  readonly stunUrls: readonly string[];
  /** Relay servers. Empty when TURN is not configured — a valid deployment. */
  readonly turnUrls: readonly string[];
  /**
   * coturn's `static-auth-secret`. Undefined exactly when `turnUrls` is empty —
   * the env schema refuses to boot on one without the other, because a relay the
   * browser cannot authenticate against fails by silently falling back to STUN.
   */
  readonly turnSecret: string | undefined;
  readonly turnTtlSeconds: number;
  /** Credentials per org per rolling 24 hours (§3.4). */
  readonly turnIssuanceCapPerDay: number;
  /** Passed to `RTCPeerConnection` verbatim. `relay` exercises the TURN path. */
  readonly iceTransportPolicy: 'all' | 'relay';
  /** See the header. Defaults to `mintTurnCredential`. */
  readonly mint: TurnMinter;
  /**
   * Where call recordings land (§3.9).
   *
   * Undefined when no recordings bucket is configured, and the routes answer
   * SERVICE_UNAVAILABLE rather than being absent — the same reasoning
   * `telephony/router.ts` gives: `AppRouter`'s TYPE is what the browser client
   * generates from, so a shape that varied by deployment would produce a
   * different client per environment.
   */
  readonly storage: StorageProvider | undefined;
  /**
   * Ceiling on one uploaded capture, pinned into the presigned PUT's signature.
   *
   * Pinned rather than checked, which is what makes it a limit rather than
   * advice — `packages/storage/src/s3.ts`'s own note on `signableHeaders`. At
   * roughly 32 kbit/s for Opus in a WebM container, 64 MB is about four hours;
   * a call longer than that is not the case this bound exists for.
   */
  readonly maxRecordingBytes: number;
}

/** Splits a comma-separated URL list the way `allowedOrigins` splits origins. */
function urlList(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Builds the dependencies from validated environment.
 *
 * Always returns a value, unlike `buildTelephonyDeps`, which returns undefined
 * with no carrier. The difference is real: telephony without a carrier can do
 * nothing at all, whereas in-app voice with STUN and no TURN is a working
 * feature for most networks. The routes reflect that — `iceServers` answers with
 * whatever is configured, and the absence of a relay is not an error.
 */
export function buildRtcDeps(
  env: Env,
  options: { readonly mint?: TurnMinter; readonly storage?: StorageProvider } = {},
): RtcDeps {
  /* The recordings bucket is shared with telephony's — one bucket, two key
     prefixes (`rtc/` here, telephony's own there) rather than a second bucket
     and a second credential to keep private. The objects have the same
     sensitivity and the same access rule: only a presigned URL from an
     authorized route ever reaches a browser.

     Built HERE from env rather than threaded in from `buildTelephonyDeps`,
     because that function returns undefined with no carrier — and an instance
     with no Twilio account can still hold in-app calls. Tying recording to a
     carrier would mean "you need a phone provider to record a WebRTC call",
     which is not true and would be discovered as a missing button. */
  const storage =
    options.storage ??
    (env.STORAGE_BUCKET_RECORDINGS === undefined
      ? undefined
      : new S3StorageProvider({
          endpoint: env.STORAGE_ENDPOINT,
          region: env.STORAGE_REGION,
          bucket: env.STORAGE_BUCKET_RECORDINGS,
          accessKeyId: env.STORAGE_ACCESS_KEY_ID,
          secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
          forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
        }));

  return {
    storage,
    maxRecordingBytes: env.RTC_MAX_RECORDING_BYTES,
    mint: options.mint ?? mintTurnCredential,
    stunUrls: urlList(env.RTC_STUN_URLS),
    turnUrls: urlList(env.RTC_TURN_URLS),
    turnSecret: env.RTC_TURN_SECRET,
    turnTtlSeconds: env.RTC_TURN_TTL_SECONDS,
    turnIssuanceCapPerDay: env.RTC_TURN_ISSUANCE_CAP_PER_DAY,
    iceTransportPolicy: env.RTC_ICE_TRANSPORT_POLICY,
  };
}
