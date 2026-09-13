# Third-party skills

Skills vendored into this directory from outside the repo, kept here rather
than only in a person's local `~/.claude/skills/` so every Claude Code
session in this repo — anyone's, not just the one that added them — gets
the same frontend/motion craft guidance.

These are all pure guidance/instruction files (`SKILL.md` + reference docs)
as vendored HERE — nothing in this directory ships a hook, a binary, or
anything that executes on its own; they only ever change what Claude reads
before acting, never what runs automatically in this repo. `impeccable/`
(below) is the one entry where the SOURCE project is more than that — its
own repo is a full CLI with a compiled binary and auto-firing hooks — and
this notice says explicitly what was left out and why.

## `animate/`, `animate-expo/`, `animation-vocabulary/`, `apple-design/`, `ask-sonner/`, `emil-design-eng/`, `find-animation-opportunities/`, `improve-animations/`, `pick-ui-library/`, `prototype/`, `review-animations/`, `write-swift/`

Source: https://github.com/emilkowalski/skill
Commit: `d23d7f88a2e21c9e4b1418c7abe420f5c1052ba7` (2026-08-21)
License: MIT, Copyright (c) 2026 Emil Kowalski — full text at the source
repo's own `LICENSE`.

Emil Kowalski's animation/design-engineering skill set. Most of these are
directly relevant to this repo's ongoing web UI polish (`animate`,
`animation-vocabulary`, `emil-design-eng`, `find-animation-opportunities`,
`improve-animations`, `review-animations`, `pick-ui-library`, `prototype`)
or to `apps/mobile`'s Expo build (`animate-expo`, `apple-design`). Two are
currently dormant here and kept only because the source repo bundles them
as one set: `write-swift` (this codebase has no Swift anywhere) and
`ask-sonner` (this app's toasts are Radix Toast — `apps/web/src/components/
toast.tsx` — not the Sonner library `ask-sonner` covers).

## `taste-skill/`

Source: https://github.com/Leonxlnx/taste-skill (the `skills/taste-skill`
folder specifically, not the repo's other, unrelated skills — brand/logo
generation, image-to-code, image generation — which this pass did not
bring in)
Commit: `ccbc15639c97057cbfcf32ecebc38ef716e4bb37` (2026-08-24)
License: MIT, Copyright (c) 2026 Leonxlnx — full text at the source repo's
own `LICENSE`.

An anti-templated-design skill scoped explicitly to "landing pages,
portfolios, and redesigns — not dashboards, not data tables, not
multi-step product UI" (its own `SKILL.md`). Most of this repo's own
surface area is exactly the "not" list, with one real exception: Docs'
publish-to-public pages (Phase 6 Wave 4) are genuinely landing-page-shaped
content served to a reader with no session — the one place in this app
this skill's own stated scope actually fits.

## `impeccable/`

Source: https://github.com/pbakaus/impeccable (22 files from `skill/reference/`
only — not the CLI, the compiled per-platform binaries, the browser
extension, the VS Code extension, or the auto-firing edit hooks the real
project also ships)
Commit: `cb56ed6c19a07329a9fa0cd4e657bee040156593` (2026-09-11)
License: Apache 2.0, Copyright pbakaus — full text at the source repo's own
`LICENSE`.

The real `pbakaus/impeccable` is a full CLI tool: a compiled Rust binary,
per-platform packages, a browser extension for live design scanning, and
hooks that can run automatically after every UI file edit. Deliberately
NOT installed that way here — an auto-firing hook and a downloaded binary
are a real behavior change to this repo, not an addition of documentation,
and nobody asked for that specifically. What's vendored is the 22
reference playbooks that read as genuine, tool-independent design
judgment (the craft floor and banned-pattern list, plus per-topic
playbooks for color/type/layout/motion/tone/hardening/onboarding/
responsive/performance/native platforms) — see `impeccable/SKILL.md` for
the full list and for which three files were left out and why (their own
`critique.md`/`audit.md`/`audit.native.md` are woven through with
sub-agent orchestration and persistence steps that assume the binary
exists). These files were selected by hand rather than by a scripted
vendor/sync step, so a future refresh needs the same manual review
repeated against a newer commit, not a mechanical re-copy.
