# syntax=docker/dockerfile:1
#
# apps/collab — production image. Same shape as apps/api/Dockerfile; see
# that file's header for why the workspace installs in full (no --prod) and
# why package SOURCE, not just node_modules, has to be copied in.
#
# This image ALSO carries apps/api's source, and that is not a mistake: the
# gateway imports shared authorization and content-validation modules through
# @taskflow/api's exports map (docs/page, tenancy/resolve, richtext —
# apps/collab/src/authorize.ts's header names why it reuses them rather than
# reimplementing them). Those resolve to files under apps/api/src at runtime,
# exactly like a packages/* symlink, so an image without them fails with
# ERR_MODULE_NOT_FOUND on first boot — found by the first real `docker
# compose up` of compose.prod.yaml. apps/web and apps/realtime are still
# excluded: nothing in this service imports from them.

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

# See apps/api/Dockerfile's build stage for the full explanation: pnpm's own
# install run leaves orphaned copies of its internal tooling deps (pacote,
# sigstore, plus stale brace-expansion/ip-address/picomatch/tar versions
# this lockfile doesn't actually resolve) in node_modules/.pnpm, and Trivy
# flags them regardless of whether anything imports them.
RUN find /app/node_modules/.pnpm -maxdepth 1 -type d \( \
      -name 'pacote@*' -o \
      -name 'sigstore@*' -o \
      -name 'brace-expansion@2.0.1' -o \
      -name 'brace-expansion@2.0.2' -o \
      -name 'ip-address@10.1.0' -o \
      -name 'ip-address@10.2.0' -o \
      -name 'picomatch@4.0.3' -o \
      -name 'tar@7.5.11' \
    \) -print -exec rm -rf {} +

COPY apps/collab apps/collab
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

EXPOSE 3002

# apps/collab has no dedicated /health route — it runs Hocuspocus's `Server`
# with no onRequest override, and that server's default request handler
# answers ANY GET with HTTP 200 ("Welcome to Hocuspocus!"). That default was
# deliberately left in place rather than adding a custom onRequest hook: the
# hooks() chain only threads a hook's RETURN value forward (the same footgun
# ai/phase-6-docs.md documents for onAuthenticate's `data.context`), and using
# onRequest to short-circuit with a thrown response risks an unhandled
# promise rejection since createServer's async listener isn't awaited by
# Node's http module — which is a process-killing bug in the one place a
# health check must never be. A plain 200 on any path is a perfectly good
# liveness signal for a gateway with no meaningful "not ready" state of its
# own beyond "the process didn't start".
# 127.0.0.1, not localhost: `localhost` resolves to ::1 first on Alpine and
# Hocuspocus's server listens on IPv4, so wget would be refused despite the
# process being up — same bug as the web image's first real healthcheck. The
# comment sits ABOVE the instruction on purpose: inside the continuation it
# would be joined into the shell command and `#` would comment the check out.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3002/ || exit 1

CMD ["apps/collab/node_modules/.bin/tsx", "apps/collab/src/main.ts"]
