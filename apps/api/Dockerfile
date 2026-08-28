# syntax=docker/dockerfile:1
#
# apps/api — production image.
#
# There is no compiled dist/: "start" runs the TypeScript source directly via
# tsx (apps/api/package.json's own "start": "tsx src/main.ts"), the same
# lightweight production shape CLAUDE.md documents for every backend service
# in this repo. `tsx` is a devDependency despite being the production entry
# point, so this installs the FULL workspace rather than `pnpm install --prod`
# — see ai/pre-launch-hardening.md Priority 1 for why a leaner
# `pnpm deploy --prod` bundle was rejected for this first pass.
#
# Every workspace package (packages/*) is consumed as TypeScript SOURCE, not
# a built artifact — each one's package.json "exports" points at
# ./src/index.ts (e.g. packages/security/package.json). That is what forces
# this image to carry package SOURCE, not just node_modules: a pnpm workspace
# symlink resolves @taskflow/security to packages/security, and tsx needs a
# real src/index.ts to exist behind that symlink at runtime.

FROM node:22-alpine AS base

# Pinned to match package.json's own "packageManager" field and .npmrc's
# engine-strict requirement — a drift here is exactly the class of bug
# CLAUDE.md's tsbuildinfo/engine notes warn about elsewhere in this repo.
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# Manifests first, and nothing else — so an application-code-only change
# invalidates only the source-copy layer below, not this install layer.
# pnpm's workspace resolution needs every member's package.json present (the
# lockfile enumerates all of them), which is why every app and package is
# listed here even though this image only runs apps/api.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/realtime/package.json apps/realtime/package.json
COPY apps/collab/package.json apps/collab/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/feature-flags/package.json packages/feature-flags/package.json
COPY packages/filter/package.json packages/filter/package.json
COPY packages/guardrail-selftest/package.json packages/guardrail-selftest/package.json
COPY packages/mail/package.json packages/mail/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/payments/package.json packages/payments/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/seed/package.json packages/seed/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/telephony/package.json packages/telephony/package.json
COPY packages/tokens/package.json packages/tokens/package.json
COPY packages/ui/package.json packages/ui/package.json

# pnpm.patchedDependencies (package.json) names patch files by path, and
# --frozen-lockfile reads every one of them to verify the lockfile against
# the manifest — even for a patched package this image never installs (e.g.
# apps/mobile's react-native-callkeep). Missing this COPY fails the install
# with ENOENT on the patch file, not a message naming this layer.
COPY patches patches

RUN pnpm install --frozen-lockfile

# pnpm's own install run leaves orphaned copies of ITS internal tooling deps
# (pacote, sigstore -- used for registry fetches and provenance verification;
# older brace-expansion/ip-address/picomatch/tar than this lockfile actually
# resolves) sitting in node_modules alongside the real dependency tree. None
# of these are reachable from pnpm-lock.yaml at these versions -- confirmed
# by grepping it directly, and by the fact this app's real transitive deps
# resolve to different, already-patched versions (see pnpm.overrides in
# package.json for brace-expansion/tar specifically). Trivy's node-pkg scan
# flags them anyway because it scans every package.json it finds on disk,
# not just what an app actually imports.
#
# TEMPORARY DIAGNOSTIC -- not a fix. Two prior attempts both silently found
# nothing: exact node_modules/.pnpm/<name>@<ver> directory-name matching,
# then walking every package.json for its own name/version fields (verified
# correct locally against synthetic orphans at multiple depths, including
# through a top-level symlink matching pnpm's real layout -- still found
# nothing in the real build). There is no way to inspect the real built
# image from this environment: no Docker daemon, no access to build trivy
# from source (too heavy), and the registry's blob storage and this job's
# own full log are both unreachable through the outbound proxy policy here.
# The one channel that reliably survives is a FAILED step's own output, so
# this deliberately fails the build and prints every package.json path
# under /app whose content mentions "pacote" or "sigstore" -- broadened
# from node_modules to all of /app in case that root assumption itself was
# wrong, and following symlinks via fs.statSync this time (the prior walk
# used Dirent.isDirectory(), which does NOT follow a symlink, even though a
# side-by-side local test showed pnpm's canonical .pnpm/<name>@<ver> copy is
# real and reachable independent of that gap). This round is expected to
# leave CD red; the payoff is the path this prints, which the next round
# fixes for real.
RUN node <<'EOF'
const fs = require("fs");
const path = require("path");

const needles = ["pacote", "sigstore"];
const found = [];
let filesScanned = 0;

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.name === "package.json") {
      filesScanned++;
      try {
        const raw = fs.readFileSync(full, "utf8");
        for (const needle of needles) {
          if (raw.includes(`"${needle}"`)) {
            found.push(full);
            break;
          }
        }
      } catch {
        // unreadable/invalid -- not what we're looking for
      }
      continue;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory(); // follows symlinks, unlike Dirent.isDirectory()
    } catch {
      isDir = false;
    }
    if (isDir) walk(full);
  }
}

walk("/app");

console.error("DIAGNOSTIC: scanned", filesScanned, "package.json files under /app");
console.error("DIAGNOSTIC: found", found.length, "matches for pacote/sigstore");
for (const f of found) {
  console.error("DIAGNOSTIC MATCH:", f);
}
if (found.length === 0) {
  console.error("DIAGNOSTIC: NOTHING FOUND ANYWHERE UNDER /app");
}

process.exit(1);
EOF

# Only this service's own source plus every workspace package's source — not
# the other three apps, which apps/api never imports from.
COPY apps/api apps/api
COPY packages packages

FROM node:22-alpine AS runtime

# No corepack/pnpm here on purpose — pnpm's own CLI is a build-time tool
# (installing dependencies, resolving the workspace) and this stage never
# calls it. Found live: Trivy's node-pkg scan kept flagging fresh CVEs in
# pnpm's own VENDORED runtime deps (pacote, sigstore, tar, brace-expansion,
# picomatch, ip-address) — packages this workspace never depends on and
# `pnpm.overrides` can never reach, since overrides only steer our own
# dependency graph. Bumping pnpm's version (round 4) just re-armed the same
# trap: those internals are pinned at pnpm's own release time, so any pnpm
# release accumulates new CVEs as time passes, and 10.34.5 is already the
# newest 10.x build. The only fix that isn't a treadmill is to not carry
# pnpm's CLI in the image Trivy scans — its bundled deps can't be flagged
# in a layer that was never installed. CMD below invokes tsx straight from
# apps/api's own node_modules/.bin instead of through `pnpm --filter ...
# start`; loadEnv() resolves `.env` from the file's own import.meta.url, not
# process.cwd(), so nothing depends on the cwd pnpm's script runner used to
# set (confirmed by running this exact invocation locally: it walks the full
# module graph and fails only on missing env vars, identically to before).
RUN addgroup -S taskflow && adduser -S taskflow -G taskflow
WORKDIR /app
ENV NODE_ENV=production

# --chown here, not a separate RUN chown -R, so ownership is set while the
# layer is written rather than doubling the image with a second full-tree
# copy.
COPY --from=base --chown=taskflow:taskflow /app /app
USER taskflow

EXPOSE 3000

# Two-tier, matching apps/api/src/server.ts's own routes: /health/live never
# touches the database (did the process start), which is all a container
# runtime needs to decide whether to keep this instance in rotation.
# 127.0.0.1, not localhost — `localhost` resolves to ::1 first on Alpine
# while the app listens on IPv4, so wget is refused despite the process being
# up (the web image's first real healthcheck proved this).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3000/health/live || exit 1

CMD ["apps/api/node_modules/.bin/tsx", "apps/api/src/main.ts"]
