# syntax=docker/dockerfile:1
#
# apps/web — production image. Two stages: build the static bundle with the
# full workspace available (needed for type-only imports — apps/web's own
# package.json carries @taskflow/api as a devDependency, for the AppRouter
# type the tRPC client is built from), then serve it from a bare nginx image
# that carries none of that build tooling.

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

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

# apps/api's source too — it is a type-only dependency of apps/web (the
# AppRouter type), not something this image runs, but `tsc --noEmit` (the
# first half of "build") resolves it for real.
COPY apps/web apps/web
COPY apps/api apps/api
COPY packages packages

# No VITE_API_BASE_URL set here on purpose: the empty-string default means
# same-origin (apps/web/src/lib/config.ts), which is what nginx.conf's
# same-origin proxying is built around. Setting it here would bake a
# cross-origin API URL into the bundle and break the refresh cookie exactly
# as vite.config.ts's header warns against.
RUN pnpm --filter @taskflow/web build

# nginxinc/nginx-unprivileged, not the plain nginx image — Trivy's misconfig
# scan (AVD-DS-0002) correctly flagged this Dockerfile as the one image of
# the four with no non-root USER. The plain nginx:alpine image can't just
# take a `USER nginx` line: binding :80 needs a privileged port, and its
# cache/pid directories are root-owned, so it would fail to start rather
# than run unprivileged. This image is built for exactly that — it already
# owns its runtime directories as the `nginx` user and listens on 8080
# instead of 80, which is why nginx.conf's `listen` directive and this
# file's EXPOSE/HEALTHCHECK/compose.prod.yaml's port mapping all say 8080
# now, not 80. The host still publishes port 80 (compose.prod.yaml maps
# '80:8080') — nothing changes for anyone hitting the app from outside.
#
# `USER nginx` below is EXPLICIT even though this base image already
# defaults to it — Trivy's Dockerfile linter (unlike the container it
# produces) has no way to inspect a base image's own layers, only the
# instructions literally written in THIS file, so it flagged AVD-DS-0002
# again on the first re-scan despite the image already running unprivileged.
# Stating it here is also just better practice regardless of the scanner: a
# future base-image swap that quietly reverts to a root default fails loud
# at build time (nginx refusing to bind/write as `nginx`) instead of
# silently regressing.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# The base image's Alpine packages drift out of date between its own
# rebuilds — found live: Trivy's OS-package scan (not node-pkg/gobinary,
# which this nginx-only runtime has none of) flagged 33 HIGH/CRITICAL CVEs
# in c-ares, openssl (libcrypto3/libssl3), libexpat, libpng, libxml2, musl,
# nghttp2-libs and zlib, all with fixed versions already in the 3.21 apk
# repo. `apk upgrade` pulls those in at build time instead of waiting on
# nginxinc to cut a new base tag. Must run as root, so it is scoped tightly:
# `USER root` just for the upgrade, then straight back to the explicit
# `USER nginx` the comment above already calls for — which now also covers
# the COPY steps below, exactly as it did before this block existed.
USER root
RUN apk update && apk upgrade --no-cache
USER nginx

COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY apps/web/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080

# 127.0.0.1, not localhost — nginx listens on 0.0.0.0:8080 (IPv4 only) and
# `localhost` resolves to ::1 first on Alpine, so busybox wget is refused
# despite nginx serving fine. This was the first real failure found by
# `docker compose up` of compose.prod.yaml: the host's curl worked, every
# port was mapped, and only the in-container healthcheck could see it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8080/ || exit 1
