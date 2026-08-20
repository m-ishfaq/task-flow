# Dependency audit exceptions

`pnpm audit --audit-level high` is a merge-blocking CI gate (PLAN.md §8.8). Every advisory
suppressed via `pnpm.auditConfig.ignoreGhsas` in `package.json` must be justified here.

**An entry without a review trigger is not acceptable.** A suppression list nobody revisits is
how a real vulnerability eventually hides behind a stale exception. If a suppression cannot be
given a concrete condition for removal, do not suppress it — fix or replace the dependency.

---

## GHSA-mh99-v99m-4gvg — `brace-expansion` ReDoS

**Added:** 2026-07-27 · **Severity:** high

**Path:** `eslint → minimatch@3 → brace-expansion@1`

**Why suppressed:**

The advisory marks only `>=5.0.8` as patched. The dependency chain requires the 1.x line
(`minimatch@3` depends on `brace-expansion@^1.1.7`), and no patched 1.x release exists — the line
tops out at 1.1.12.

Overriding to 5.0.8 was attempted and **breaks the build**: `brace-expansion@5` is not
call-compatible with the v1 API that `minimatch@3` uses, producing
`TypeError: expand is not a function` in ESLint's config resolution. So the override is scoped to
the 5.x line only (`"brace-expansion@5": ">=5.0.8"`), which patches anything that can accept it
and leaves the 1.x chain untouched.

**Residual risk: low.** ESLint is a development dependency. It is never present in a runtime
container, never processes untrusted input, and the ReDoS requires attacker-controlled glob
patterns — here the patterns come from our own committed config files.

**Review trigger:**

- ESLint upgrades to a `minimatch` major that accepts `brace-expansion@>=5.0.8`, **or**
- A patched `brace-expansion@1.x` is published, **or**
- This dependency ever appears in a runtime (non-dev) path — re-evaluate immediately

Re-check whenever the ESLint version changes. Remove this entry the moment
`pnpm why brace-expansion` shows no 1.x resolution.

---

## GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq — `image-size` infinite-loop DoS

**Added:** 2026-08-20 · **Severity:** high (both)

**Path:** `apps/mobile > expo@57.0.15 > @expo/cli@57.0.17 > react-native@0.86.2 >
@react-native/community-cli-plugin@0.86.2 > @react-native/metro-config@0.87.0 >
metro-config@0.87.0 > metro@0.87.0 > image-size@1.2.1` (and a second path through
`@react-native-async-storage/async-storage`'s own `react-native` peer, and a third through
`@expo/log-box`'s `@expo/dom-webview` — same terminal package, ~490 total paths per `pnpm audit`,
all converging on Metro's asset pipeline).

**Why suppressed:**

Both advisories mark every published `image-size` release as vulnerable — `<=2.0.2`, which is
`latest` — and `patched: <0.0.0`, meaning no fixed version exists at all, not merely one this repo
hasn't picked up yet. `metro@0.87.0` (Metro, React Native's bundler) depends on
`image-size@^1.0.2`, a range that cannot reach 2.x even if a patch existed there. There is no
version of `metro` to move to and no override target to redirect the resolution toward — the same
situation `GHSA-mh99-v99m-4gvg` above documents for `brace-expansion`, not a case where suppression
was chosen over a working fix.

**Residual risk: low.** `metro` is Metro's own asset pipeline, invoked only by the Expo/React
Native CLI during LOCAL bundling (`expo start`, a dev build, an EAS build) — it never runs in a
deployed container and ships no code of its own into a built app. Both advisories are a parser
denial-of-service (an infinite loop) triggered by a malformed ICNS/JXL/HEIF image reaching
`image-size`'s parser; the images Metro feeds it are this repo's own committed asset files, not
attacker-controlled input arriving over a network boundary. Worst case is a hung local bundler
process on a malicious asset someone already got into the repo — a supply-chain compromise that
would grant far worse access than a bundler hang.

**Review trigger:**

- A patched `image-size` is published (either advisory gets a real `Patched versions` entry), **or**
- `metro` upgrades to depend on a patched `image-size` range, **or**
- `image-size` or `metro` ever appears in a path that ships in a built app or runs against
  untrusted/network-sourced images — re-evaluate immediately

Re-check whenever `apps/mobile`'s `expo` / `react-native` versions change. Remove this entry the
moment `pnpm why image-size` shows a resolved version outside `<=2.0.2`.

---

## How to verify an exception is still needed

```bash
pnpm why brace-expansion          # confirm the path still exists
pnpm why image-size               # same, for the image-size entries
pnpm audit --audit-level high     # with the entry removed, does it still fire?
```
