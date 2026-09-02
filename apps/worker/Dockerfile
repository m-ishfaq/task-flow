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

COPY apps/worker apps/worker
# apps/api — the engine imports its service layer at runtime (see the header);
# without it the process dies on the first import.
COPY apps/api apps/api
COPY packages packages

FROM node:22-alpine AS runtime

# No corepack/pnpm here — see apps/api/Dockerfile's runtime stage for why:
# CMD below runs tsx directly and never invokes pnpm.
#
# The node-pkg CVE cluster (pacote, sigstore, tar, brace-expansion,
# picomatch, ip-address, minimatch) that kept re-triggering Trivy's scan
# across every previous round was never pnpm at all — it's node:22-alpine's
# own bundled npm CLI at /usr/local/lib/node_modules/npm, present
# unconditionally regardless of whether this image ever calls npm/npx (it
# doesn't: pnpm builds it, tsx runs it). See apps/api/Dockerfile's runtime
# stage for the full version-match evidence.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Alpine OS-package CVEs — see apps/api/Dockerfile's runtime stage for why.
# APK_CACHE_BUST is passed from CI (cd.yml) and changes every run, forcing
# this layer to rebuild fresh instead of reusing a cache that predates a
# later Alpine security patch.
ARG APK_CACHE_BUST
RUN apk update && apk upgrade --no-cache

RUN addgroup -S taskflow && adduser -S taskflow -G taskflow
WORKDIR /app
ENV NODE_ENV=production

COPY --from=base --chown=taskflow:taskflow /app /app

# Unused esbuild platform binary (vite@6.4.3's, not tsx's -- see
# apps/api/Dockerfile's runtime stage for why the version must be pinned
# exactly rather than wildcarded). This service never imports vite/esbuild.
RUN rm -rf "/app/node_modules/.pnpm/@esbuild+linux-x64@0.25.12"
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
