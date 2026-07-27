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

## How to verify an exception is still needed

```bash
pnpm why brace-expansion          # confirm the path still exists
pnpm audit --audit-level high     # with the entry removed, does it still fire?
```
