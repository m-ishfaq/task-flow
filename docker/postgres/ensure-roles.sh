#!/bin/sh
set -eu

# Runs on EVERY deploy — unlike docker/postgres/init/02-roles.sql, which
# `docker-entrypoint-initdb.d` only executes once, against an EMPTY data
# directory. See compose.prod.yaml's `ensure-roles` service and
# ai/deployment-runbook.md's own note on it.
#
# The gap this closes: a role added to 02-roles.sql after this cluster's
# first boot never gets created on it, because that file simply never runs
# again. That bit one real deployment three times in one day —
# taskflow_billing_sweep, taskflow_ops_events and taskflow_integration_auth
# were all missing, each discovered only when a migration's own GRANT failed
# naming a role that did not exist.
#
# This script is idempotent (CREATE ROLE only for a name pg_roles does not
# already have) and connects as the Postgres SUPERUSER — never as
# taskflow_migrator, which is deliberately NOCREATEROLE (migration 0060's own
# header explains why: a migration file is ordinary reviewed code, and if the
# role that runs it could also mint Postgres roles, a bad migration could
# create a privileged credential as a side effect of a routine deploy).
#
# CREATE ROLE alone grants NOTHING — every real permission still comes from a
# migration's own GRANT, reviewed and merged as a separate change in
# packages/db, a human-review surface per CLAUDE.md. A role landing here with
# no matching GRANT can log in and touch precisely zero tables.
#
# Every password below is REQUIRED, the identical convention
# 05-set-passwords.sh uses: missing = this script (and therefore the deploy)
# fails loudly naming the variable, never a role created with a blank or
# guessable password. A role's password can only ever come from this
# server's own .env.prod — nothing in a pull request can set it, which is
# what stops a merged-but-unprovisioned role from ever becoming reachable.

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
: "${TASKFLOW_INTEGRATION_AUTH_PASSWORD:?TASKFLOW_INTEGRATION_AUTH_PASSWORD must be set}"
: "${TASKFLOW_OPS_EVENTS_PASSWORD:?TASKFLOW_OPS_EVENTS_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
	DO \$do\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_migrator') THEN
	    CREATE ROLE taskflow_migrator WITH LOGIN PASSWORD '${TASKFLOW_MIGRATOR_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_app') THEN
	    CREATE ROLE taskflow_app WITH LOGIN PASSWORD '${TASKFLOW_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_audit') THEN
	    CREATE ROLE taskflow_audit WITH LOGIN PASSWORD '${TASKFLOW_AUDIT_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_realtime') THEN
	    CREATE ROLE taskflow_realtime WITH LOGIN PASSWORD '${TASKFLOW_REALTIME_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_collab') THEN
	    CREATE ROLE taskflow_collab WITH LOGIN PASSWORD '${TASKFLOW_COLLAB_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_notification_sweep') THEN
	    CREATE ROLE taskflow_notification_sweep WITH LOGIN PASSWORD '${TASKFLOW_NOTIFICATION_SWEEP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_backlinks') THEN
	    CREATE ROLE taskflow_backlinks WITH LOGIN PASSWORD '${TASKFLOW_BACKLINKS_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_platform_admin') THEN
	    CREATE ROLE taskflow_platform_admin WITH LOGIN PASSWORD '${TASKFLOW_PLATFORM_ADMIN_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_recording_ingest') THEN
	    CREATE ROLE taskflow_recording_ingest WITH LOGIN PASSWORD '${TASKFLOW_RECORDING_INGEST_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_search') THEN
	    CREATE ROLE taskflow_search WITH LOGIN PASSWORD '${TASKFLOW_SEARCH_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_automation') THEN
	    CREATE ROLE taskflow_automation WITH LOGIN PASSWORD '${TASKFLOW_AUTOMATION_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_webhook') THEN
	    CREATE ROLE taskflow_webhook WITH LOGIN PASSWORD '${TASKFLOW_WEBHOOK_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_api_token_auth') THEN
	    CREATE ROLE taskflow_api_token_auth WITH LOGIN PASSWORD '${TASKFLOW_API_TOKEN_AUTH_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_billing_sweep') THEN
	    CREATE ROLE taskflow_billing_sweep WITH LOGIN PASSWORD '${TASKFLOW_BILLING_SWEEP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_integration_auth') THEN
	    CREATE ROLE taskflow_integration_auth WITH LOGIN PASSWORD '${TASKFLOW_INTEGRATION_AUTH_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'taskflow_ops_events') THEN
	    CREATE ROLE taskflow_ops_events WITH LOGIN PASSWORD '${TASKFLOW_OPS_EVENTS_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
	  END IF;
	END
	\$do\$;

	-- Idempotent on its own — re-granting CONNECT to a role that already has
	-- it is a no-op, so this runs unconditionally every deploy, matching
	-- 03-grants.sql's own CONNECT statement for the roles it creates.
	GRANT CONNECT ON DATABASE taskflow TO
	  taskflow_migrator, taskflow_app, taskflow_audit, taskflow_realtime,
	  taskflow_collab, taskflow_notification_sweep, taskflow_backlinks,
	  taskflow_platform_admin, taskflow_recording_ingest, taskflow_search,
	  taskflow_automation, taskflow_webhook, taskflow_api_token_auth,
	  taskflow_billing_sweep, taskflow_integration_auth, taskflow_ops_events;

	-- The same sanity check 02-roles.sql itself ends with, run again here —
	-- cheap insurance that a role definition landing in a future PR cannot
	-- quietly carry SUPERUSER or BYPASSRLS. Fails the deploy loudly rather
	-- than creating a role that could read across every tenant unfiltered.
	DO \$check\$
	DECLARE
	  offending text;
	BEGIN
	  SELECT string_agg(rolname, ', ')
	    INTO offending
	    FROM pg_roles
	   WHERE rolname LIKE 'taskflow\_%'
	     AND (rolbypassrls OR rolsuper);

	  IF offending IS NOT NULL THEN
	    RAISE EXCEPTION
	      'RLS bypass enabled for role(s): %. Tenant isolation would be disabled. See PLAN.md 8.3.',
	      offending;
	  END IF;
	END
	\$check\$;
SQL
