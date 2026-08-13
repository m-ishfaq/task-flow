#!/bin/sh
set -eu

# Runs after 02-roles.sql and 03-grants.sql — docker-entrypoint-initdb.d
# executes *.sql/*.sh in filename order, and only against an EMPTY data
# directory, exactly like the dev scripts it follows (compose.prod.yaml
# mounts this alongside 01/02/03, deliberately skipping 04-test-database.sql
# — production has no reason to carry a test database or its grants).
#
# This is the ONLY thing compose.prod.yaml changes about role bootstrap: it
# replaces each role's DEV password (hardcoded in 02-roles.sql, and
# documented there as dev-only) with a real secret from the environment. It
# does not touch a single line of role attributes or grants — those files
# are the security model (PLAN.md §8.3, §8.6) and CLAUDE.md's own list of
# human-review surfaces includes packages/db; the safest change here is the
# smallest possible one.
#
# Every variable is REQUIRED — ":?" fails this script, and therefore the
# database's first boot, rather than silently leaving a role on the
# dev-secret password it was just created with.
#
# Passwords must not contain a single-quote character (it would break out of
# the quoted literal in the ALTER ROLE statement below). Generate them with
# `openssl rand -hex 24` or similar — see ai/deployment-runbook.md — which
# can never produce one.

: "${TASKFLOW_MIGRATOR_PASSWORD:?TASKFLOW_MIGRATOR_PASSWORD must be set}"
: "${TASKFLOW_APP_PASSWORD:?TASKFLOW_APP_PASSWORD must be set}"
: "${TASKFLOW_AUDIT_PASSWORD:?TASKFLOW_AUDIT_PASSWORD must be set}"
: "${TASKFLOW_REALTIME_PASSWORD:?TASKFLOW_REALTIME_PASSWORD must be set}"
: "${TASKFLOW_COLLAB_PASSWORD:?TASKFLOW_COLLAB_PASSWORD must be set}"
: "${TASKFLOW_NOTIFICATION_SWEEP_PASSWORD:?TASKFLOW_NOTIFICATION_SWEEP_PASSWORD must be set}"
: "${TASKFLOW_BACKLINKS_PASSWORD:?TASKFLOW_BACKLINKS_PASSWORD must be set}"
: "${TASKFLOW_PLATFORM_ADMIN_PASSWORD:?TASKFLOW_PLATFORM_ADMIN_PASSWORD must be set}"
: "${TASKFLOW_RECORDING_INGEST_PASSWORD:?TASKFLOW_RECORDING_INGEST_PASSWORD must be set}"
: "${TASKFLOW_SEARCH_PASSWORD:?TASKFLOW_SEARCH_PASSWORD must be set}"
: "${TASKFLOW_AUTOMATION_PASSWORD:?TASKFLOW_AUTOMATION_PASSWORD must be set}"
: "${TASKFLOW_WEBHOOK_PASSWORD:?TASKFLOW_WEBHOOK_PASSWORD must be set}"
: "${TASKFLOW_API_TOKEN_AUTH_PASSWORD:?TASKFLOW_API_TOKEN_AUTH_PASSWORD must be set}"
: "${TASKFLOW_BILLING_SWEEP_PASSWORD:?TASKFLOW_BILLING_SWEEP_PASSWORD must be set}"
: "${TASKFLOW_OPS_EVENTS_PASSWORD:?TASKFLOW_OPS_EVENTS_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	ALTER ROLE taskflow_migrator WITH PASSWORD '${TASKFLOW_MIGRATOR_PASSWORD}';
	ALTER ROLE taskflow_app WITH PASSWORD '${TASKFLOW_APP_PASSWORD}';
	ALTER ROLE taskflow_audit WITH PASSWORD '${TASKFLOW_AUDIT_PASSWORD}';
	ALTER ROLE taskflow_realtime WITH PASSWORD '${TASKFLOW_REALTIME_PASSWORD}';
	ALTER ROLE taskflow_collab WITH PASSWORD '${TASKFLOW_COLLAB_PASSWORD}';
	ALTER ROLE taskflow_notification_sweep WITH PASSWORD '${TASKFLOW_NOTIFICATION_SWEEP_PASSWORD}';
	ALTER ROLE taskflow_backlinks WITH PASSWORD '${TASKFLOW_BACKLINKS_PASSWORD}';
	ALTER ROLE taskflow_platform_admin WITH PASSWORD '${TASKFLOW_PLATFORM_ADMIN_PASSWORD}';
	ALTER ROLE taskflow_recording_ingest WITH PASSWORD '${TASKFLOW_RECORDING_INGEST_PASSWORD}';
	ALTER ROLE taskflow_search WITH PASSWORD '${TASKFLOW_SEARCH_PASSWORD}';
	ALTER ROLE taskflow_automation WITH PASSWORD '${TASKFLOW_AUTOMATION_PASSWORD}';
	ALTER ROLE taskflow_webhook WITH PASSWORD '${TASKFLOW_WEBHOOK_PASSWORD}';
	ALTER ROLE taskflow_api_token_auth WITH PASSWORD '${TASKFLOW_API_TOKEN_AUTH_PASSWORD}';
	ALTER ROLE taskflow_billing_sweep WITH PASSWORD '${TASKFLOW_BILLING_SWEEP_PASSWORD}';
	ALTER ROLE taskflow_ops_events WITH PASSWORD '${TASKFLOW_OPS_EVENTS_PASSWORD}';
SQL
