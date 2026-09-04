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
# A defaulted (":-") variable that IS set to a real value is reported too —
# under "Overriding the compose default" — rather than silently folded into
# nothing. Without that, setting a new optional variable (say,
# MAIL_VALIDATE_RECIPIENT_DOMAIN) and running this script gives no evidence
# either way that it was picked up: it isn't a failure to report, but its
# total silence reads identically to "this script doesn't know that
# variable exists yet."
#
# Usage: scripts/check-env-prod.sh [compose-file] [env-file]
# Defaults: compose.prod.yaml, .env.prod
# Exit 0 only if every variable compose actually requires (":?") is set to a
# real, non-placeholder value. Variables with a compose-side default (":-")
# are reported separately and never fail the check — an unset one is not a
# missing configuration, it is compose.prod.yaml's own documented fallback.

COMPOSE_FILE="${1:-compose.prod.yaml}"
ENV_FILE="${2:-.env.prod}"
# The shipped example, used to detect a value copied out of it unchanged.
# .env.prod.example rather than .env.example: the two differ, and this script
# only ever validates a production env file.
EXAMPLE_FILE="${3:-.env.prod.example}"

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
defaulted_overridden=()

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
  # A value copied verbatim out of the example file. This catches what the
  # placeholder pattern above cannot: the examples ship WORKING credentials
  # that match neither ENTER_HERE nor CHANGE_ME — `app-dev-secret`,
  # `migrator-dev-secret`, the MinIO root password, `coturn-dev-secret` —
  # across fifteen database URLs, object storage and TURN. The realistic
  # failure is copying an example file over and editing the fields you were
  # thinking about; JWT_PRIVATE_KEY is caught because it is spelled ENTER_HERE,
  # and every Postgres role password is not.
  #
  # Compared against the example file rather than pattern-matched, so a
  # credential added there in future is covered without anyone having to
  # remember to extend a regex here. The literal `dev-secret` pattern stays as
  # a second net for a value derived from an example rather than copied from
  # one — .env.example (development) shares those credentials with
  # .env.prod.example but is not the file this script diffs against.
  if [ -f "$EXAMPLE_FILE" ]; then
    example_val=$(sed -n "s/^${var}=//p" "$EXAMPLE_FILE" | head -n 1)
    if [ -n "$example_val" ] && [ "$val" = "$example_val" ]; then
      placeholder+=("$var: unchanged from $EXAMPLE_FILE")
      continue
    fi
  fi
  if echo "$val" | grep -qiE 'dev-secret|devsecret'; then
    placeholder+=("$var: looks like a development credential")
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
  else
    # Name only, never the value — some of these are secrets (STRIPE_SECRET_KEY,
    # TWILIO_*), and this section exists to answer "did my override get picked
    # up", not to echo credentials into a terminal or a CI log.
    defaulted_overridden+=("$var")
  fi
done

# -----------------------------------------------------------------------------
# Everything above audits ONE variable at a time. This is a RELATIONSHIP
# between two of them that no per-variable classification can express.
# Added alongside a real deploy that had WEB_HOST_BIND colliding with a
# reverse proxy's own wildcard :80 bind (fixed in PR #108) — that failure is
# loud and blocks the deploy outright. This checks for the opposite, quieter
# mistake it surfaced by contrast: WEB_ORIGIN=https://... (TLS expected, via
# a proxy — see ai/deployment-runbook.md's TLS section) while WEB_HOST_BIND
# is left at its 0.0.0.0 default. Nothing about that fails, or even shows up
# in `docker compose ps` — the web container just stays directly reachable
# over plain HTTP on every interface, right alongside the encrypted origin.
# A warning, never counted toward `failed`, for the same reason nothing else
# here is a hard requirement without a `:?` behind it: this script cannot
# know whether that is deliberate (a migration window, a health-check LB
# that only speaks HTTP) — but silence would be the same class of gap
# PR #108 found, left unchecked in the other direction.
# -----------------------------------------------------------------------------
web_origin_val=$(get_value WEB_ORIGIN || true)
web_host_bind_val=$(get_value WEB_HOST_BIND || true)
if [[ "$web_origin_val" == https://* ]] && [ "${web_host_bind_val:-0.0.0.0}" = "0.0.0.0" ]; then
  echo "WARNING: WEB_ORIGIN is $web_origin_val (TLS expected) but WEB_HOST_BIND"
  echo "is still 0.0.0.0 (or unset) in $ENV_FILE — the web container stays"
  echo "directly reachable over plain HTTP on every interface, bypassing"
  echo "whatever reverse proxy is terminating TLS. Set WEB_HOST_BIND=127.0.0.1"
  echo "(and WEB_HOST_PORT to something other than 80 if the proxy also binds"
  echo "host :80 — see ai/deployment-runbook.md's TLS section) before treating"
  echo "this deploy as secure."
  echo ""
fi

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
print_section "Overriding the compose default (set in $ENV_FILE — value not shown)" "${defaulted_overridden[@]}"
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
