# Phase 6.5 — UI Polish & Design System

**Status: DRAFT 2026-08-08, not yet approved.**

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
under: *"extract a component only once the same pattern appears three times"* (PLAN.md §6). A grep
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

| Surface | Component files | Shipped with |
| ------- | ---------------- | ------------ |
| `work/`  | 27 | Optimistic mutations, skeletons, toasts, inline create, hover affordances — all of [3.5 Wave 1](phase-3.5-work-ux.md#4-wave-1--shell-and-feel) |
| `auth/`  | 13 | Its own dialog/step-up patterns, built before 3.5 existed |
| `docs/`  | 10 | Built after 3.5 shipped, but never retrofitted with its patterns |
| `chat/`  | 4  | Same |
| `admin/` | 3  | Same |
| `org/`   | 3  | Same |
| `people/`| 2  | Draft (11.5), out of scope here — nothing to polish yet |

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
  rule — *"take the flow, keep the face"* — applies here even more literally: the OKLCH tokens in
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

**Moves to `packages/ui`, because each already has 2+ independent implementations to converge:**

| Component | Current implementations | Radix primitive |
| --------- | ------------------------ | ---------------- |
| `Modal` | `card-detail-panel.tsx`, `share-board.tsx`, `archived-cards-dialog.tsx`, `command-palette.tsx`, `step-up.tsx` | `react-dialog` |
| `DropdownMenu` | `shell.tsx`, `card-tile.tsx` (×2), `view-tabs.tsx` | `react-dropdown-menu` |
| `Popover` | `chat-page.tsx`, `notification-bell.tsx`, `detail/assignee-section.tsx` | `react-popover` |
| `Select` | `filter/filter-builder.tsx`, plus native `<select>` elsewhere (§7 covers the audit) | `react-select` |
| `Checkbox` | scattered across checklist, bulk-select, filter builder | `react-checkbox` |

Already-shared and staying exactly where they are, moving to `packages/ui` unchanged as the
package's first tenants rather than rewritten: everything currently in
`apps/web/src/components/primitives.tsx` — `Button`, `Input`, `FocusOnMountInput`, `Textarea`,
`Field`, `Badge`, `Avatar`, `AvatarStack`, `Spinner`, `Skeleton`, `SkeletonRows`, `Empty`,
`Section`, `AddPanel`, `ConfirmButton` — and `toast.tsx`. These are not being redesigned; they are
being given a second and third consumer, which is the state the file's own comment already
anticipated ("these live here, in the app, until that threshold is met").

**Does not move:** anything with exactly one implementation and no evidence a second is coming —
`filter-builder.tsx`'s query-tree editor, `command-palette.tsx`'s command registry, TipTap's
editor chrome (`.rich-text` in `styles.css`, styled as plain CSS by design — see CLAUDE.md's Phase
3 notes on why). Extracting a one-off is exactly the speculative move §6 warns against; this phase
inherits that discipline rather than suspending it because a package now exists to put things in.

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

## 4. Wave 1 — Audit

**No code changes. ~3–4 days.** Everything downstream sizes off this wave's findings, so it goes
first and is deliberately not skipped in favour of "we already know what's wrong."

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

### 4.1 Wave 1 acceptance

A written findings doc (appended to this file as §15, or a sibling `ai/phase-6.5-audit.md` if it
runs long) covering all six checks above, each finding tagged with which later wave resolves it.
No finding is fixed inline during the audit — mixing discovery and repair is how a systemic gap
gets patched in one spot and missed everywhere else it recurs.

---

## 5. Wave 2 — Design tokens

**No migrations, no route changes. ~1 week.** Depends on Wave 1's contrast and spacing findings.

### 5.1 Colour

`styles.css`'s `@theme` block is already role-named OKLCH (CLAUDE.md's own reasoning: `bg-slate-800`
"becomes a lie the moment a light theme exists"). This wave does not add hues; it:

- Fixes any pair Wave 1's contrast check failed, by adjusting lightness within the existing hue —
  changing what `--color-ink-faint` computes to, never adding a new token for one call site.
- Adds the tokens that are missing, not the colours: `--color-focus` if focus rings need to differ
  from `--color-accent` anywhere audit found a clash, `--color-overlay` for modal scrims (currently
  ad hoc per dialog — the table in §3.1 shows five independent implementations, five independent
  scrim opacities).
- Does **not** add a light theme. `:root { color-scheme: dark }` stays; §14's open questions covers
  why that is a decision for review rather than assumed here.

### 5.2 Spacing and type scale

Formalize what Wave 1's density audit found as drift into an actual scale — most likely Tailwind's
existing `spacing`/`text` scale used consistently rather than a new one invented, since v4's
`@theme` already gives named values for free the same way colour does. The deliverable is a
documented **rule** (which spacing step a list item padding uses vs. a card tile vs. a modal body)
that `packages/ui` components are built against in Wave 3, not a new set of numbers competing with
Tailwind's.

### 5.3 Motion

No motion tokens exist today — grep confirms no `transition-*` beyond the one-line `hover:bg-*`
utility on `Button`. This wave adds a duration/easing pair (`--motion-fast`, `--motion-base`) for
Wave 3's `Modal`/`Popover` enter-exit, sized in Wave 1's findings if any dialog currently pops
instead of transitions. Reduced-motion is not optional: `prefers-reduced-motion` gates the
transition, not a preference toggle the app has to build and remember.

### 5.4 Wave 2 acceptance

`styles.css`'s `@theme` block is the single source for every value Wave 3's components reference —
no component in `packages/ui` hardcodes a hex, an OKLCH triple, or a bespoke spacing value that
isn't a token. Every contrast pair Wave 1 flagged passes AA when re-checked.

---

## 6. Wave 3 — Extract `packages/ui`

**No migrations, no route changes. ~2 weeks.** The centre of the phase.

- New package scaffold: `packages/ui/package.json`, `tsconfig.json` extending
  `packages/config/tsconfig/base.json` (CLAUDE.md's standing warning applies here too — no
  per-package `eslint.config.js`; this package is covered by the root config's `files` scope like
  every other package).
- Move `primitives.tsx`'s exports into `packages/ui/src/` as multiple files rather than one
  510-line one — `button.tsx`, `input.tsx`, `field.tsx`, `avatar.tsx`, `feedback.tsx` (Spinner/
  Skeleton/Empty), `layout.tsx` (Section/AddPanel/ConfirmButton) — same components, same behaviour,
  same comments explaining the non-obvious decisions (the `type="submit"` trap on `Button`, the
  `aria-hidden` reasoning on `Skeleton`, all of it carries over verbatim; none of that reasoning
  goes stale by moving files).
- Build `Modal`, `DropdownMenu`, `Popover`, `Select`, `Checkbox` new, each replacing every call site
  in §3.1's table. Built against Wave 1's duplication census, not against any single existing
  implementation — the point is to keep the best behaviour each hand-rolled version had (whichever
  one gets focus-return right, whichever one gets outside-click-to-close right on a touch device)
  rather than picking one file's version as the winner by default.
- `apps/web/src/components/primitives.tsx` becomes a thin re-export (or is deleted and every import
  updated — decided per how many call sites exist; either way, a single compile-time move, not a
  behaviour change). `toast.tsx` moves the same way.
- Every one of the thirteen call sites in §1 is updated to the new component. This is the wave's
  actual deliverable, not the component code by itself — an extraction with three call sites still
  on the old pattern has fixed nothing, it has added a fourth thing to keep in sync.

### 6.1 Wave 3 acceptance

Zero direct `@radix-ui/*` imports outside `packages/ui`. `pnpm verify` green. Every dialog, dropdown,
popover, select, and checkbox in the app renders through `packages/ui` and behaves identically to
its best prior implementation (focus trap, escape, outside-click, portal target) — verified by
re-running Wave 1's screen-reader pass over the same five flows, not just by TypeScript compiling.

---

## 7. Wave 4 — Consistency pass across shipped surfaces

**No migrations. ~1–2 weeks**, run per-surface against Wave 1's per-surface findings.

The goal: bring Chat, Docs, Auth, Admin, and Notifications up to the bar Work already cleared in
[3.5 Wave 1](phase-3.5-work-ux.md#4-wave-1--shell-and-feel), using the components Wave 3 just built.

- **Loading states.** Replace centred `Spinner` usage with shape-matched `Skeleton`/`SkeletonRows`
  wherever Wave 1 found one — a chat channel's message list, a doc page's tree, the notification
  preferences panel. `Spinner` stays only where 3.5 §4.6 already scoped it: a button mid-submit, the
  boot gate.
- **Empty states.** Every list that can legitimately be empty (no channels, no doc spaces, no
  notifications) gets `Empty` with a real action, not a blank region — the same distinction 3.5's
  own comment on `Empty` draws between "no data", "still loading", and "the request failed".
  `ErrorView` stays exactly as-is everywhere, per CLAUDE.md's own instruction that its request id is
  "the only thread between a user's report and a log line" and must survive every redesign,
  including this one.
- **Feedback.** Any mutation in Chat/Docs/Admin still resolving via a full refetch with no
  optimistic update gets `packages/ui`'s toast on error, matching `optimistic.ts`'s existing
  `onMutate`/`onError`/`onSettled` contract from 3.5 §4.3. This wave does **not** retrofit
  optimistic UI everywhere blind — only where Wave 1 found the round trip is slow enough to be felt
  (message send, page rename), the same selectivity 3.5 §4.3 used for Work.
- **Avatars and people.** `Avatar`/`AvatarStack` (already built, already colour-stable by user id)
  used everywhere a raw user id or bare email currently renders — chat message authors, doc page
  editors, notification senders.
- **Density.** Wave 1's spacing-drift catalogue resolved against Wave 2's scale, surface by
  surface.

### 7.1 Wave 4 acceptance

Wave 1's empty/loading/error grid re-run with every cell filled from the shared components. No
surface has a state Work already solved and this one still shows raw.

---

## 8. Wave 5 — Accessibility hardening

**No migrations. ~1 week.** Distinct from Wave 1's audit (which finds problems) and Wave 4's pass
(which fixes the ones visible/behavioural rot causes) — this wave is what's left over: contrast
edge cases, keyboard traps, and ARIA labelling that Wave 3's component extraction doesn't
automatically fix because it's specific to a call site, not to the primitive.

- Re-run Wave 1's screen-reader flows against the whole app post-Wave-4, not just the five flows
  originally tested.
- Every icon-only button (overflow menus, the archived-cards toggle, the notification bell) gets an
  `aria-label` audit — `Avatar`'s own `role="img"` treatment (primitives.tsx, quoted above) is the
  existing pattern to match, not a new one to invent.
- Keyboard-only pass on the two most complex interactions: dnd-kit's card drag (3.5 already notes
  "the keyboard path goes through dnd-kit's sensors, and that path is unusable if you cannot see
  what is focused" — verify it still is, post-Modal-extraction, since a dialog opening mid-drag is
  exactly the kind of interaction two independently-built components can break for each other) and
  the command palette's result list.
- `prefers-reduced-motion` verified against Wave 2's new transitions, not just declared.

### 8.1 Wave 5 acceptance

A second screen-reader pass, written up the same way Wave 1's was, with every finding closed or
explicitly deferred with a reason in §14.

---

## 9. Wave 6 — Responsive layout (sized separately, not committed here)

Every surface today assumes a desktop viewport — the sidebar (3.5 §4.1) is a fixed-width persistent
element, the card detail modal is a centred two-column layout with no reflow, the table view relies
on horizontal space for its columns. Nothing in PLAN.md commits to a mobile or narrow-viewport
target anywhere in the document, which means this wave's actual scope — down to whether it exists
at all — is an open question for approval (§14), not a committed deliverable the way Waves 1–5 are.
Sized the same way [3.5 §7 sized its own Wave 4](phase-3.5-work-ux.md#7-wave-4--depth): named here
so it isn't lost, not estimated until the scope question is answered.

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

| Wave | Delivers | Migrations | Est. |
| ---- | -------- | ---------- | ---- |
| 1 | Audit: contrast, focus, screen-reader pass, duplication census, density/state gaps | none | 3–4 days |
| 2 | Design tokens: colour fixes, spacing/type scale, motion tokens | none | 1 wk |
| 3 | `packages/ui` extraction: Modal, DropdownMenu, Popover, Select, Checkbox + relocated primitives | none | 2 wks |
| 4 | Consistency pass: Chat, Docs, Auth, Admin, Notifications brought to Work's Wave-1 bar | none | 1–2 wks |
| 5 | Accessibility hardening: re-run audits, icon-label pass, keyboard pass, reduced-motion | none | 1 wk |
| 6 | Responsive layout | TBD | not sized — scope is an open question |

**Waves 1–5 ≈ 5–7 weeks.** Wave 6 is a separate decision, the same way 3.5's Wave 4 was.

Each wave is independently shippable: Wave 1 produces a document, not code, so it carries zero
risk to ship first regardless of what's decided about the rest. Waves 2 and 3 must land before
Wave 4 (nothing to apply consistency with, otherwise); Wave 5 depends on Wave 4 being done so its
re-audit means something.

**This delays Phase 7 (Voice) by its own length**, the same honest accounting 3.5 §9 gave for
Phase 4. Unlike that delay, this one is recoverable in the other direction: every hour spent here
is an hour Voice, Search, and Automation's own UI work doesn't have to spend reinventing a modal.

---

## 12. What "done" means

Every one of the six shipped surfaces (Work, Chat, Docs, Auth, Admin, Notifications) renders its
dialogs, dropdowns, popovers, selects, and checkboxes through `packages/ui`. Zero direct Radix
imports outside that package. Wave 1's contrast, focus, and screen-reader findings are all closed
or explicitly deferred with a reason recorded in §14. Loading/empty/error states are visually and
behaviourally consistent app-wide. No new user-facing feature exists that didn't exist before this
phase started — that absence is the deliverable, not a gap in scope.

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
4. **Wave 6 (responsive layout) scope.** Needs an actual answer, not a recommendation — does
   TaskFlow target mobile/tablet at all in the current roadmap, or is "desktop, wide viewport" an
   accepted constraint through Phase 13's launch? PLAN.md is silent on this everywhere, and Wave 6
   cannot be sized honestly until it's answered.
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
- Does Wave 6 (responsive) get scheduled at all before Phase 13 (Hardening & launch), or does it
  get folded into that phase's own scope, which already owns "runbooks" and cross-cutting
  pre-launch concerns? This is really the same question as Decision 4 above, phrased as sequencing
  rather than scope.
