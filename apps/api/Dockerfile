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
COPY packages/ai/package.json packages/ai/package.json
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

# No corepack/pnpm here on purpose — pnpm's own CLI is a build-time tool
# (installing dependencies, resolving the workspace) and this stage never
# calls it. CMD below invokes tsx straight from apps/api's own
# node_modules/.bin instead of through `pnpm --filter ... start`;
# loadEnv() resolves `.env` from the file's own import.meta.url, not
# process.cwd(), so nothing depends on the cwd pnpm's script runner used to
# set (confirmed by running this exact invocation locally: it walks the full
# module graph and fails only on missing env vars, identically to before).
#
# The REAL source of the node-pkg CVE cluster three earlier rounds chased
# (pacote, sigstore, tar, brace-expansion, picomatch, ip-address, minimatch)
# was never pnpm at all -- it's node:22-alpine's own BUNDLED npm CLI,
# installed at /usr/local/lib/node_modules/npm unconditionally by the base
# image, regardless of whether anything in this repo uses npm. npm depends
# on exactly these packages internally (pacote for registry fetches,
# sigstore for provenance, tar/brace-expansion/picomatch/minimatch for
# extracting and glob-matching), completely outside pnpm-lock.yaml and
# outside /app entirely -- which is exactly why a diagnostic walk of the
# whole /app tree (round 9) found zero matches: nothing was ever there. A
# local npm install confirms the exact match: pacote@19.0.2, sigstore@3.1.0,
# brace-expansion@2.0.2, ip-address@10.1.0, picomatch@4.0.3, tar@7.5.11 --
# the precise versions Trivy has flagged every round since #99. This image
# never runs npm/npx (pnpm builds it, tsx runs it), so deleting npm's own
# bundled installation removes the whole cluster at its actual source,
# permanently -- not another version chase, since nothing here depends on
# npm ever getting patched upstream.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Alpine OS-package CVEs (libcrypto3/libssl3 and whatever else has a fixed
# version in the 3.24 apk repo by build time) — same fix apps/web/Dockerfile
# already carries for its nginx base, applied here for the same reason: this
# runtime stage is still root at this point, before USER taskflow below.
# APK_CACHE_BUST is passed from CI (cd.yml) and changes every run,
# invalidating this layer so `apk upgrade` always pulls fresh packages —
# without it, GHA's layer cache can keep serving a package version that
# predates a CVE fix Alpine shipped after the layer was first built (this is
# exactly what broke apps/web/Dockerfile's build once already).
ARG APK_CACHE_BUST
RUN apk update && apk upgrade --no-cache

RUN addgroup -S taskflow && adduser -S taskflow -G taskflow
WORKDIR /app
ENV NODE_ENV=production

# --chown here, not a separate RUN chown -R, so ownership is set while the
# layer is written rather than doubling the image with a second full-tree
# copy.
COPY --from=base --chown=taskflow:taskflow /app /app

# esbuild's platform binary (a Go program, not JS) ships into node_modules
# as a transitive dependency of apps/web's own build tooling (vite@6.4.3,
# pinned to esbuild@0.25.12) -- pulled in because this image installs the
# full workspace, not just apps/api's own deps (see this file's header).
# This service never imports vite or esbuild, so that binary is pure dead
# weight here -- and it is the one thing in this image Trivy's gobinary
# scanner can reach: a fixed Go-stdlib version at build time means every
# CVE patched since then shows up against a binary nothing here ever runs.
# PR #98 flagged this rather than bumping esbuild everywhere, because a
# newer esbuild breaks apps/web's actual production build against its
# current legacy browser target -- that tradeoff is real for apps/web, but
# doesn't apply to this image, so removing the binary is the fix here.
#
# The version pin below is deliberate, not a shortcut: tsx (this image's
# own CMD, below) depends on a DIFFERENT esbuild -- 0.28.1, resolved from
# tsx's own "esbuild": "~0.28.0" -- which is what actually transpiles
# TypeScript at container startup. A wildcard delete here would remove
# that version too and take down every request with it, silently, since
# nothing in CI actually boots the container and hits an endpoint. Only
# the exact vulnerable version Trivy names is safe to delete; if the
# lockfile later bumps vite/esbuild past 0.25.12, this line simply stops
# matching anything, rather than deleting whatever version replaced it.
RUN rm -rf "/app/node_modules/.pnpm/@esbuild+linux-x64@0.25.12"
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
