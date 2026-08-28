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

# Only this service's own source plus every workspace package's source — not
# the other three apps, which apps/api never imports from.
COPY apps/api apps/api
COPY packages packages

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
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

CMD ["pnpm", "--filter", "@taskflow/api", "start"]
