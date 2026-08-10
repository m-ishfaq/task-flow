# syntax=docker/dockerfile:1
#
# apps/web — production image. Two stages: build the static bundle with the
# full workspace available (needed for type-only imports — apps/web's own
# package.json carries @taskflow/api as a devDependency, for the AppRouter
# type the tRPC client is built from), then serve it from a bare nginx image
# that carries none of that build tooling.

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/realtime/package.json apps/realtime/package.json
COPY apps/collab/package.json apps/collab/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/feature-flags/package.json packages/feature-flags/package.json
COPY packages/filter/package.json packages/filter/package.json
COPY packages/guardrail-selftest/package.json packages/guardrail-selftest/package.json
COPY packages/mail/package.json packages/mail/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/security/package.json packages/security/package.json
COPY packages/seed/package.json packages/seed/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/telephony/package.json packages/telephony/package.json
COPY packages/ui/package.json packages/ui/package.json

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

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:80/ || exit 1
