# syntax=docker/dockerfile:1
#
# apps/worker — production image. Same shape as apps/api/Dockerfile; see that
# file's header for why the workspace installs in full (no --prod) and why
# package SOURCE, not just node_modules, has to be copied in.
#
# This image ALSO carries apps/api's source, and that is deliberate rather than
# sloppy: the automation engine executes its actions through apps/api's own
# service layer (ai/phase-10-automation.md §1.3) so that automations produce
# events, audit entries, broadcasts and notifications identically to human
# actions. Those imports resolve to files under apps/api/src at runtime,
# exactly like a packages/* symlink — the same reason apps/collab's image
# carries them, and the same ERR_MODULE_NOT_FOUND on first boot if it did not.
# apps/web and apps/realtime are excluded: nothing here imports from either.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/realtime/package.json apps/realtime/package.json
COPY apps/collab/package.json apps/collab/package.json
COPY apps/worker/package.json apps/worker/package.json
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

# TEMPORARY DIAGNOSTIC -- not a fix. See apps/api/Dockerfile's build stage
# for the full explanation: two prior removal attempts both silently found
# nothing, this environment has no way to inspect the real built image
# directly, and a deliberately-failed step's own output is the one channel
# that reliably survives back to this session. This round is expected to
# leave CD red on purpose.
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

COPY apps/worker apps/worker
# apps/api — the engine imports its service layer at runtime (see the header);
# without it the process dies on the first import.
COPY apps/api apps/api
COPY packages packages

FROM node:22-alpine AS runtime

# No corepack/pnpm here — see apps/api/Dockerfile's runtime stage for why:
# pnpm's own vendored deps (pacote, sigstore, tar, ...) keep re-triggering
# Trivy's node-pkg scan no matter how current the pinned pnpm version is,
# and the only durable fix is to not carry pnpm's CLI in a scanned layer
# that never needs it. CMD below runs tsx directly.
RUN addgroup -S taskflow && adduser -S taskflow -G taskflow
WORKDIR /app
ENV NODE_ENV=production

COPY --from=base --chown=taskflow:taskflow /app /app
USER taskflow

EXPOSE 3003

# 127.0.0.1, not localhost: `localhost` resolves to ::1 first on Alpine while
# the health server listens on IPv4, so wget would be refused despite the
# process being up — the bug the web and collab images both hit on their first
# real healthcheck. The comment sits ABOVE the instruction on purpose; inside
# the continuation it would be joined into the shell command and `#` would
# comment the check out.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3003/health/live || exit 1

CMD ["apps/worker/node_modules/.bin/tsx", "apps/worker/src/main.ts"]
