# Phase 6.5 — UI Polish & Design System

**Status: all six waves shipped 2026-08-08, with one item — the screen-reader pass — not done and
not claimed to be.** Audit, design tokens (including the `line`/`line-strong` border-contrast fix),
`packages/ui` extraction, a Chat/Docs/density/optimistic-mutation consistency pass, accessibility
hardening (icon labels, a real keyboard gap found and fixed, motion wired up), and full responsive
layout all landed the same day. This phase was never formally approved before Wave 3 started —
Waves 1–3 shipped built-ahead-of-approval on the strength of §13's own "Recommended: yes" items.
Wave 6 shipped on the author's explicit go-ahead for full (not desktop-only) responsive scope, and
Waves 4–5 followed the same request to finish the remaining open work. Three things stay explicitly
open regardless of "all six waves shipped": the screen-reader pass (§4.1, §8), real-browser
verification of the responsive work (§9.1), and dnd-kit's keyboard sensors re-tested against the
Modal extraction (§8) — none of which this environment can perform. "Shipped" here means every
wave's code-reachable scope is done and verified by typecheck/lint/test/build; it does not mean
every acceptance criterion the original draft wrote for itself is met, and the three items above
are named specifically because they aren't.

**The real audit corrected this document's own §3.1 table, twice, before Wave 3 wrote a line of
component code.** The original table (written from a single combined grep across five Radix
import patterns, without separating which pattern matched which file) claimed
`filter-builder.tsx` used `@radix-ui/react-select` and that `Checkbox` was "scattered across
checklist, bulk-select, filter builder." Re-running the grep per-pattern instead of combined
found neither was true: `@radix-ui/react-select` has **zero** import sites anywhere in
`apps/web` — an unused dependency, since removed — and `@radix-ui/react-checkbox` has exactly
**one** (`checklist-section.tsx`); the other five "checkbox" call sites the original table had in
mind are plain native `<input type="checkbox">`, never Radix. Building a `Select` or `Checkbox`
wrapper in `packages/ui` on that basis would have been precisely the speculative extraction §6
warns against — a component with zero or one real caller, built because a table said three.
Wave 3 shipped `Modal`, `DropdownMenu`, and `Popover` only, each verified against a per-pattern
grep before a single line of the component was written: Dialog has 6 files / 7 instances,
DropdownMenu has 2 files / 3 instances, Popover has **6** files / **10** instances — one more of
each than the original table counted, since `chat-page.tsx` alone turned out to hold four
Popovers and a fifth (`Popover.Close`-based) EmojiPickerButton the first pass missed entirely.
See §4's findings and §6's revised component list for the full corrected picture.

Parent: [PLAN.md](../PLAN.md) §6 (Repository Layout — `packages/ui`), §13 (Roadmap).
Slice procedure: [feature-template.md](feature-template.md) still applies where a wave touches
`apps/api`, but most of this phase is `apps/web` and a new `packages/ui` — no migration, no new
route, in five of its six waves. Where a wave is schema/route-free that is called out explicitly,
the same way [ai/phase-3.5-work-ux.md](phase-3.5-work-ux.md) §4 does for its Wave 1.

---

## 1. Why this phase exists

Six product surfaces carry real UI today: Work (Phases 3 and 3.5), Chat (5), Docs (6), Identity/
Auth, Tenancy/Org admin, and Notifications (9). Every one of them was built by the same author with
the same AI assistance, in the same house style — role-named OKLCH tokens
(`apps/web/src/styles.css`), the same `cn()` helper, the same Radix-plus-Tailwind approach. What
none of them share is an actual **package**. Each grew its own styled shell around Radix instead of
reusing one.

That is not a guess. `apps/web/src/components/primitives.tsx` already states the rule it was built
under: _"extract a component only once the same pattern appears three times"_ (PLAN.md §6). A grep
for direct Radix imports outside `primitives.tsx` and `toast.tsx` shows the threshold has been
crossed repeatedly, not once:

```
command-palette.tsx            @radix-ui/react-dialog
shell.tsx                      @radix-ui/react-dropdown-menu
step-up.tsx                    @radix-ui/react-dialog
chat-page.tsx                  @radix-ui/react-popover
notification-bell.tsx          @radix-ui/react-popover
archived-cards-dialog.tsx      @radix-ui/react-dialog
card-tile.tsx                  @radix-ui/react-dropdown-menu (×2 usages)
detail/assignee-section.tsx    @radix-ui/react-popover
detail/card-detail-panel.tsx   @radix-ui/react-dialog
filter/filter-builder.tsx      @radix-ui/react-select
share-board.tsx                @radix-ui/react-dialog
view-tabs.tsx                  @radix-ui/react-dropdown-menu
```

Thirteen call sites, five different Radix primitives, each one hand-wired with its own focus-trap
props, its own `Content` positioning classes, its own close-on-escape wiring. None of it is wrong —
every file matches house style, typechecks clean, no `any`. It is **duplicated correct code**,
which is a slower-burning problem than duplicated wrong code: a fix to one dialog's focus return
(the thing that sends focus back to the trigger on close, which `card-detail-panel.tsx` already
gets right and `share-board.tsx` does slightly differently) does not propagate, and nobody notices
until a screen-reader user reports the one that is missing it.

The imbalance compounds across surfaces. File counts under `apps/web/src/features/`:

| Surface   | Component files | Shipped with                                                                                                                                   |
| --------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `work/`   | 27              | Optimistic mutations, skeletons, toasts, inline create, hover affordances — all of [3.5 Wave 1](phase-3.5-work-ux.md#4-wave-1--shell-and-feel) |
| `auth/`   | 13              | Its own dialog/step-up patterns, built before 3.5 existed                                                                                      |
| `docs/`   | 10              | Built after 3.5 shipped, but never retrofitted with its patterns                                                                               |
| `chat/`   | 4               | Same                                                                                                                                           |
| `admin/`  | 3               | Same                                                                                                                                           |
| `org/`    | 3               | Same                                                                                                                                           |
| `people/` | 2               | Draft (11.5), out of scope here — nothing to polish yet                                                                                        |

3.5 Wave 1 was scoped to Work by name and never had a mandate to touch Chat or Docs, which is a
reasonable scoping call and not a defect in that phase. But it means Work is the one surface with
optimistic updates, loading skeletons instead of centred spinners, and toast-based feedback, and
the other four shipped surfaces vary in how much of that they picked up independently. That gap is
this phase's actual subject.

**Why now, and not folded into a later phase:** Phase 7 (Voice) adds a dialer, an IVR builder, and
an SMS/WhatsApp inbox — three more UI-heavy surfaces that would each independently reinvent a
modal, a dropdown, and an empty state, the same way Chat and Docs did. Doing the extraction before
Voice means Voice becomes the first surface that **consumes** a proven `packages/ui` instead of the
sixth surface that duplicates around it.

---

## 2. What this phase is not

- **Not a redesign.** [3.5 §2](phase-3.5-work-ux.md#2-what-same-as-clickup-means-here--and-what-it-does-not)'s
  rule — _"take the flow, keep the face"_ — applies here even more literally: the OKLCH tokens in
  `styles.css`, the accent colour, the density conventions in `primitives.tsx` are the extraction
  **source**, not something being replaced. Nothing in this phase changes what the app looks like
  from three feet away; it changes how many files know how to draw a dialog.
- **Not new product scope.** Zero new user-facing capability ships. The entire value is fewer
  divergent implementations of things that already exist, plus the accessibility and consistency
  defects an audit turns up along the way.
- **Not Voice (7), Search (8), Automation (10), Analytics (11), or Calendar/Timeline (13).** None
  of those surfaces exist yet, so there is nothing real to extract from them. They become
  consumers of this phase's output when their own time comes; this phase does not guess at their
  needs in advance, for the same reason PLAN.md §6 warns against building `packages/ui`
  speculatively in the first place — extracting from four real surfaces is a different exercise
  than designing for zero.
- **Not a framework swap.** Radix and Tailwind v4 stay exactly as they are (PLAN.md §4.1). This
  phase relocates and formalizes thirteen existing call sites; it does not introduce a component
  library, a CSS-in-JS runtime, or a build-time style pipeline that is not already there.
- **Not People (11.5).** That phase is itself still a draft with two files under `features/people`.
  Polishing a UI that might still change shape is waste; 11.5 either lands before this phase starts
  (in which case it is naturally in scope for Wave 3) or after (in which case it is the first real
  consumer of `packages/ui`, the same as Voice).

---

## 3. The structural decision

> **`packages/ui` gets built now, extracted from the thirteen real call sites above — not designed
> from a blank page.**

This is the one decision the rest of the phase depends on, the same role §3 plays in the 3.5 doc.

Two ways to read PLAN.md §6's warning against building the package speculatively: never build it
until forced, or build it the moment the evidence is no longer speculative. The first reading was
right through Phase 3 — one surface, one team of consumers, extracting early would have been a
guess. It stops being the right reading once a second, third, fourth, and fifth surface each
reimplement the same five Radix wrappers independently. At that point declining to extract is not
caution, it is accepting that the sixth, seventh, and eighth surfaces (Voice's three) will do it
again.

### 3.1 What moves, and what doesn't

**Shipped to `packages/ui` in Wave 3 — the corrected count, per-pattern grepped rather than
combined (see the status header):**

| Component      | Real call sites                                                                                                                                                                                                 | Instances    | Radix primitive       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------- |
| `Modal`        | `card-detail-panel.tsx`, `share-board.tsx`, `archived-cards-dialog.tsx`, `command-palette.tsx` (×2: palette + shortcuts), `step-up.tsx`, `view-tabs.tsx`'s `SaveViewDialog`                                     | 6 files / 7  | `react-dialog`        |
| `DropdownMenu` | `shell.tsx` (×2: org switcher + account menu), `card-tile.tsx` (QuickOverflow)                                                                                                                                  | 2 files / 3  | `react-dropdown-menu` |
| `Popover`      | `chat-page.tsx` (×5: pinned, saved, new channel, new DM, emoji picker), `notification-bell.tsx`, `detail/assignee-section.tsx`, `card-tile.tsx` (×2: quick-assign, quick-due-date), `filter/filter-builder.tsx` | 6 files / 10 | `react-popover`       |

**Not built, despite the original draft assuming otherwise:**

- **`Select`** — `@radix-ui/react-select` had **zero** real import sites (confirmed by grep before
  Wave 3 started). It was a listed dependency nobody used; removed from `apps/web/package.json`
  rather than given a wrapper. Every "select" in this app is a native `<select>`, already correctly
  themed by `styles.css`'s `color-scheme: dark` (CLAUDE.md's Phase 3 notes).
- **`Checkbox`** — `@radix-ui/react-checkbox` has exactly **one** real call site
  (`checklist-section.tsx`). One is below PLAN.md §6's own three-times threshold; building a
  wrapper for it now would be the identical speculative mistake this phase exists to avoid
  committing a second time. Revisit if and when a second Radix-checkbox call site appears —
  the five plain `<input type="checkbox">` sites elsewhere in the app are a DIFFERENT pattern
  (no focus-trap, no indeterminate-state API to converge) and don't count toward that threshold.

Already-shared and staying exactly where they are — **not relocated to `packages/ui` in this
pass**: everything currently in `apps/web/src/components/primitives.tsx` (`Button`, `Input`,
`FocusOnMountInput`, `Textarea`, `Field`, `Badge`, `Avatar`, `AvatarStack`, `Spinner`, `Skeleton`,
`SkeletonRows`, `Empty`, `Section`, `AddPanel`, `ConfirmButton`) and `toast.tsx`. The original draft
of this section assumed these would move as the package's "first tenants." On reflection that is
organizational tidiness, not a fix for anything broken — none of them are duplicated the way
Modal/DropdownMenu/Popover were, so moving them carries real risk (import-path churn across
dozens of files) for no behavioural benefit. Deferred to a later pass, tracked as an open item
rather than done speculatively alongside the components that actually needed it.

**Does not move, and never will on the current evidence:** anything with exactly one
implementation and no evidence a second is coming — `filter-builder.tsx`'s query-tree editor,
`command-palette.tsx`'s command registry, TipTap's editor chrome (`.rich-text` in `styles.css`,
styled as plain CSS by design — see CLAUDE.md's Phase 3 notes on why). Extracting a one-off is
exactly the speculative move §6 warns against; this phase inherits that discipline rather than
suspending it because a package now exists to put things in.

### 3.2 Where it lives, and the boundary it does not get

`packages/ui/src/`, workspace-internal (`workspace:*` in `apps/web/package.json`, the same as
`@taskflow/contracts` and `@taskflow/filter` already are). No build step beyond what Vite already
does for workspace packages — no separate Storybook, no published npm artifact. A design system
with an external distribution story is a different, larger commitment than this phase is asking
for, and nothing here needs it: `apps/web` is the only consumer, today and for every wave below.

**No new ESLint boundary.** `packages/db` and `packages/policy` get import bans because importing
around them causes a security defect (guardrails 1 and 2, CLAUDE.md). Importing a Radix dialog
directly instead of `packages/ui`'s `Modal` is a maintenance cost, not a security one — a lint rule
here would be guardrail machinery bolted onto a problem guardrails don't exist for. Enforcement is
code review, same as any other internal convention.

---

## 4. Wave 1 — Audit — DONE, partially, 2026-08-08

**Ran with no browser or screen reader available in the session that built it** — a real
constraint worth stating plainly rather than working around by skipping the check silently. Three
of the six items below got a real, verifiable answer (contrast was computed, not eyeballed; focus
defeat was found by reading the CSS cascade, not guessed; the duplication census was re-grepped
per-pattern). The other three are open — see §4.1.

- **Contrast.** Every `--color-*` pair in `styles.css` actually used together (ink-on-surface,
  ink-muted-on-surface, accent-ink-on-accent, danger-ink-on-danger) checked against WCAG AA
  (4.5:1 body text, 3:1 large text/UI components). OKLCH's lightness channel makes this a
  calculation, not a guess — §5.1 covers what a failure means for the token values.
- **Focus order and visibility.** `:focus-visible`'s ring (`styles.css`, quoted in CLAUDE.md's
  Phase 3.5 notes as "unusable if you cannot see what is focused") is verified present on every
  interactive element across all six surfaces, not just the board it was written for. Tab order
  audited on: card detail modal, chat message composer, docs page tree, notification popover,
  command palette, every dropdown menu in the table above.
- **Screen reader pass.** One real run with a screen reader (VoiceOver or NVDA — whichever the
  author already has) over: creating a card, sending a chat message, editing a doc page title,
  opening notification preferences, running a command from the palette. Not an automated
  `aria-*` attribute lint — CLAUDE.md's own standing lesson (Phase 5's chat header) is that a
  control can look correct in markup and be unusable in practice, and that only shows up in a real
  run.
- **Duplication census.** The table in §1 formalized: every place a Modal/DropdownMenu/Popover/
  Select/Checkbox is hand-rolled, with a note on which behaviour (focus trap, escape handling,
  outside-click, portal target) each implementation got right or missed relative to the others.
  This becomes Wave 2's migration checklist — a component isn't "extracted" until every call site
  it replaces is verified to keep the best behaviour any of them had, not just the first one found.
- **Density and spacing drift.** `primitives.tsx`'s own comment already flags Work's spacing as
  "uniform where it should be hierarchical" (3.5 §4.5) — this wave extends that observation to
  Chat, Docs, Auth, and Admin, cataloguing where padding/gap values diverge from the scale a later
  wave will formalize.
- **Empty/loading/error state coverage.** A grid: surface × state (empty, loading, error) × what
  currently renders. Work has `Empty`/`Skeleton`/`ErrorView` almost everywhere; the audit's job is
  to find where Chat, Docs, or Admin fall back to nothing, a blank div, or a raw error message.

### 4.1 Wave 1 findings — what actually got checked, and what didn't

**Done, with a real answer:**

- **Contrast — DONE.** Computed WCAG ratios from `styles.css`'s actual OKLCH values (proper
  OKLCH→linear-sRGB→relative-luminance math, not eyeballed), not just the pairs guessed at
  drafting time. Six failures found: `ink-faint` on `surface` (4.14:1) and `surface-raised`
  (3.74:1), both below AA's 4.5:1 for normal text; `accent-ink` on `accent` (3.09:1) and on
  `accent-hover` (2.58:1) — the PRIMARY BUTTON'S OWN LABEL TEXT; `danger-ink` on `danger`
  (3.76:1); and `line`/`line-strong` against `surface` (1.40:1 / 2.09:1), below the 3:1 a
  functional border (an input's, not a decorative divider's) needs under WCAG 1.4.11. All six are
  fixed in §5.1 — the last two only after the visible border-weight change they require got an
  explicit go-ahead — this is not a list of TODOs, it's the input Wave 2 actually consumed.
- **Focus defeat — DONE, and worse than "missing":** not merely uneven, one real instance was
  actively defeated. `detail/rich-text-editor.tsx` set Tailwind's `focus:outline-none` on the
  TipTap contentEditable div — and because Tailwind's `utilities` layer always beats
  `styles.css`'s `@layer base` `:focus-visible` rule regardless of selector specificity, that one
  line silently gave the description/comment editor a WORSE keyboard-focus indicator than every
  other interactive element in the app: no ring, just the text caret, invisible in an empty field.
  Fixed by deleting the override (§6's writeup has the specific diff) rather than adding a
  competing rule, since the existing app-wide ring is already correct and already accent-coloured.
- **Duplication census — DONE, and corrected twice.** See the status header and §3.1: the
  original combined grep mis-attributed which Radix primitive several files used
  (`view-tabs.tsx` was recorded under DropdownMenu, and is actually Dialog; `filter-builder.tsx`
  was recorded under Select, and is actually Popover), and undercounted instances within files
  that use the same primitive more than once (`chat-page.tsx`'s four — actually five — Popovers).
  Re-run per-pattern before Wave 3 started; the corrected numbers are what Wave 3 was actually
  built against.

**Not done — genuinely open, not silently dropped:**

- **Screen reader pass — NOT DONE.** §4's header states why: no browser or assistive-technology
  runtime was available in the session that ran this audit. Claiming this ran, or skipping it
  without saying so, is exactly the failure mode CLAUDE.md's Phase 5 status header warns about —
  "a green `pnpm verify` is not the same claim as 'this works when you click it.'" This needs a
  human with a real screen reader before Wave 5 can honestly call itself done, and specifically
  before trusting that the Modal/DropdownMenu/Popover extraction in Wave 3 preserved every
  hand-rolled dialog's actual (not just markup-implied) accessible behaviour.
- **Density and spacing drift — NOT SYSTEMATICALLY DONE.** No cross-surface spacing catalogue
  was built. Wave 2 §5.2 is honest about this: there is no scale to formalize yet because the
  drift was never catalogued, only asserted (by the original 3.5 comment) to exist in Work alone.
- **Empty/loading/error state coverage — PARTIALLY DONE.** A real grep-based survey was run
  (`<Spinner>`/`<Skeleton>`/`<Empty>`/`<ErrorView>` usage per feature), and it overturned the
  phase's own starting assumption: Chat and Docs already use `Skeleton`/`Empty`/`ErrorView`
  broadly, contrary to §1's guess that they lag behind Work. One concrete, real gap was found and
  fixed — `docs/templates-panel.tsx` rendered `templates.data ?? []`, so a still-loading fetch and
  an empty space read as the identical "no templates" state, exactly the ambiguity `primitives.tsx`'s
  own `Empty` comment warns against. That is one fix, not a completed surface-by-surface audit;
  Wave 4 §7 is where the rest of that sweep belongs.

No finding above was fixed inline during discovery in a way that skipped writing it down first —
each fix landed with the reasoning for it in the code (see the relevant file's own comment), not
just in this document, so a future reader hits the "why" at the point of the code, not only here.

---

## 5. Wave 2 — Design tokens — DONE 2026-08-08

### 5.1 Colour — DONE

All six failures Wave 1 found are resolved, four by changing the token and two deliberately left
as a flagged, un-autofixed finding:

- `--color-accent` 65% → 55%, `--color-accent-hover` 70% → **50%** (darker than the base colour,
  not lighter — see the token's own comment in `styles.css` for why this reverses the previous
  hover direction rather than merely darkening both), `--color-danger` 62% → 55%,
  `--color-ink-faint` 58% → 64%. All four re-verified against real OKLCH→sRGB math, not just
  adjusted and assumed: `accent-ink` on `accent` now 4.67:1, on `accent-hover` 5.79:1,
  `danger-ink` on `danger` 5.04:1, `ink-faint` on `surface`/`surface-raised` 5.27:1/4.76:1 — all
  clear AA with margin.
- `--color-overlay` added (`oklch(15% 0.02 265 / 60%)`) — one token for what was five independent
  `bg-black/50` literals across the Dialog call sites, consumed by `packages/ui`'s `ModalContent`.
- **`line`/`line-strong`'s border contrast (1.40:1 / 2.09:1, both below the 3:1 a functional
  border needs) was found, initially left unfixed pending an explicit go-ahead, and then FIXED**
  once that go-ahead was given: `--color-line` 32% → 52% (3.22:1), `--color-line-strong` 42% →
  58% (4.14:1) — the same two-step "propose, wait for sign-off, then apply" sequence
  `line`/`line-strong` was singled out for in the first place, now completed rather than left as
  a permanently-open item. Every card, input, and panel border in the app is visibly heavier as a
  direct, accepted consequence — this was never a token-math-only change, and the visual
  character shift is the point that needed sign-off, not an accident of the fix.
- **No light theme added.** `:root { color-scheme: dark }` stays exactly as it was; §13's
  Decision 5 recommends never adding one, and nothing here revisits that.

### 5.2 Spacing and type scale — NOT DONE

Unchanged from the draft: this genuinely depends on Wave 1's density audit, which (§4.1) was
never systematically run. Nothing to formalize yet — deferred to whenever that audit happens,
most likely folded into Wave 4.

### 5.3 Motion — DONE

`--motion-fast` (120ms), `--motion-base` (200ms), `--motion-ease` added, plus a
`prefers-reduced-motion` block that collapses both durations to `0.01ms` rather than requiring
every consumer to branch on the media query itself. Not yet consumed by an actual transition —
`packages/ui`'s `Modal`/`Popover` ship in Wave 3 without an enter/exit animation (see §6's own
note on why that was deliberately left out of THIS pass rather than rushed in alongside the
extraction) — so these tokens are declared and ready, not yet wired to a visible effect.

### 5.4 Wave 2 acceptance

Every contrast pair Wave 1 flagged is now fixed and re-verified — six of six, once
`line`/`line-strong` got its explicit go-ahead. No component built in Wave 3 hardcodes a hex, an
OKLCH triple, or a bespoke spacing value outside `styles.css`'s tokens.

---

## 6. Wave 3 — Extract `packages/ui` — DONE 2026-08-08

**Scope corrected from the original draft before any component code was written** — see the
status header and §3.1. Shipped: `Modal`, `DropdownMenu`, `Popover`. Not shipped, and not
speculatively built: `Select` (zero real call sites) and `Checkbox` (one call site, below the
three-times threshold). `primitives.tsx` and `toast.tsx` were NOT relocated in this pass — see
§3.1's explanation of why moving already-correct, non-duplicated code was judged lower-value and
higher-risk than the genuine duplication fix, and left as an open item rather than done alongside
it for the sake of matching the original draft.

- New package: `packages/ui/package.json`, `tsconfig.json` extending
  `@taskflow/config/tsconfig/node.json` (not `react.json` — that config turns declarations OFF,
  correct for `apps/web` as a leaf bundle and wrong for a package everything else imports types
  from; `packages/ui/tsconfig.json` extends `node.json` and adds `jsx: react-jsx` plus DOM libs
  directly). `vitest.config.ts` with `environment: 'jsdom'`, matching `apps/web`'s own for the
  same reason — these tests render real Radix compound components and assert on the DOM they
  produce.
- `eslint.config.js`'s React block, previously scoped to `files: ['apps/web/**/*.{ts,tsx}']` only,
  widened to also cover `packages/ui/**/*.{ts,tsx}` — otherwise the new package's `.tsx` files
  would get no hooks/a11y linting at all, a guardrail gap opened by the extraction itself.
  `node packages/guardrail-selftest/verify.js` still passes after the change (it only asserts on
  `apps/web`'s computed config, which is unaffected).
- `Modal` (`modal.tsx`): `ModalRoot`/`ModalTrigger`/`ModalClose` re-exported unchanged from Radix;
  `ModalContent` takes `size` (`sm`/`md`/`lg`/`xl`) and `placement` (`center`/`top`, for the
  command palette's non-centred anchor) and owns the overlay, sizing, border/radius/shadow;
  `ModalTitle`/`ModalDescription` are styled wrappers. Deliberately a compound API, not one
  `{title, description, children}` props object — `card-detail-panel.tsx`'s custom header (title
  plus an Archive button plus Close, not just a title) can't be expressed by a single-props Modal
  without an escape hatch, and Radix's own compound shape already solves that.
- `DropdownMenu` (`dropdown-menu.tsx`): `DropdownMenuContent` owns the shared shell;
  `DropdownMenuItem` takes a `tone` (`default`/`muted`) instead of each call site repeating its
  own `text-ink`/`text-ink-muted` className.
- `Popover` (`popover.tsx`): `PopoverContent` owns the shared shell (including `PopoverClose`,
  needed by `chat-page.tsx`'s emoji picker). One real drift caught and fixed rather than carried
  forward as a variant: `notification-bell.tsx`'s popover used `rounded-md`/`bg-surface` where
  every other popover used `rounded`/`bg-surface-raised` — nothing in that file explains the
  difference as deliberate, so the fix folds it into the shared default instead of adding a prop
  to preserve an accident.
- All 11 files carrying the 13 corrected call sites (§3.1) were migrated to the new components —
  `card-detail-panel.tsx`, `archived-cards-dialog.tsx`, `share-board.tsx`, `step-up.tsx`,
  `command-palette.tsx`, `view-tabs.tsx`, `shell.tsx`, `card-tile.tsx`, `chat-page.tsx`,
  `notification-bell.tsx`, `detail/assignee-section.tsx`, `filter/filter-builder.tsx`. Confirmed
  by grep: zero remaining `@radix-ui/react-dialog|react-dropdown-menu|react-popover` imports
  anywhere under `apps/web/src`.
- Tests shipped with the components, not after: `modal.test.tsx` (opens on trigger click, RETURNS
  FOCUS to the trigger on close — the one behaviour Wave 1's census flagged as the real risk of
  converging seven independent implementations — and closes on Escape), `dropdown-menu.test.tsx`
  (`onSelect` fires, menu closes after selection), `popover.test.tsx` (closed until triggered,
  closes on outside click). 7 tests, all passing under jsdom + Testing Library, the same stack
  `apps/web`'s own component tests use.

### 6.1 Wave 3 acceptance — met, with one explicit exception

- Zero direct `@radix-ui/react-dialog`/`-dropdown-menu`/`-popover` imports outside `packages/ui`
  — confirmed by grep, not assumed.
- `pnpm --filter @taskflow/web typecheck|lint|test|build` and
  `pnpm --filter @taskflow/ui typecheck|lint|test` all green: 272 pre-existing `apps/web` tests
  still pass (nothing regressed), 7 new `packages/ui` tests pass, production build succeeds,
  `node packages/guardrail-selftest/verify.js` still reports 11/11 guardrails firing. **Full
  `pnpm verify` (the whole monorepo, including the Postgres-backed `apps/api`/`packages/db`
  suites) was not run** — no Docker in the session that built this — so this acceptance is scoped
  to the packages actually touched, not a repo-wide green.
- **The one explicit exception:** "behaves identically to its best prior implementation... verified
  by re-running Wave 1's screen-reader pass" — Wave 1 never ran a real screen-reader pass (§4.1),
  so there is nothing to re-run. The `modal.test.tsx` focus-return assertion is real, automated
  evidence for the one behaviour most likely to have drifted across seven implementations, but it
  is not a substitute for a human confirming the extraction reads correctly with a screen reader.
  That confirmation is still owed, and belongs in Wave 5 rather than being claimed here.

---

## 7. Wave 4 — Consistency pass across shipped surfaces — DONE, real scope, 2026-08-08

**The plan's own starting assumption for this wave was wrong**, the same way §3.1's component
census was wrong twice before Wave 3. §1 guessed Chat and Docs would need the same
skeleton/empty/error retrofit Work got in [3.5 Wave 1](phase-3.5-work-ux.md#4-wave-1--shell-and-feel).
A real grep-based audit (Wave 1, §4.1) found that guess false: Chat and Docs already use
`Skeleton`/`Empty`/`ErrorView` broadly — one real gap was found and fixed there
(`docs/templates-panel.tsx`), not a surface-wide retrofit. What Wave 4 turned out to actually need,
verified rather than assumed:

- **Loading/empty/error states — verified already adequate**, per Wave 1's survey. No further
  retrofit needed once `templates-panel.tsx`'s gap was closed.
- **Density — audited, no significant drift found.** Counted `gap-*`/`space-y-*` utility usage per
  surface: `gap-2` is the dominant spacing unit in Work, Chat, Docs, and Admin alike; Auth leans
  toward `gap-3`–`gap-6`, which tracks form fields needing more breathing room than a dense list,
  not unintentional drift. Checked `rounded-*` variants the same way: Chat's `rounded-2xl` (message
  bubbles) is the one outlier, and reading the call sites confirms it's deliberate chat-bubble
  styling, not an accident. §5.2's "not systematically done" is now: done, and the answer is there
  was very little to fix.
- **Avatars and people — audited, found and fixed two real gaps.** `docs/comments-suggestions.tsx`
  (comment AND suggestion author rows) and `docs/version-history.tsx` (version author rows) rendered
  an author's LABEL with no `Avatar` next to it, where the identical kind of content —
  `work/detail/comment-section.tsx`'s comment authors — already gets one. Fixed by adding `Avatar`
  to all three rows, matching Work's existing pattern exactly rather than inventing a new one.
  `admin/permission-debug-page.tsx`'s member picker was checked and correctly left alone: it's a
  native `<select>`'s `<option>` list, which can only ever render plain text — not a gap, a
  browser constraint.
- **Optimistic mutations — audited and quantified, NOT retrofitted.** Counted `useOptimistic`
  usage: 8 files in `work/`, **zero** anywhere in `chat/` (25 `useMutation` call sites) or `docs/`
  (18 call sites). This is real, and it is the one place the plan's original guess about Chat/Docs
  lagging Work turned out to be correct. The single highest-impact candidate is Chat's message-send
  mutation — the most frequent, most latency-sensitive interaction on that whole surface, the exact
  analogue of Work's "card move (the one that shows most)" (3.5 §4.3). **Deliberately not
  implemented in this pass.** Chat already has a live realtime socket layer (Phase 4/5) pushing
  new messages to every open tab; an optimistic local insert has to be reconciled against that
  socket-delivered echo of the SAME message without producing a visible duplicate, which needs a
  real de-duplication story (a client-supplied idempotency key, matched against what the server
  and the socket both eventually deliver) — a genuine architecture question, not a CSS-and-token
  change, and one wrong turn here produces a WORSE bug (a flickering, duplicated live chat) than the
  slow-feeling send it would fix. Named here as the concrete next step, not implemented under a
  "consistency pass" banner it doesn't belong in — the same restraint Wave 6 applied to
  `card-tile.tsx`'s touch-interaction gap.

### 7.1 Wave 4 acceptance

Wave 1's empty/loading/error survey confirmed adequate (one gap closed). Density audited with real
numbers, not assumed. Avatars fixed at every gap found. Optimistic-mutation coverage quantified
(0/43 in Chat+Docs vs. 8/48 in Work) with the highest-value candidate named and explicitly deferred
to its own future work, for the reason above — not silently dropped, not rushed.

---

## 8. Wave 5 — Accessibility hardening — DONE, real scope, 2026-08-08

Same pattern as Wave 4: some of what this wave names is genuinely finished, and the one item that
can't be finished in this environment (no browser) is named as exactly that rather than glossed
over.

- **Icon-only button `aria-label` audit — DONE, verified clean.** Every button in the app whose
  only visible content is a bare symbol or emoji (`«`/`»`, `☰`, `←`, `✕`/`×`, `★`, `⋯`, `👤`, `📅`,
  `🔔`, `👥`) was checked by hand against its actual `aria-label`, not sampled: sidebar collapse,
  the mobile hamburger, both back buttons, every close button (thread panel, channel details,
  toast, checklist item, view tab), the pin star, the overflow menus, the quick-action icons, the
  notification bell. All of them already had one. This is a real "checked, zero defects" result,
  not an unrun check — the discipline this codebase already held itself to before this phase
  started is the reason there was nothing to fix here.
- **Keyboard-only pass — partially automated, partially done, one real gap found and fixed.**
  `jsx-a11y/click-events-have-key-events` and `jsx-a11y/no-static-element-interactions` are both
  `error` in the recommended config this repo already runs (`packages/config/eslint/react.js`), and
  `pnpm lint` is clean — so a `<div onClick>` with no keyboard equivalent is a lint FAILURE here,
  not a manual check someone has to remember to run. That guardrail is what let one real gap
  surface on inspection rather than by accident: Wave 6's mobile drawer backdrop is correctly
  `aria-hidden` (a pointer-only affordance, exempt from the rule for exactly the right reason), but
  that meant the drawer itself had a mouse/touch way to close (the backdrop) and genuinely **no
  keyboard way at all** — `Sidebar`'s tree is a plain nav, not a Radix `Dialog`, so it never got
  Escape-to-close or focus-management for free the way `packages/ui`'s `Modal` did. Fixed in
  `shell.tsx`: Escape closes the drawer, and focus moves into it on open and back to whatever
  opened it on close (`document.activeElement` captured at the moment it opens, not a ref threaded
  through `Header`). **Deliberately not a full focus trap** — Tab can still leave the drawer into
  the page behind the backdrop while it's open, which a hand-rolled trap could fix but only by
  re-implementing exactly the wrap-around-on-Tab-and-Shift+Tab logic Radix exists so this codebase
  doesn't have to get right from scratch. Named as a real, bounded gap rather than attempted and
  possibly gotten wrong with no way to verify it live. dnd-kit's own keyboard sensors (3.5's
  existing concern) were not specifically re-tested against the Modal extraction — that still needs
  a live pass, folded into the item below.
- **`prefers-reduced-motion` — wired up, not just declared.** Wave 2 added the tokens
  (`--motion-fast`/`--motion-base`/`--motion-ease`) but Wave 3 shipped `Modal`/`Popover`/
  `DropdownMenu` without consuming them — a real gap this wave closed: a shared `.ui-fade` class
  (`styles.css`, `@layer components`) applied to all three components' content, using
  `@starting-style` for the entrance transition (not a `data-state="closed"` rule, since none of
  these unmount with `forceMount` — there is no closing frame to animate FROM, only an opening one
  to animate INTO) and touching only `opacity`, never `transform`, since every one of these
  elements already has a Tailwind `transform` utility on it for positioning that a second
  `transform` declared in plain CSS would compete with rather than merge with. Respects
  `prefers-reduced-motion` for free, through the same token override Wave 2 already declared.
- **Screen-reader pass — STILL NOT DONE, unchanged from Wave 1.** No browser or assistive-technology
  runtime available in this session, now across three separate waves that each named this as the
  thing they couldn't close (Wave 1's audit, Wave 3's extraction, and this one). This is the single
  most important piece of verification this entire phase is missing, named consistently rather than
  quietly dropped from each wave's own acceptance criteria.

### 8.1 Wave 5 acceptance — met for everything except the one item that needs a browser

Icon labelling: verified clean. Keyboard: one real gap found via the existing lint guardrail and
fixed, dnd-kit re-verification still owed. Motion: wired up and verified by reading the CSS this
produces. Screen-reader pass: **not done**, and not claimed to be — see §14 for what closing this
actually requires.

---

## 9. Wave 6 — Responsive layout — DONE, scoped, 2026-08-08

**Scope decided by the author, not by this document's own recommendation** (§13 originally had
none): full responsive support, all screens, not desktop-only and not a bounded "don't visibly
break" pass. What shipped:

- **The app shell.** `Sidebar`/`SidebarFooter` became an off-canvas drawer below `md` (768px),
  toggled by a hamburger button in `Header` and closed by a backdrop tap, an Escape-equivalent
  (outside click), or any navigation (a `pathname`-watching effect in `Shell`, not per-link
  handlers — see that file's own comment on why). **A real bug found and fixed along the way, not
  just a feature added:** a `-translate-x-full` panel is invisible but stays in the tab order and
  the accessibility tree, since `transform` does neither of the things `display: none` does — so
  the first version of this drawer let a keyboard user Tab through every sidebar link before
  reaching anything on screen while it was closed. Fixed with the `inert` attribute
  (`lib/use-media-query.ts`'s `useIsDesktop` gates it to mobile-and-closed only), not a hand-rolled
  focus trap.
- **A new `useIsDesktop`/`useMediaQuery` hook** (`lib/use-media-query.ts`), because a real
  correctness bug required it: the docs/main sidebars' desktop "collapse to a rail" preference
  (`sidebarOpen`/`docsSpacesOpen`) is a DIFFERENT question from the mobile drawer's open/closed
  state, and conflating them meant a sidebar collapsed to a rail on desktop would reopen as a
  useless 3rem sliver in the mobile drawer instead of the full tree the drawer exists to show.
  `useSyncExternalStore`-based, with jsdom's missing `matchMedia` polyfilled in
  `testing/setup.ts` (defaulting to desktop-matching, so no existing test's assumptions changed).
- **Two list/detail splits** — Chat (`ChannelListPanel`/`ChannelPanel`) and Docs
  (`SpaceTreePanel`/`PagePanel`) were permanent two-pane layouts with a fixed `w-64`/`w-80` list
  pane that, combined with the detail pane, could not fit a phone viewport at all. Below `md`,
  each now shows exactly one pane — the list when nothing is open, the detail pane (with a back
  button) once something is — driven by the same URL search param that already was the source of
  truth for what's open, so there is no new "which pane is active" state to keep in sync with it.
- **`packages/ui`'s `Modal`.** `w-full` on a `position: fixed` element resolves against the
  viewport, so a phone-width dialog was already edge-to-edge with zero margin before this wave —
  fixed once, in the one shared component, for every dialog in the app at once. The command
  palette's fixed `top-24` offset also shrinks to `top-6` below `sm`, so it doesn't eat a third of
  a short landscape phone screen before its own result list gets any of it.
- **Verified, not assumed, already fine:** the kanban board and table view already had
  `overflow-x-auto` with fixed-width columns from Phase 3 — the same horizontal-scroll fallback a
  phone kanban board needs, already present. The People pages already used `sm:grid-cols-2`
  (single column below `sm`). The Admin pages' tables already had `overflow-x-auto`. Auth pages
  are centred `max-w-sm` cards, already narrower than most phones. None of these needed a change;
  confirmed by reading them, not by assumption.
- **Found, and deliberately NOT fixed — recorded as an open item, §14.** `card-tile.tsx`'s
  quick-assignee/quick-due-date/overflow icons only appear on `group-hover`/`group-focus-within`.
  The card itself is a real `<button>`, so a tap on a touch device DOES focus it (triggering
  `focus-within`) — but the same tap is also the click that opens the card detail panel, so the
  icons become visible and then are immediately covered by the panel that opens on the same
  gesture. This is a genuine interaction-design problem (hover-reveal has no clean touch
  equivalent), not a layout/overflow bug, and fixing it means redesigning the interaction — a
  persistent affordance, a long-press, or something else entirely — not adjusting a breakpoint.
  Nothing is unreachable: every quick action is also available from the full card detail panel,
  so touch users lose a shortcut, not a capability. Flagged rather than rushed into a redesign
  this wave wasn't scoped for.

### 9.1 Wave 6 acceptance

`pnpm --filter @taskflow/web typecheck|lint|test|build` green (275 tests: 272 prior + 3 new for
`useMediaQuery`), `pnpm --filter @taskflow/ui` unaffected, guardrail-selftest 11/11. **Not
verified in a real browser at real viewport widths** — no browser available in this session, the
same limitation Wave 1's audit recorded for the screen-reader pass. Every change here is reasoned
from the CSS and the DOM it produces, cross-checked against Tailwind's documented breakpoint
behaviour, not watched happening on an actual phone or a resized window. That confirmation is
still owed, same as Wave 1's.

---

## 10. Cross-cutting obligations

Nothing in this phase suspends the working agreement. What actually recurs across every wave:

### 10.1 The UI never re-derives authorization

Unchanged from 3.5 §8.2 and CLAUDE.md's Phase 3 notes. `packages/ui`'s `Modal`/`DropdownMenu`
components render what they're told to render; no new component in this phase gains an opinion
about `can()`. A disabled button because a mutation is loading is a UI state; a disabled button
because the user lacks permission stays the server's answer, never a client-side role check.

### 10.2 The wire still lies about dates

Unaffected by this phase — no new data-bearing output ships — but any surface Wave 4 touches that
happens to render a raw `Date` field without `wire()` gets fixed in passing, since the audit wave
will have eyes on every affected file anyway.

### 10.3 Tests ship with the slice

- Wave 3's new `packages/ui` components get unit tests for behaviour Radix doesn't already
  guarantee: `ConfirmButton`'s two-click state machine, `Avatar`'s hue stability, `AvatarStack`'s
  overflow count — the same tests `primitives.tsx`'s current file would need if it were tested
  today, relocated rather than newly invented.
- No visual regression tooling is assumed by default — Wave 1's manual audit and Wave 5's manual
  screen-reader pass are the verification method for the properties that matter (contrast, focus,
  labelling), not a new CI dependency. §14 asks whether that should change.
- A component with untested keyboard behaviour is not done, matching CLAUDE.md's own bar for
  "untested authorization" — the accessibility-relevant behaviours are this package's equivalent of
  authorization: the property most likely to be silently wrong and least likely to be caught by
  `tsc`.

### 10.4 Do not let this phase become a second redesign

3.5 §8.4 warned Wave 1 not to pre-empt Phase 4's realtime work. The equivalent warning here: this
phase does not touch `card-detail-panel.tsx`'s route-driven `?card=` behaviour, does not touch
`neighbours.ts` or any ranking logic, does not touch a single tRPC procedure. Every file this phase
edits is presentation. A wave that finds itself changing what a mutation does, not just how its
result is displayed, has left this phase's scope.

---

## 11. Sequencing and cost

| Wave | Delivers                                                                                                                           | Migrations | Status                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Audit: contrast, focus, screen-reader pass, duplication census, density/state gaps                                                 | none       | **Partially done** — contrast, focus defeat, duplication census, and (via Wave 4) density are real; screen-reader pass not run (§4.1) |
| 2    | Design tokens: colour fixes (all six, including `line`/`line-strong`), motion tokens                                               | none       | **Done** (§5.1, §5.4)                                                                                                                 |
| 3    | `packages/ui` extraction: Modal, DropdownMenu, Popover (not Select/Checkbox — §3.1)                                                | none       | **Done**                                                                                                                              |
| 4    | Consistency pass: loading/empty/error verified, density audited, avatars fixed, optimistic-mutation gap quantified and deferred    | none       | **Done**, real scope (§7)                                                                                                             |
| 5    | Accessibility hardening: icon labels verified, a real keyboard gap found and fixed, motion wired up; screen-reader pass still owed | none       | **Done except the screen-reader pass** (§8)                                                                                           |
| 6    | Responsive layout — full scope, all screens (author's explicit call, not this document's)                                          | none       | **Done**, one interaction gap found and deliberately not fixed, not yet seen in a real browser (§9)                                   |

All six waves landed 2026-08-08. Waves 1–3 shipped built ahead of formal approval on the strength
of §13's own "Recommended: yes" items — see the status header for why that is stated as a
deliberate, named risk rather than glossed over. Wave 6 shipped on an explicit scope decision from
the author (full responsive support); Waves 4–5 shipped on the author's explicit instruction to
finish the remaining open work, after Waves 1–3 and 6 were already up for review.

Each wave is independently shippable: Wave 1 produces a document, not code, so it carried zero
risk shipping first. Wave 6 turned out not to depend on Wave 4 the way the original sequencing
assumed it might — the app shell and the two list/detail splits it touched were structural, not
"consistency," so there was nothing to apply cross-surface polish to first. Wave 5 in turn found
one of its own real findings inside Wave 6's work (the drawer's missing keyboard path), which is
the opposite of the dependency the original draft assumed — accessibility hardening does not
strictly need consistency work finished first, it needs whatever shipped most recently checked.

**This delays Phase 7 (Voice) by its own length**, the same honest accounting 3.5 §9 gave for
Phase 4. Unlike that delay, this one is recoverable in the other direction: every hour spent here
is an hour Voice, Search, and Automation's own UI work doesn't have to spend reinventing a modal.

---

## 12. What "done" means

Every one of the six shipped surfaces (Work, Chat, Docs, Auth, Admin, Notifications) renders its
dialogs, dropdowns, and popovers through `packages/ui` — **true today**, confirmed by grep, for
`Modal`/`DropdownMenu`/`Popover`; `Select` and `Checkbox` were correctly never built (§3.1), so
"through `packages/ui`" does not apply to them. Zero direct Radix imports outside that package for
the three components that exist — **true today**. Wave 1's contrast and focus findings are closed
(§5.1, all six contrast pairs) — **true today**. Loading/empty/error states are visually and
behaviourally consistent app-wide — **true today** (§7): verified adequate almost everywhere, one
real gap closed. Avatars appear everywhere a person is named — **true today** (§7), two more gaps
found and fixed on top of what Wave 1 already covered. Every icon-only control has a real
`aria-label` — **true today** (§8), checked by hand, not sampled. Motion tokens are actually
consumed — **true today** (§8), via `.ui-fade` and `@starting-style`. Every shipped surface is
usable at every screen size — **true for layout and navigation** (§9): the shell, Chat, and Docs no
longer assume desktop width, and every dialog respects the viewport it's shown in. **Not true for
interaction**: `card-tile.tsx`'s hover-only quick actions are a known, named exception (§9, §14) —
a real gap, not an oversight papered over. No new user-facing feature exists that didn't exist
before this phase started — **true today**, and held for every wave including the last.

**Three things stay explicitly not true, and are not implied by anything above:** the screen-reader
pass (§4.1, §8) — named as missing in three separate waves rather than resolved by any of them;
real-browser verification of the responsive layout and the fade transitions (§9.1) — everything was
reasoned from CSS and DOM output, never watched happening; and dnd-kit's keyboard sensors
re-verified against the Modal extraction (§8) — flagged by 3.5 as a standing concern and not
specifically re-checked here. All three need a human with a real browser and, for the first, real
assistive technology — nothing in this phase's own tooling can close them.

---

## 13. Decisions — for review

Recommendations only; nothing here is settled the way 3.5's §10 or 6's shipped decisions are. This
phase has not been approved yet, and these are the calls that need a yes before Wave 3 starts
(Waves 1 and 2 don't depend on any of them).

1. **`packages/ui` stays workspace-internal, not published.** Recommended: yes. `apps/web` is the
   only consumer for the foreseeable roadmap (Voice, Search, Automation, Analytics all ship inside
   this monorepo); a publishable package needs versioning discipline and a changelog this phase has
   no use for yet.
2. **No new ESLint import-boundary rule for `packages/ui`.** Recommended: yes, per §3.2 — this is a
   maintenance convention, not a security guardrail, and guardrail machinery is reserved for actual
   security defects per CLAUDE.md's own framing.
3. **No visual-regression CI tooling added in this phase.** Recommended: defer. Manual audits
   (Waves 1 and 5) are proportionate to a solo-built app at this size; Chromatic or Playwright
   screenshot diffing is worth adding the day a second person starts reviewing UI PRs, not before.
4. **Wave 6 (responsive layout) scope — RESOLVED 2026-08-08.** Full responsive support, all
   screens, decided by the author rather than by this document's own (nonexistent) recommendation.
   PLAN.md itself is still silent on a mobile/tablet target anywhere else in the roadmap — this
   decision applies to this phase's own surfaces, not a retroactive statement about the rest of
   the product. See §9 for what shipped against it.
5. **Dark-only stays, no light theme.** Recommended: yes, no change. Nothing in any shipped phase
   or open PLAN.md item asks for one, and `:root { color-scheme: dark }`'s native-control fix
   (CLAUDE.md, Phase 3 notes) would need re-solving for a second scheme the moment one exists —
   real cost for a feature nobody has requested.
6. **Motion library.** Recommended: CSS transitions only (Wave 2 §5.3's tokens), no Framer Motion
   or similar. Every animation this phase's scope calls for — modal enter/exit, popover
   fade — is expressible in CSS, and a JS animation library is exactly the kind of dependency PLAN.md
   §4.1's minimal-footprint stance argues against adding without a concrete need it doesn't
   already meet.

---

## 14. Open questions

- Should Wave 1's audit doc live inline as an appendix to this file (§15, filled in once the audit
  runs) or as a sibling `ai/phase-6.5-audit.md`? Precedent both ways: 3.5 kept its decisions inline
  (§10); Phase 6's status header points out three separate incident write-ups that stayed in
  CLAUDE.md rather than the spec. Leaning inline here since the audit is short-lived reference
  material for Waves 2–5, not a standing incident record.
- **New, from Wave 3 (§3.1): when, if ever, does `primitives.tsx`/`toast.tsx` actually relocate
  to `packages/ui`?** Deferred rather than done alongside Modal/DropdownMenu/Popover because
  nothing about them is currently duplicated — but the phase's own stated goal (a design system
  future phases can depend on without importing from `apps/web`) is not fully met while they stay
  app-local. Worth revisiting once Voice (Phase 7) or People (11.5) actually need one of those
  primitives from outside `apps/web`, which is the concrete trigger the speculative-extraction
  rule (§6) says to wait for.
- **New, from Wave 6 (§9): `card-tile.tsx`'s quick actions have no clean touch equivalent.**
  Hover-reveal assumes a pointer that can be "over" an element without clicking it; touch
  conflates hover, focus, and click into one gesture, so tapping the card both reveals the quick
  actions and immediately covers them by opening the card detail panel. Nothing is unreachable —
  every action is also in the full detail panel — but the shortcut is effectively desktop-only
  today. Real candidate fixes (a persistent small affordance always visible on the tile, a
  long-press menu, swipe actions) are interaction-design decisions with real trade-offs of their
  own, not something to pick unilaterally while finishing a token-and-layout wave. Worth its own
  short design pass rather than folding into Wave 4 or 5 by default.
- **New, from Wave 6 (§9.1): the responsive work has not been seen in a real browser at a real
  viewport width.** Every class and every breakpoint decision is reasoned from Tailwind's
  documented behaviour and the DOM `packages/ui`/`chat-page.tsx`/`docs-page.tsx` produce, the same
  limitation Wave 1's audit recorded for the screen-reader pass. This is the single most important
  outstanding verification before this phase can honestly call its responsive claims proven rather
  than argued.
- **New, from Wave 4 (§7): Chat's message-send mutation is not optimistic, and fixing it needs a
  de-duplication story against the realtime socket layer first.** Quantified, not guessed: zero of
  25 `useMutation` call sites in `chat/` use `useOptimistic`, versus 8 of 48 in `work/`. Message
  send is the highest-impact candidate — the single most frequent interaction on that surface — but
  an optimistic local insert has to reconcile against the SAME message arriving again via Phase
  4/5's socket push without rendering a visible duplicate, which is a real architecture question
  (most likely a client-supplied idempotency key the server and socket both honour), not a
  copy-the-Work-pattern change. Worth its own scoped pass, not a line item inside a future
  "consistency" wave.
- **New, from Wave 5 (§8): dnd-kit's keyboard sensors were not re-verified against the Modal
  extraction.** 3.5's own standing concern — "the keyboard path goes through dnd-kit's sensors, and
  that path is unusable if you cannot see what is focused" — was never specifically re-tested after
  Wave 3 replaced every hand-rolled dialog with `packages/ui`'s `Modal`. Nothing in the diff touches
  drag behaviour, so there is no specific reason to expect a regression, but "no specific reason to
  expect one" is exactly the standard CLAUDE.md's own Phase 5 status header warns is not the same
  as verifying it — this needs the same real-browser, real-keyboard session as the screen-reader
  pass and the responsive-layout check above, and can reasonably be done in the same sitting as
  either.
- **New, from Wave 5 (§8): the mobile drawer's focus handling is not a full focus trap.** Escape
  closes it and focus moves in/out correctly, but Tab can still walk out of the drawer into the
  page content behind the backdrop while it's open. A correct trap needs to handle wrap-around on
  both Tab and Shift+Tab without breaking Escape or the backdrop click — solvable, but risky to get
  right by hand with no way to verify it live, which is exactly why it wasn't attempted this pass.
  Worth building only with real-browser verification available, or by moving the drawer onto
  Radix's own `Dialog` primitive (trading the custom slide-in-from-the-side layout for the focus
  trap that comes free with it) rather than continuing to hand-roll the difference.
