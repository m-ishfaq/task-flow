/**
 * Hues an avatar can take, spread around the wheel.
 *
 * Chosen from the id rather than from a counter, so the same person is the same
 * colour on every board and in every list — which is the only property that
 * makes a colour worth having. A per-render counter would recolour everyone the
 * moment one card was filtered out.
 *
 * Kept as a stable, curated 8-hue set independent of this app's own accent/
 * neutral tokens on purpose: `ORG_MARK_COLORS`' own header
 * (apps/mobile's org-picker.tsx) documents the identical reasoning for the
 * same shape of problem — a decorative, per-entity color needs several
 * genuinely distinct hues to be worth having, which this app's own limited
 * semantic palette (accent/success/danger/warning) cannot provide without
 * an avatar's color being mistaken for a status.
 *
 * Pulled out of `primitives.tsx` (warm-dark rebuild §5, `person-page.tsx`'s
 * own profile banner — the first caller besides `Avatar` itself) rather
 * than exported alongside it: a non-component export co-located with a
 * component export trips react-refresh's own lint rule, the same reason
 * `flow-tint.ts`/`duplicate-detect.ts` (apps/web/src/features/work) both
 * already live in their own file.
 */
const AVATAR_HUES = [12, 45, 92, 150, 196, 258, 302, 334] as const;

export function hueOf(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    /* An ordinary string hash, and deliberately not from @taskflow/security: this
       picks a colour. Reaching for a CSPRNG here would say the choice is
       security-relevant, and it also has to be STABLE, which a random source is
       not. */
    hash = (hash * 31 + id.charCodeAt(index)) % 1_000_003;
  }
  return AVATAR_HUES[hash % AVATAR_HUES.length] ?? 258;
}
