#!/usr/bin/env bash
set -euo pipefail

# Repeatable production deploy for compose.prod.yaml, run on the prod host
# itself, from the repo checkout that ai/deployment-runbook.md's "ongoing"
# section already assumes.
#
# Written after this exact stack hit the same two failure classes more than
# once: (1) a plain `up -d` with no IMAGE_TAG on the shell silently fell back
# to .env.prod's IMAGE_TAG=local default, leaving api/realtime/collab on a
# stale local image while web/worker had already moved on to a CD-built SHA
# — api then crashed on boot because its baked-in env.ts didn't recognize a
# variable the CURRENT compose.prod.yaml sets; (2) ensure-roles/migrate were
# run as `--profile tools up -d` instead of `run --rm`, leaving stopped
# containers behind that read as failures in Dozzle when they had actually
# exited 0.
#
# This script fixes both by construction: IMAGE_TAG is a required argument,
# never a default; every one-shot job runs with --rm; and check-env-prod.sh
# (a full audit of every variable compose.prod.yaml references — missing,
# blank, or a leftover ENTER_HERE/CHANGE_ME placeholder from .env.prod.example,
# ALL of them at once rather than the one-at-a-time failures `docker compose
# config` gives you) runs BEFORE anything is built, pulled, or recreated.
#
# Usage:
#   scripts/deploy-prod.sh <image-tag>              # pull pre-built images (normal path)
#   scripts/deploy-prod.sh <image-tag> --build       # build locally instead of pulling
#
# <image-tag> is typically a git SHA already pushed to GHCR by CD. Passing
# the same tag every service already runs (see `docker compose ps`) is a
# no-op redeploy; passing a previous SHA is the documented rollback.

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "Usage: $0 <image-tag> [--build]" >&2
  echo "  <image-tag> is required. It is NEVER read from .env.prod's IMAGE_TAG" >&2
  echo "  default — that default exists only so a bare 'docker compose config'" >&2
  echo "  has something to resolve; the drift it caused is why this script exists." >&2
  exit 1
fi

IMAGE_TAG="$1"
MODE="${2:-}"
export IMAGE_TAG

if [ -n "$MODE" ] && [ "$MODE" != "--build" ]; then
  echo "Unknown option: $MODE (only --build is accepted)" >&2
  exit 1
fi

if [ ! -f .env.prod ]; then
  echo ".env.prod not found in $(pwd) — run this from the repo root on the prod host." >&2
  exit 1
fi

COMPOSE=(docker compose --env-file .env.prod -f compose.prod.yaml)

echo "== [1/7] gate: full .env.prod audit =="
# check-env-prod.sh also warns here if WEB_ORIGIN is https:// while
# WEB_HOST_BIND is still 0.0.0.0 — the web container silently staying
# reachable over plain HTTP alongside a TLS-terminating reverse proxy. That
# check lives there, not here, so it fires whether this script or
# check-env-prod.sh is run directly.
"$(dirname "$0")/check-env-prod.sh" compose.prod.yaml .env.prod

echo "== [2/7] gate: compose config resolves (belt-and-suspenders on the check above) =="
"${COMPOSE[@]}" config --quiet
echo "  ok"

echo "== [3/7] ensure-roles (deploying tag: $IMAGE_TAG) =="
"${COMPOSE[@]}" --profile tools run --rm ensure-roles

echo "== [4/7] migrate =="
"${COMPOSE[@]}" --profile tools run --rm migrate

echo "== [5/7] $([ "$MODE" = "--build" ] && echo build || echo pull) images =="
if [ "$MODE" = "--build" ]; then
  "${COMPOSE[@]}" build
else
  "${COMPOSE[@]}" pull
fi

echo "== [6/7] up -d --remove-orphans =="
"${COMPOSE[@]}" up -d --remove-orphans

echo "== [7/7] health check =="
sleep 5
"${COMPOSE[@]}" ps

UNHEALTHY=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' | grep -Ei 'restarting|unhealthy|exit' || true)
if [ -n "$UNHEALTHY" ]; then
  echo "" >&2
  echo "Not every service came up clean:" >&2
  echo "$UNHEALTHY" >&2
  echo "" >&2
  echo "Check logs before calling this deploy done:" >&2
  echo "  docker compose --env-file .env.prod -f compose.prod.yaml logs <service> --tail 80" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# The log viewer's gate is INFRASTRUCTURE, and infrastructure is not in this
# repo — so this is the only place the repo can check it happened.
#
# compose.prod.yaml binds dozzle to 127.0.0.1 with no `:-0.0.0.0` fallback, and
# documents that the reverse proxy must put basicauth in front of it. Nothing
# enforced that. Meanwhile the platform-admin console actively links operators
# to /logs, so the app assumes the path is reachable — and a docker socket
# mount, read-only or not, is every container's logs.
#
# Every other control in this codebase is enforced by a mechanism rather than a
# note (CLAUDE.md's own thesis). This turns the note into a mechanism as far as
# a script on this box can: if /logs answers without asking for credentials,
# the deploy says so loudly. A warning rather than an exit, because the proxy
# may legitimately live on another host — but never silence.
# -----------------------------------------------------------------------------
LOGS_URL="${LOGS_PROBE_URL:-}"
if [ -n "$LOGS_URL" ]; then
  echo ""
  echo "== checking the log viewer is behind auth =="
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$LOGS_URL" || echo "000")
  case "$STATUS" in
    401 | 403)
      echo "  $LOGS_URL -> $STATUS (authentication required, as intended)"
      ;;
    000)
      echo "  $LOGS_URL unreachable from here — not a verdict either way." >&2
      ;;
    *)
      echo "" >&2
      echo "  WARNING: $LOGS_URL answered $STATUS without asking for credentials." >&2
      echo "  Dozzle reads every container's logs. Put basicauth in front of it" >&2
      echo "  on the proxy before treating this deploy as finished." >&2
      ;;
  esac
fi

echo ""
echo "Deploy of $IMAGE_TAG complete. Every service is up and healthy."
