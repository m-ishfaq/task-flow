-- 0007 — the audit log: append-only, hash-chained, monthly partitions
-- (PLAN.md §7.1, §7.2, §8.6)
--
-- One event stream, two projections (§8.6). platform.activities will power
-- user-facing timelines; this is the compliance record — field diffs, network
-- metadata, policy decision traces — readable only by Owner and Admin.
--
-- THREE INDEPENDENT CONTROLS, because "append-only" asserted by application
-- code is not a control at all:
--
--   1. GRANTS. taskflow_audit holds INSERT and SELECT and is never granted
--      UPDATE or DELETE (see docker/postgres/init/02-roles.sql). The
--      application role holds SELECT alone. There is no role in the system that
--      can rewrite a row here.
--   2. THE HASH CHAIN. Each entry commits to the previous entry's hash, so
--      removing or editing an entry breaks every hash after it. Detection, not
--      prevention — which is the honest goal, since anyone with the disk can
--      write to it.
--   3. THE CHAIN IS COMPUTED IN A TRIGGER, not by the caller. A writer cannot
--      choose its own hash, and the per-org row lock in the trigger is what
--      makes concurrent inserts a chain rather than a tree.
--
-- PARTITIONED FROM DAY ONE (§7.1). Retrofitting partitioning onto a live
-- high-volume table is genuinely painful; doing it now costs the DO block below.

-- --------------------------------------------------------------------------
-- Chain heads — one row per org, holding the tip of that org's chain.
--
-- A separate table rather than "SELECT the last audit row" because the audit
-- table is partitioned and append-only: locking the tip row of a partition to
-- serialize the next insert would mean an ever-moving lock target across
-- partitions, and there is no row to lock at all for an org's first entry.
-- --------------------------------------------------------------------------
CREATE TABLE audit.chain_heads (
  org_id     uuid        PRIMARY KEY REFERENCES identity.orgs (id) ON DELETE CASCADE,
  seq        bigint      NOT NULL,
  hash       bytea       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- The log itself.
-- --------------------------------------------------------------------------
CREATE TABLE audit.audit_log (
  id            uuid        NOT NULL,
  org_id        uuid        NOT NULL,

  -- Per-org monotonic position. Assigned by the trigger under the chain-head
  -- lock. NOT enforced unique by a constraint: a unique index on a partitioned
  -- table must contain the partition key, and (org_id, seq, occurred_at) would
  -- permit a duplicate seq at a different timestamp — which is exactly what it
  -- would need to forbid. The lock is the guarantee; verification detects a
  -- violation of it.
  seq           bigint      NOT NULL,

  occurred_at   timestamptz NOT NULL,

  -- Null for the system: a retention sweep, a scheduled automation. A real
  -- value, distinct from "we forgot to record who did it".
  actor_id      uuid,

  -- The domain event name that produced this entry (`member.role_changed`), so
  -- the log and the event registry use one vocabulary.
  action        text        NOT NULL,
  resource_type text,
  resource_id   uuid,

  -- Before/after diff (§8.6). Redaction happens before this row is built —
  -- @taskflow/observability owns the paths, so a token or password cannot reach
  -- the audit log any more than it can reach a log line.
  changes       jsonb,

  -- The policy decision trace on a denial (§8.2). Structured, so "why was this
  -- refused" is answerable months later without reproducing the request.
  decision      jsonb,

  ip            inet,
  user_agent    text,
  session_id    uuid,
  request_id    text,

  -- Null only for the first entry in an org's chain.
  prev_hash     bytea,
  hash          bytea       NOT NULL,

  -- The partition key must be part of the primary key, which is why
  -- occurred_at appears here rather than id alone being sufficient.
  PRIMARY KEY (org_id, occurred_at, id)
) PARTITION BY RANGE (occurred_at);

-- Chain verification walks an org in order. Not unique, for the reason above.
CREATE INDEX audit_log_chain_idx ON audit.audit_log (org_id, seq);

-- "Who touched this?" — the query §1 promises answers across every product.
CREATE INDEX audit_log_resource_idx
  ON audit.audit_log (org_id, resource_type, resource_id, occurred_at DESC);

CREATE INDEX audit_log_actor_idx ON audit.audit_log (org_id, actor_id, occurred_at DESC);

-- --------------------------------------------------------------------------
-- Partitions.
--
-- Twelve months back and twelve forward. The backward range exists so an
-- imported or backdated entry lands in a real partition; the forward range
-- gives a year of headroom before a partition-creation job is required.
--
-- The DEFAULT partition is a safety net, not a normal path: losing an audit
-- entry because no partition accepted it is a worse outcome than an untidy
-- table. It has a cost worth knowing — while the default holds a row for month
-- M, Postgres refuses to CREATE a partition for month M, because attaching it
-- would have to move that row. So rows appearing here are an alarm that the
-- partition job has stopped, not something to leave alone.
-- --------------------------------------------------------------------------
DO $$
DECLARE
  start_month date := date_trunc('month', now() - interval '12 months')::date;
  month_start date;
  i           integer;
BEGIN
  FOR i IN 0..23 LOOP
    month_start := (start_month + (i || ' months')::interval)::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS audit.audit_log_%s PARTITION OF audit.audit_log '
      'FOR VALUES FROM (%L) TO (%L)',
      to_char(month_start, 'YYYYMM'),
      month_start,
      (month_start + interval '1 month')::date
    );
  END LOOP;
END
$$;

CREATE TABLE IF NOT EXISTS audit.audit_log_default PARTITION OF audit.audit_log DEFAULT;

-- --------------------------------------------------------------------------
-- The hash chain.
--
-- The digest is taken over a LENGTH-PREFIXED concatenation, and each of those
-- three words was chosen against a specific way of getting this wrong.
--
--   LENGTH-PREFIXED, rather than joined with a delimiter. `user_agent` is
--   attacker-controlled, so any separator byte can appear inside a field; a
--   caller who could place the separator in one field could make two different
--   entries produce identical bytes to hash. `12:Mozilla/5.0…` cannot be
--   confused with anything else, whatever the field contains.
--
--   CONCATENATION, rather than jsonb_build_object(...)::text. The verifier in
--   @taskflow/security would then have to reproduce Postgres's jsonb rendering
--   exactly — key ordering by length then bytewise, a space after every colon,
--   its own escaping rules. Two implementations of that will drift, and drift
--   here means verification reporting tampering on an untouched table, which
--   gets responded to as an incident rather than a bug.
--
--   NULL IS DISTINCT FROM EMPTY. `-` for null, `0:` for the empty string, so a
--   missing user agent and a blank one are different preimages.
--
-- occurred_at is milliseconds since the epoch, not a formatted timestamp: every
-- textual rendering of a timestamptz depends on the session's TimeZone and
-- DateStyle. Milliseconds rather than microseconds because a JavaScript Date
-- holds milliseconds, and a verifier that silently truncated would disagree
-- with the trigger on every row.
--
-- @taskflow/security owns the verification side. The two must agree exactly,
-- which packages/db/src/audit.test.ts asserts against real Postgres rather than
-- trusting.
-- --------------------------------------------------------------------------

-- One field, encoded so its boundaries are unambiguous.
CREATE FUNCTION audit.chain_field(v text) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE WHEN v IS NULL THEN '-' ELSE octet_length(v)::text || ':' || v END
$$;

CREATE FUNCTION audit.chain_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
BEGIN
  -- Create this org's head if it is the first entry, then lock it. The lock
  -- serializes concurrent inserts for one org, and only for that org — two
  -- tenants writing at the same time do not contend.
  INSERT INTO audit.chain_heads (org_id, seq, hash)
       VALUES (NEW.org_id, 0, '\x'::bytea)
  ON CONFLICT (org_id) DO NOTHING;

  SELECT seq, hash INTO head_seq, head_hash
    FROM audit.chain_heads
   WHERE org_id = NEW.org_id
     FOR UPDATE;

  NEW.seq := head_seq + 1;
  -- Null rather than the empty sentinel, so "first entry in the chain" is
  -- visible in the row instead of being inferred from seq = 1.
  NEW.prev_hash := CASE WHEN head_seq = 0 THEN NULL ELSE head_hash END;

  -- Field order is part of the contract with the verifier. Appending a new
  -- column to this list changes every subsequent hash, so a schema change here
  -- is a chain migration, not an edit.
  NEW.hash := public.digest(
    head_hash || convert_to(
      audit.chain_field(NEW.id::text) ||
      audit.chain_field(NEW.org_id::text) ||
      audit.chain_field(NEW.seq::text) ||
      audit.chain_field((extract(epoch FROM NEW.occurred_at) * 1000)::bigint::text) ||
      audit.chain_field(NEW.actor_id::text) ||
      audit.chain_field(NEW.action) ||
      audit.chain_field(NEW.resource_type) ||
      audit.chain_field(NEW.resource_id::text) ||
      audit.chain_field(NEW.changes::text) ||
      audit.chain_field(NEW.decision::text) ||
      audit.chain_field(NEW.ip::text) ||
      audit.chain_field(NEW.user_agent) ||
      audit.chain_field(NEW.session_id::text) ||
      audit.chain_field(NEW.request_id),
      'UTF8'),
    'sha256');

  UPDATE audit.chain_heads
     SET seq = NEW.seq, hash = NEW.hash, updated_at = now()
   WHERE org_id = NEW.org_id;

  RETURN NEW;
END
$$;

-- BEFORE INSERT on the partitioned parent. Row-level BEFORE triggers on
-- partitioned tables require PostgreSQL 13+; the target is 17 (§4.2).
CREATE TRIGGER audit_log_chain
  BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.chain_entry();

-- --------------------------------------------------------------------------
-- Grants.
--
-- Deliberately asymmetric, and the asymmetry IS the control (§8.6). Note the
-- absence of UPDATE and DELETE for every role: not an omission to be tidied up
-- later by someone adding "just a correction endpoint".
-- --------------------------------------------------------------------------
GRANT SELECT, INSERT ON audit.audit_log  TO taskflow_audit;
GRANT SELECT          ON audit.audit_log TO taskflow_app;

-- The trigger runs as the inserting role, so the writer needs the head table.
-- A compromised taskflow_audit could therefore forge a head — but it still
-- cannot alter an existing audit_log row, so the forgery shows up as a chain
-- break at that exact point rather than as a rewritten history.
GRANT SELECT, INSERT, UPDATE ON audit.chain_heads TO taskflow_audit;
GRANT SELECT                 ON audit.chain_heads TO taskflow_app;

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3)
--
-- Policies on the partitioned parent apply to every partition when queried
-- through the parent, which all application code does.
-- --------------------------------------------------------------------------
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_log FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit.audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit.audit_log
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- The projection writes for every org from one connection, for the same reason
-- the relay reads across orgs. Scoped `TO taskflow_audit`, so the application
-- role is unaffected — an admin reading their own audit log still goes through
-- the tenant policy above.
DROP POLICY IF EXISTS audit_log_writer ON audit.audit_log;
CREATE POLICY audit_log_writer ON audit.audit_log
  FOR ALL TO taskflow_audit
  USING (true)
  WITH CHECK (true);

ALTER TABLE audit.chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.chain_heads FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chain_heads_tenant_isolation ON audit.chain_heads;
CREATE POLICY chain_heads_tenant_isolation ON audit.chain_heads
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY IF EXISTS chain_heads_writer ON audit.chain_heads;
CREATE POLICY chain_heads_writer ON audit.chain_heads
  FOR ALL TO taskflow_audit
  USING (true)
  WITH CHECK (true);
