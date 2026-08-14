#!/usr/bin/env bash
set -euo pipefail

# Full audit of .env.prod against every variable compose.prod.yaml actually
# substitutes.
#
# `docker compose config` refuses to boot on the FIRST unset ${VAR:?}, which
# turns "how many variables are we missing" into a whack-a-mole loop — this
# team hit that exact loop, discovering one missing variable per deploy
# attempt (DATABASE_OPS_EVENTS_URL, then the next one, etc.) instead of
# seeing the whole list up front. This script reads every ${VAR...}
# reference in the compose file in one pass and reports ALL of them:
# missing, blank, a leftover ENTER_HERE/CHANGE_ME placeholder copied from
# .env.prod.example, or fine.
#
# Usage: scripts/check-env-prod.sh [compose-file] [env-file]
# Defaults: compose.prod.yaml, .env.prod
# Exit 0 only if every variable compose actually requires (":?") is set to a
# real, non-placeholder value. Variables with a compose-side default (":-")
# are reported separately and never fail the check — an unset one is not a
# missing configuration, it is compose.prod.yaml's own documented fallback.

COMPOSE_FILE="${1:-compose.prod.yaml}"
ENV_FILE="${2:-.env.prod}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "$COMPOSE_FILE not found" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE not found — copy .env.prod.example and fill in real values first." >&2
  exit 1
fi

# Full-line comments are stripped first. compose.prod.yaml's own header uses
# `${VAR:?}` and `${VAR}` as prose examples of the substitution syntax — real
# YAML, not a reference to an actual variable named VAR — and scanning
# comments picked that up as a phantom required variable.
UNCOMMENTED=$(grep -vE '^[[:space:]]*#' "$COMPOSE_FILE")

# Variables referenced anywhere with :? are required, full stop — even if the
# same name also appears elsewhere with a :- default, the :? reference is the
# one that will actually refuse to boot.
mapfile -t REQUIRED_VARS < <(
  printf '%s\n' "$UNCOMMENTED" |
    grep -oE '\$\{[A-Z_][A-Z0-9_]*:\?' |
    sed -E 's/\$\{([A-Z_][A-Z0-9_]*):\?/\1/' |
    sort -u
)

mapfile -t DEFAULTED_VARS < <(
  printf '%s\n' "$UNCOMMENTED" |
    grep -oE '\$\{[A-Z_][A-Z0-9_]*:-' |
    sed -E 's/\$\{([A-Z_][A-Z0-9_]*):-/\1/' |
    sort -u
)

get_value() {
  local var="$1"
  local line
  # last match wins, matching how a shell/dotenv parser would resolve a
  # variable defined more than once in the same file
  line=$(grep -E "^${var}=" "$ENV_FILE" | tail -1) || true
  if [ -z "$line" ]; then
    return 1
  fi
  local val="${line#*=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  echo "$val"
}

missing=()
empty=()
placeholder=()
ok=()
unset_but_defaulted=()

for var in "${REQUIRED_VARS[@]}"; do
  if ! val=$(get_value "$var"); then
    missing+=("$var")
    continue
  fi
  if [ -z "$val" ]; then
    empty+=("$var")
    continue
  fi
  if echo "$val" | grep -qiE 'ENTER_HERE|CHANGE_ME'; then
    placeholder+=("$var: $val")
    continue
  fi
  ok+=("$var")
done

for var in "${DEFAULTED_VARS[@]}"; do
  # Skip anything already classified above (seen with :? somewhere too).
  if printf '%s\n' "${REQUIRED_VARS[@]}" | grep -qx "$var"; then
    continue
  fi
  if ! get_value "$var" >/dev/null 2>&1; then
    unset_but_defaulted+=("$var")
  fi
done

print_section() {
  local label="$1"
  shift
  local items=("$@")
  if [ "${#items[@]}" -eq 0 ]; then
    return
  fi
  echo "$label (${#items[@]}):"
  for item in "${items[@]}"; do
    echo "  $item"
  done
  echo ""
}

echo "Checked ${#REQUIRED_VARS[@]} required + ${#DEFAULTED_VARS[@]} defaulted variable(s) referenced in $COMPOSE_FILE"
echo ""

print_section "OK" "${ok[@]}"
print_section "Using compose default (not set in $ENV_FILE — fine, not an error)" "${unset_but_defaulted[@]}"
print_section "MISSING (not set in $ENV_FILE at all)" "${missing[@]}"
print_section "EMPTY (set but blank)" "${empty[@]}"
print_section "PLACEHOLDER (still an example value from .env.prod.example)" "${placeholder[@]}"

failed=$(( ${#missing[@]} + ${#empty[@]} + ${#placeholder[@]} ))
if [ "$failed" -gt 0 ]; then
  echo "$failed variable(s) need attention before deploying."
  exit 1
fi

echo "Every required variable is set to a real value."
