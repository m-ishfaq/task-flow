---
name: impeccable-reference
description: Reference-only distillation of Impeccable's frontend craft standards (pbakaus/impeccable) — the quality floor, banned AI-default patterns, and per-topic refinement playbooks (color, type, layout, motion, delight, distillation, tone, hardening, onboarding, responsive, performance, native platform notes). Use when polishing, critiquing, or hardening a UI and you want a concrete craft bar to check against, not just general taste.
---

# Impeccable, as reference docs

This is a curated subset of [pbakaus/impeccable](https://github.com/pbakaus/impeccable)'s own
`skill/reference/` playbooks — the actual design-craft content, not the tool. The real project is a
full CLI with a compiled binary, browser-automation extension, and hooks that can run
automatically on every UI edit. None of that shipped here, deliberately: this repo (TaskFlow)
does not run a third-party binary or an auto-firing hook as part of its own guardrail system, and
adding one wasn't something anyone here asked for by name — the actual VALUE this project offers is
the design knowledge in its reference docs, which reads and applies on its own with no binary at all.

**A few of the copied files still contain a stray line or two referencing the original CLI**
(`{{scripts_path}}/impeccable <verb>`, or "hand off to `impeccable polish`") — leftover from their
own multi-step workflow (snapshot a critique, persist it, hand off to the next command). There is no
such binary installed here. Treat any line like that as inert context about how the ORIGINAL tool
sequences its own commands, never as something to actually run — apply the surrounding judgment
directly instead. Left three files out entirely rather than trying to excise this everywhere:
`critique.md` and `audit.md`/`audit.native.md` are woven through with sub-agent orchestration,
persistence, and detector-script requirements throughout, not just at the edges, and stripping that
out would mean substantially rewriting them rather than curating what's already there.

## What's here

`reference/` — read the one that matches what you're doing, the same way `find-animation-opportunities`
suggests using `animate`/`review-animations`/`improve-animations` for the animation-specific version of
this:

| File | For |
|---|---|
| `craft-floor.md` | The quality floor and the banned AI-default patterns — read this one first, before any UI edit. Contrast, depth, spacing, type, motion, states, browser-chrome theming, copy, coverage; then the specific things to refuse (identical card grids, hero-metric templates, eyebrow labels, gradient text, decorative glass, side-stripe borders, sparkline/progress-ring filler, glyph icons standing in for a real icon system). |
| `colorize.md` | Adding strategic color to a monochromatic UI. |
| `typeset.md` | Typography hierarchy and font choices. |
| `layout.md` | Spacing, rhythm, visual hierarchy. |
| `delight.md` | Personality and memorable touches — the additive-polish end of the spectrum. |
| `distill.md` | Stripping to essence, removing complexity — the opposite end. |
| `bolder.md` | Amplifying a bland/safe design. |
| `quieter.md` | Toning down an overstimulating one. |
| `animate.md` | Purposeful motion (their own take — see also this repo's `animate`/`review-animations` skills for Emil Kowalski's, a different, equally valid voice). |
| `overdrive.md` | Pushing past conventional limits, once the floor is already met. |
| `harden.md` | Production-readiness: error states, i18n, edge cases. |
| `onboard.md` | First-run flows, empty states, activation. |
| `clarify.md` | UX copy, labels, error messages. |
| `adapt.md` / `adapt.native.md` | Responsive behavior across screen sizes — web and native respectively. |
| `optimize.md` | Diagnosing and fixing UI performance. |
| `shape.md` | Planning UX/UI before writing code. |
| `operate.md` | The "Operate" register specifically — task-completion UI: dashboards, editors, admin, settings. This is what TaskFlow itself mostly is, per Impeccable's own vocabulary (as opposed to "Persuade" — landing pages/marketing, which is the register `taste-skill`, the second skill added alongside this one, is actually scoped to). |
| `extract.md` | Pulling reusable tokens/components into a design system. |
| `ios.md` / `android.md` | Native-platform interface conventions, for `apps/mobile`. |

## Not a replacement for this repo's own guardrails

Nothing here overrides CLAUDE.md's own rules (rule 4's ban on `dangerouslySetInnerHTML`, the
`packages/policy`/`packages/db` module boundaries, the "never re-derive authorization in the UI"
rule, etc.) — this skill is about visual/interaction craft, the same layer the Design Bible and this
session's own Track 1–3 consistency sweeps have been working at. If a suggestion here would touch a
guardrail-enforced boundary, the guardrail wins.
