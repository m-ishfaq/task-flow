# Warm-dark visual rebuild — design guide

**Status: DRAFT — awaiting review. No implementation has started.** This document is the
required checkpoint before any component or screen changes begin, per the plan approved for
this branch. Read CLAUDE.md's own "a status marker is a claim, not a fact" discipline as
applying here too: this header stays DRAFT until the person who asked for this rebuild says
otherwise, not until the document merely looks finished.

## 0. Why this document exists, and what it does not cover

TaskFlow's UI has already been through three rounds of consistency/motion polish this session
(typography, color tokens, elevation, missing transition durations, three dead design tokens
wired up) on the existing cold, violet-accented dark theme — all shipped, all staying exactly
as they are on `auto/nice-ride-nkdnsb`. This document is not that. It specifies a **new visual
direction** — warm-dark, gold-accented, informed by (not copied from) `pbakaus/impeccable`'s
own "kinpaku" example — to be built from zero on this new branch, across both `apps/web` and
`apps/mobile`.

This document specifies the **foundation**: the token system, the component consolidation the
foundation phase needs to do once, the mobile primitive layer that doesn't exist yet, and how
the newly vendored skills (`.claude/skills/animate`, `.claude/skills/impeccable`, etc.) actually
get used in the build order. It does **not** contain a literal pixel spec for all ~184 screens
— that gets written per-batch, against this foundation, once the foundation itself is built and
reviewed. Writing exhaustive per-screen specs before the foundation exists would mean redoing
them the moment a token value changes during review.

## 1. Direction statement

**The family: warm-dark.** Every current chromatic token — surfaces, ink, lines — sits at OKLCH
hue 262, a cold blue-gray. The rebuild moves the entire neutral family to **hue 55** — warm,
amber-leaning, the same register (not the same numbers) as kinpaku's own hue-95 "lacquer-black."
262 and 55 are roughly opposite each other on the hue wheel; this is not a subtle tint shift, it
changes what every near-black, every border, every muted-text color reads as.

**The accent: a true warm gold**, hue **88** — distinctly TaskFlow's own value, not kinpaku's
`80.46`, chosen far enough from `--color-warning`'s existing hue `75` that the two don't
collide (the current accent, violet at hue `285`, and warning, orange at `75`, are 210° apart
and never get confused — the new accent needs the same real separation from warning, not just a
different label). This is the single biggest implementation-affecting decision in this whole
document, explained in §2.2.

**What does NOT change hue:** `--color-danger` (hue 22, red) and `--color-success` (hue 155,
green) stay exactly where they are. They are semantic — "this failed" / "this succeeded" — not
brand, and a warm-dark rebuild has no reason to touch a WCAG-audited semantic color that isn't
part of the brand family. `--color-warning` (hue 75, orange) also stays, for the same reason,
and because it needs to stay visually distinct from the new gold accent, not closer to it.

**No second brand accent.** Kinpaku's own structure pairs its gold with a second "verdigris
patina" accent for states. TaskFlow doesn't need an equivalent: semantic color (danger/warning/
success) already covers state, and there is no existing "suite" per-module color system to
harmonize (checked directly against `apps/web/src/styles.css` and `packages/tokens/src/
colors.ts` while writing this — no `--color-suite-*` tokens exist in either file today, despite
an earlier, incorrect claim to the contrary surfacing during this rebuild's own research pass;
per-module color coding, if wanted, is a **new** concept for a later phase, not a rename of
something that already exists). Inventing a second accent with no clear job would be the exact
kind of "extracted but nothing draws on it" pattern already found once in this codebase
(`packages/ui`'s under-adoption) — not repeated here on day one of a new system.

## 2. Full token specification

All values below are **starting proposals**, reasoned by hand, not verified against a real
contrast calculator — this repo already has one (`packages/tokens/src/colors.test.ts`, built on
`@csstools/color-helpers`) and §2.4 states exactly how to point it at these new pairings before
any of these numbers count as final. Every current value quoted below was read directly from
`apps/web/src/styles.css` while writing this document, not from memory.

### 2.1 Neutral family (surfaces, ink, lines) — hue 262 → hue 55

| Token | Current (cold, hue 262) | Proposed (warm, hue 55) |
|---|---|---|
| `--color-surface` | `oklch(16% 0.015 262)` | `oklch(16% 0.014 55)` |
| `--color-surface-raised` | `oklch(20% 0.018 262)` | `oklch(20% 0.017 55)` |
| `--color-surface-sunken` | `oklch(12% 0.013 262)` | `oklch(12% 0.012 55)` |
| `--color-surface-hover` | `oklch(23% 0.018 262)` | `oklch(23% 0.017 55)` |
| `--color-ink` | `oklch(93% 0.008 262)` | `oklch(93% 0.010 55)` |
| `--color-ink-muted` | `oklch(66% 0.015 262)` | `oklch(66% 0.016 55)` |
| `--color-ink-faint` | `oklch(56% 0.014 262)` | `oklch(56% 0.015 55)` |
| `--color-line` | `oklch(28% 0.012 262)` | `oklch(28% 0.013 55)` |
| `--color-line-strong` | `oklch(35% 0.014 262)` | `oklch(35% 0.015 55)` |

L and C are kept close to their current values (same lightness ladder, same rough saturation) —
only the hue moves. This is deliberate: the existing L values already encode a real, working
elevation/legibility ladder (surface-sunken darkest, surface-hover lightest, ink readable against
all four) that the color-token work earlier this session didn't need to touch. Re-deriving that
whole ladder from scratch would risk losing properties nobody would notice broke until a real
screen rendered wrong. Chroma nudged up very slightly (e.g. `0.015`→`0.014` isn't even a real
change; a couple of others go up by `0.001`–`0.002`) only because a warm hue at very low chroma
can read as "just gray with no real color," where the same chroma at a cold hue still reads
distinctly blue — a warm neutral needs a touch more saturation to actually feel warm rather than
merely "the same gray, renamed."

### 2.2 Accent — hue 285 (violet) → hue 88 (gold)

| Token | Current | Proposed |
|---|---|---|
| `--color-accent` | `oklch(55% 0.17 285)` | `oklch(72% 0.14 88)` |
| `--color-accent-ink` | `oklch(98% 0.01 285)` | `oklch(16% 0.02 88)` |
| `--color-accent-hover` | `oklch(50% 0.17 285)` | `oklch(66% 0.15 88)` |

**This is the change every other token change is small next to.** The current violet sits at
55% lightness — dark enough that white text (`accent-ink` at 98% L) reads clearly on it. Real
gold reads as gold at a much higher lightness; pushed down to 55% L it stops looking like gold
and starts looking like brown/olive. So the proposed accent moves UP to 72% L — and at 72% L, a
**light** ink fails completely; gold that light needs a **dark** ink, the identical physics
kinpaku's own `dark-ink` token exists for ("foreground on gold; never theme-remapped" — not a
stylistic choice, a contrast requirement). `--color-accent-ink` flips from `98%` to `16%`
lightness as a direct, necessary consequence, not a matching aesthetic choice.

**This flip touches more than the token.** Anywhere in `apps/web`/`apps/mobile` that assumes
"accent-ink is always light text on a colored background" (every filled `Button` variant using
the accent color, `Badge`'s accent tone, the accent-filled toggle-switch knob shadow, etc.) keeps
working correctly automatically IF it already reads `--color-accent-ink` rather than hardcoding
white — which is the whole reason that token exists. The foundation phase's job is finding any
call site that hardcoded `white`/`#fff`/`text-white` next to an accent background INSTEAD of
using the token (the mobile research pass already found raw `#fff` literals in `toast.tsx`,
`fab.tsx`, `call-surface.tsx`, `notification-bell.tsx` — those need checking specifically for
whether they sit on an accent-colored background, in which case they are now broken, not just
inconsistent).

`accent-hover` follows the same "darker, same hue" pattern that already exists for the darker
violet (`55%→50%`), scaled to the new base: `72%→66%`, a proportionally similar step down,
reading as a richer/deeper gold on press rather than a lighter one.

### 2.3 Priority swatches — re-derived, not copied

`--color-priority-medium` currently reuses the **accent hue** (285) at a re-tuned lightness
(60%, not accent's 55%) specifically so a priority swatch — a colored bar on a card, `list-
view.tsx`'s Badge background — clears 3:1 non-text contrast against all four surface tones
(`styles.css`'s own comment on this, read directly while writing this document, documents the
exact numbers: 3.25:1 / 3.38:1 margins that were only found by checking all four surfaces, not
just one). Moving the accent hue to 88 means `priority-medium` should move to hue 88 too, to
keep signaling "this relates to the brand hue" — but its own lightness cannot be assumed to
carry over unchanged, because the SURFACE tones it's being checked against are also moving (§2.1).
**A new lightness for `priority-medium` at hue 88 must be found by the same method — check
against all four new surface tones, not by inheriting `60%` on the assumption it will still
clear 3:1.** `--color-priority-urgent` (hue 22, tied to danger's hue, not accent's) needs the
identical re-check against the new surfaces even though its hue doesn't change, since the
SURFACES it's checked against do.

### 2.4 Required verification step before treating any of §2.1–2.3 as final

This repo already has the right tool for this — `packages/tokens/src/colors.test.ts` derives
sRGB hex from OKLCH via `@csstools/color-helpers` and asserts the two agree. The foundation
phase should write a small, throwaway script (not a permanent test) using that same library to
compute real WCAG contrast ratios for every pairing `styles.css`'s own comments already treat as
load-bearing:
- `--color-accent-ink` on `--color-accent` (button label text — 4.5:1 text bar)
- `--color-accent` against all four surfaces (non-text uses — border, ring, icon — 3:1 bar)
- `--color-priority-medium`/`-urgent` against all four surfaces (3:1, per §2.3)
- `--color-ink`/`-muted`/`-faint` against all four new surfaces (4.5:1 for ink/muted as body
  text, 3:1 minimum for faint where it's ever used as text rather than a non-text label)

Any pairing that fails gets its L/C nudged (hue stays fixed — that's the brand decision) and
re-checked, the same iterate-until-it-clears process `styles.css`'s own comment history already
documents once for the priority tokens. This step is not optional polish; it's why the numbers
in §2.1–2.3 are labeled "proposed" rather than final.

### 2.5 Elevation, radius, motion — unchanged in structure, revisit values only if warm shadows need it

`--shadow-sm/md/lg/xl`, `--shadow-lift-1/2/3`, `--shadow-top-light`, `--radius-card` (currently
`0.625rem`), and the motion tokens (`--motion-fast` 120ms, `--motion-base` 200ms, `--motion-ease`)
all stay structurally as they are — none of them encode a hue, so a warm-dark rebuild has no
inherent reason to touch their VALUES. One real check worth doing in the foundation phase: every
current shadow is a plain `oklch(0% 0 0 / N%)` (pure black, no hue) — on a warm-hued surface
family, a pure-black shadow can look slightly "off," faintly cool, against a warm background.
Whether that's worth fixing (nudging shadow alpha colors to a very low-chroma warm black instead
of pure achromatic black) is a real but genuinely minor call — visible only in a real screenshot,
which this sandbox cannot produce. Flag it for the first real screen review rather than guessing
blind here.

### 2.6 Typography — keep Geist for body/UI, reconsider the display face

Body text (`--font-sans`) and code (`--font-mono`) stay Geist — it's already self-hosted, already
fetched on every page, and "warmer" doesn't require changing the working text a person reads for
hours. `--font-display` (page/panel titles, the wordmark) currently ALSO points at Geist — a
geometric, neutral sans. A genuinely warmer, more human feel usually comes from the display face
having real personality distinct from the body face, the same "three faces, each with a job"
structure this app's fonts already use, just changing what job the display face's PERSONALITY
does. Real, open-source, self-hostable candidates worth choosing between (not a unilateral pick —
font choice is a strong taste call): **Fraunces** (a warm, slightly quirky variable serif with a
real "soft-optical-size" axis — probably the closest match to "warm/human" of the three),
**Newsreader** (a calmer, more editorial variable serif — warm but more restrained), **Source
Serif 4** (a plainer, safer serif — warm relative to Geist, but the least distinctive of the
three). Whichever is chosen, it needs the same self-hosting treatment Geist already has
(`public/fonts/`, an `@font-face` rule, `font-display: swap`) — this is new asset weight on every
page's first load, unlike the color-token changes, and worth measuring once picked.

### 2.7 apps/mobile — the token mirror

`packages/tokens/src/colors.ts` (and `palettes.ts`, `spacing.ts`) get the identical hue changes,
re-derived through the SAME oklch→hex path `colors.test.ts` already verifies, not hand-converted
hex values guessed independently — the whole point of that file's existing machinery is that a
human should never hand-compute a hex value from an oklch triple. `palettes.ts`'s own stale `ink`
hue (found during this rebuild's research, still at hue 258 while `colors.ts`'s `accentInk`
already moved to 285 at some point without `palettes.ts` following) gets fixed to the new hue 88
in the SAME pass, not left as a second, older drift sitting next to a brand-new one.

## 3. Component consolidation plan (web foundation)

Each of the following was found, during this rebuild's own research pass, to already have 3+
real, independent implementations of the same pattern — past this codebase's own stated §6
threshold for when something should be extracted once and reused, but never actually promoted
to a shared location. The foundation phase resolves each ONCE, before any screen's colors change,
so 184 screens don't each get their own copy of the new palette applied to 3 different button
shapes.

| Pattern | Current duplicates | Canonical home | Notes |
|---|---|---|---|
| Segmented/tab control | `primitives.tsx`'s `Segmented`, platform-admin's local `TabBar`, raw `role="tablist"` markup in 4+ files (docs-page, automations-page, telephony-page, import-export-dialog) | `primitives.tsx`'s `Segmented`, generalized to cover platform-admin's `TabBar` use case | Already generic-typed; the gap is adoption, not capability |
| Dropdown/menu | `platform-admin/shared.tsx`'s `RowActionsMenu` (hand-rolled open/close, click-catcher, Escape handling), two in `work/list-column.tsx`, one each in `work/bulk-bar.tsx` and `chat/message-list.tsx` | `packages/ui`'s existing `DropdownMenu` (Modal/Popover's own sibling — already well-extracted and adopted in 27 files) | These bypass a component that already exists and already works; this is deletion of duplicate code, not new code |
| Status pill / badge | `primitives.tsx`'s `Badge`, `platform-admin/shared.tsx`'s `StatusPill` (itself already consolidated from 4 real duplicates, but never reconciled upward) | One shape, promoted to `packages/ui` since both web-only consumers already exist and mobile will want an equivalent | First real candidate for `packages/ui` growing past its current 3 components |
| Tooltip | None exists anywhere; the pattern recurs unstyled/ad hoc in 10+ files | New: `packages/ui` | The one genuinely NEW primitive this consolidation adds, not a resolution of duplicates |
| Empty state | `primitives.tsx`'s well-adopted `Empty` (26 importers) vs. 7 files hand-rolling a `border-dashed` box instead | `Empty`, unchanged — just adopted at the 7 remaining sites | No design decision needed, pure cleanup |

`packages/ui` growing from 3 components to 5–6 is itself a real decision worth stating plainly:
the package's current thinness is not neglect (Modal/DropdownMenu/Popover are genuinely well
extracted and adopted), so anything promoted into it during this rebuild needs the SAME real
adoption discipline — a component that exists in the package but stays unimported anywhere is
the exact "extracted but never promoted" gap this rebuild's own research already found once with
`packages/ui` itself and once more with `platform-admin/shared.tsx`'s locally-scoped mini design
system. Promoting `Badge`/`StatusPill` and adding `Tooltip` only counts as done once real call
sites are updated to use them, in the same batch, not left as a future todo.

## 4. Mobile primitives plan (new — apps/mobile has none of this today)

`apps/mobile` has zero shared UI components today — every screen hand-rolls its own
`StyleSheet`-based button/input by convention. This is not a consolidation job like web's; it's
building the layer from zero. Minimum viable set, mirroring what `primitives.tsx` already proves
out on web: `Button` (+ variants matching web's), `Input`, `Card`/`Field` container, `Badge`,
`Empty`, `Avatar`, `Skeleton`. Each pulls its colors from `packages/tokens` (§2.7) rather than a
local hex literal, closing the exact "raw hex bypassing tokens" gaps the mobile research pass
already found (`work.ts`'s label swatches, `#fff`/`#000` literals in `toast.tsx`/`fab.tsx`/
`call-surface.tsx`/`notification-bell.tsx`, a raw `#6B7280` gray in two screens, a raw
`#00000099` scrim instead of the `overlay` token).

**Reanimated / Gesture Handler / expo-haptics — recommendation: adopt now, in the foundation
phase, not deferred.** `apps/mobile` has neither today; all existing motion uses RN's built-in
`Animated` API. The case for adopting now rather than later: (1) `.claude/skills/animate-expo`
— one of the three skills this whole rebuild exists to get real use out of — assumes all three
are present; building the new mobile primitives on the OLD `Animated` API first and porting to
Reanimated later means redoing every primitive's motion twice. (2) A primitive library is
exactly the layer where motion-primitive decisions (press feedback, sheet entrances, list-item
transitions) get made ONCE and reused everywhere — the cheapest possible point to introduce a
new dependency, before 184 screens each have their own motion code depending on the old API.
(3) The real cost — new native modules, an EAS rebuild, "does it work correctly on both iOS and
Android" — is a one-time cost regardless of when it's paid, and paying it now means the entire
mobile portion of this rebuild is built on the intended foundation from the start rather than
migrated partway through. The counter-case (defer) is real but weaker: less immediate risk if
the mobile rebuild stalls partway, since deferred means zero new native surface introduced until
truly needed. Recommendation stands at **adopt now**; flag this specific line to the user for a
one-line confirmation before the mobile foundation batch starts, since it's the one decision
here with real infrastructure cost (EAS build config, native module compatibility) rather than
pure application code.

## 5. Module-by-module application

Applies the finished foundation (tokens + consolidated web components + new mobile primitives)
to each product surface. Per-screen specifics are written per batch at implementation time, not
here — what belongs here is what's genuinely different about each module's treatment.

- **Work** (boards, lists, cards, sprints): the highest-traffic surface on both platforms: board
  columns, card tiles, the detail panel. The already-shipped column-tint and card-shadow work on
  `auto/nice-ride-nkdnsb` (Track 3) doesn't carry over automatically — those tints/shadows were
  tuned against the COLD palette's surface tones and need re-deriving against the new warm ones,
  not copied verbatim.
- **Chat**: message bubbles, reactions, the composer. No module-specific token needs — mostly a
  straight application of the new neutral/accent family.
- **Docs**: the editor and page tree are Operate-register, same as everything else. The ONE
  exception is the **public, no-session reader view** (`docs.public.getPage`, Phase 6 Wave 4) —
  a page served to an anonymous reader is genuinely landing-page/reading-shaped, which is where
  `.claude/skills/taste-skill`'s own stated scope ("landing pages... not dashboards") actually
  applies for the first time in this app. Worth a distinct, slightly more editorial treatment
  (more generous type scale, no app-shell chrome) rather than the same dense Operate styling as
  every authenticated screen.
- **Voice & Messaging**: the in-call surface and ringing UI have real motion requirements
  (`.claude/skills/animate`/`apple-design` — interruptible transitions, momentum) already called
  out in this codebase's own CLAUDE.md notes on the call widget; revisit under the new palette
  with the same rigor, not a fresh design.
- **People**: mostly data-table/profile-card patterns already covered by the component
  consolidation in §3 — low module-specific risk.
- **Platform** (platform-admin console): the surface the user already singled out as liking
  ("the current Vercel type design... lets polish it further") — under the new warm-gold system,
  this is the module most likely to visually anchor the whole new direction, since it's already
  the most deliberately "console-like" surface in the app.
- **Mobile, 5 tabs + Account**: My Tasks/Boards/Chat/Docs/Calls get the new mobile primitives
  (§4) applied per-tab; People/Platform (reached via Account, no tab) follow web's own module
  notes above, adapted to mobile layout.

## 6. Skill usage map — where each vendored skill actually earns its keep

- **`.claude/skills/impeccable`'s `craft-floor.md`** — the per-surface QUALITY GATE. Every batch,
  before a screen counts as done: contrast (§2.4's real numbers, not eyeballed), depth (shadows
  carry real offset+blur per §2.5, not a flat colored halo), spacing rhythm, the banned-pattern
  list (no identical card grids, no hero-metric template, no gradient text, no decorative glass,
  no side-stripe borders standing in for a real border, no glyph/emoji icons). This is the ONE
  skill that runs against literally every batch, not a per-module choice.
- **`.claude/skills/animate` / `review-animations` / `find-animation-opportunities`** — web
  motion. `find-animation-opportunities` runs once per module during that module's batch (read-
  only — proposes candidates, rejects most of them, per its own stated restraint); `animate`
  writes what it approves; `review-animations` gates the diff before the batch is called done.
- **`.claude/skills/animate-expo` / `apple-design`** — the mobile equivalent, once Reanimated/
  Gesture Handler/haptics are adopted (§4).
- **`.claude/skills/taste-skill`** — exactly one surface, per §5: Docs' public reader view. Its
  own stated scope explicitly excludes dashboards and multi-step product UI, which is what the
  rest of this app is; using it anywhere else would be reaching for a tool outside its own stated
  job.

## 7. Batching and sequencing

**Foundation first, in this order, each its own reviewable batch:**
1. Token specification (§2) — `styles.css` + `packages/tokens`, together, with the §2.4 contrast
   check run and any failing pairing corrected before the batch is called done.
2. Web component consolidation (§3) — one PR-sized batch per row of the table in §3, since each
   is an independent, self-contained change (e.g. "promote `DropdownMenu` adoption" doesn't
   depend on "add `Tooltip`").
3. Mobile primitives (§4) — including the Reanimated/Gesture Handler/haptics adoption, as its
   own batch, before any mobile screen changes.

**Then module-by-module (§5), web and mobile interleaved per module rather than "all of web,
then all of mobile"** — recommended because a module's design decisions (e.g. Work's card-tile
treatment) are shared design work between platforms even though the code is separate; deciding
Work's look once and applying it to both platforms in the same stretch of work keeps the two
platforms from drifting into two different interpretations of the same module.

**Batch size**: given no live rendering is possible in this sandbox, a batch should be small
enough that its full diff can be read carefully end to end and its static verification (tsc,
eslint, prettier, guardrail-selftest, `check:typography`, `check:encoding`, tests) is a
meaningful proxy for correctness — roughly 3–6 screens per batch on the screen-by-screen phase,
matching the size of the batches already used successfully in this session's earlier Track 1–3
work, rather than attempting a whole module (10+ screens) in one commit.

## 8. Explicit non-goals

Presentation layer only. This rebuild, at every phase and every batch, does not touch:
- `packages/policy` or `packages/db`, or any RLS/authorization decision.
- What data any role can see or do — a visual change is never license to also "clean up" an
  authorization check found along the way; that's a separate, separately-reviewed change.
- `dangerouslySetInnerHTML` anywhere, under any justification.
- Client-side re-derivation of a permission the server already decides.
- The guardrail-selftest's own computed-ESLint-config assertions — if a rebuild batch needs a
  new lint exception, it goes through `packages/config/eslint/security.js` with a stated reason
  and a `packages/guardrail-selftest` case, per CLAUDE.md's own rule, never an inline
  `// eslint-disable`.

Full verification (tsc/eslint/prettier/guardrail-selftest/`check:typography`/`check:encoding`/
tests) stays green at every single commit from the first foundation batch onward — this document
being long is not license for the batches that follow it to be sloppy.
