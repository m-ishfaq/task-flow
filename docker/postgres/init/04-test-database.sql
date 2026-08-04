-- TaskFlow — the test database.
--
-- The integration suites truncate the tables they touch. That is not incidental
-- to how they work: `apps/api/vitest.config.ts` sets `fileParallelism: false`
-- precisely so the files can share one database and clear it between cases.
--
-- Pointed at `taskflow`, that behaviour deletes the developer's own account,
-- boards and cards every time `pnpm verify` runs. The damage is silent — the
-- suite passes, and the next sign-in fails with "Incorrect email or password"
-- because the account is simply gone, which reads as a bug in authentication
-- rather than as the test run that caused it.
--
-- So the suites get their own database. Same cluster, same roles, same grants,
-- same migrations — a separate database is the smallest boundary that makes the
-- tests worthless to the developer's data while keeping them worth trusting.
--
-- It is created here rather than by the test harness because a harness that
-- creates its own database needs CREATEDB, and `taskflow_migrator` is
-- deliberately NOCREATEDB (§8.3). Handing it that right so the tests are
-- self-contained would widen the most privileged role in the system to avoid
-- one line of setup.

SELECT format('CREATE DATABASE %I', 'taskflow_test')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'taskflow_test')
\gexec

\connect taskflow_test

-- Extensions and privileges are per-database, so the new database starts with
-- neither. These are the SAME files development ran, included rather than
-- repeated: a test database whose grants were transcribed by hand would be
-- testing a privilege model nothing else uses.
--
-- `\ir` includes relative to THIS script's directory, which is what makes the
-- line work both from /docker-entrypoint-initdb.d in the container and from
-- docker/postgres/init in CI, where psql is invoked from the repository root.
\ir 01-extensions.sql
\ir 03-grants.sql
