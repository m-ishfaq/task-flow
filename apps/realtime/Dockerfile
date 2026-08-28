# syntax=docker/dockerfile:1
#
# apps/realtime — production image. Same shape as apps/api/Dockerfile; see
# that file's header for why the workspace installs in full (no --prod) and
# why package SOURCE, not just node_modules, has to be copied in.
#
# This image ALSO carries apps/api's source, and that is not a mistake: the
# gateway imports shared authorization modules through @taskflow/api's exports
# map (tenancy/resolve, work/board, chat/channel, rtc/session,
# config/trust-proxy — apps/realtime/src/rooms.ts's header names why the
# gateway reuses them rather than reimplementing them). Those resolve to
# files under apps/api/src at runtime, exactly like a packages/* symlink, so
# an image without them fails with ERR_MODULE_NOT_FOUND on first boot — found
# by the first real `docker compose up` of compose.prod.yaml. apps/web and
# apps/collab are still excluded: nothing in this service imports from them.

FROM node:22-alpine AS base
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

COPY apps/realtime apps/realtime
# apps/api — the gateway imports @taskflow/api source at runtime (see the
# file header); without it the process dies on the first import.
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

EXPOSE 3001

# apps/realtime/src/gateway.ts carries the same two-tier /health/live and
# /health/ready pair apps/api's server.ts does (added specifically so this
# HEALTHCHECK has something to call — it did not exist before this wave).
# 127.0.0.1, not localhost: the gateway listens on 0.0.0.0:3001 (IPv4 only)
# and `localhost` resolves to ::1 first on Alpine, so wget is refused despite
# the process being up — the same bug that made the web image's first real
# healthcheck fail (see apps/web/Dockerfile). A comment must NOT sit inside a
# HEALTHCHECK continuation: the parser joins those lines into the shell
# command, where `#` comments out the whole check and leaves it passing
# without testing anything.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3001/health/live || exit 1

CMD ["apps/realtime/node_modules/.bin/tsx", "apps/realtime/src/main.ts"]
