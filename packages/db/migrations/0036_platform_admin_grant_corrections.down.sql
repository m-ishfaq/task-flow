-- 0036 down — restore the grant and trigger state 0035 left behind.
--
-- The trigger body returns to the original public.digest form, the wrapper is
-- dropped, and the table REVOKEs go back to what the 0001 default privileges
-- would have granted; 0035's own down then drops the three tables entirely.
-- The audit-schema USAGE grant is revoked so a re-up starts from the same
-- clean state the first up saw.

DROP FUNCTION IF EXISTS platform.operator_chain_hash(bytea, text);

CREATE OR REPLACE FUNCTION platform.operator_chain_entry() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  head_seq  bigint;
  head_hash bytea;
BEGIN
  SELECT seq, hash INTO head_seq, head_hash
    FROM platform.operator_chain_head
   WHERE id = true
     FOR UPDATE;

  NEW.seq := head_seq + 1;
  NEW.prev_hash := CASE WHEN head_seq = 0 THEN NULL ELSE head_hash END;

  NEW.hash := public.digest(
    head_hash || convert_to(
      audit.chain_field(NEW.seq::text) ||
      audit.chain_field(NEW.operator_id::text) ||
      audit.chain_field(NEW.action) ||
      audit.chain_field(NEW.target::text) ||
      audit.chain_field((extract(epoch FROM NEW.occurred_at) * 1000)::bigint::text),
      'UTF8'),
    'sha256');

  UPDATE platform.operator_chain_head SET seq = NEW.seq, hash = NEW.hash WHERE id = true;
  RETURN NEW;
END
$$;

REVOKE USAGE ON SCHEMA audit FROM taskflow_platform_admin;

GRANT INSERT, UPDATE, DELETE ON platform.operator_chain_head TO taskflow_app;
GRANT INSERT, UPDATE, DELETE ON platform.operator_audit_log TO taskflow_app;
GRANT INSERT, UPDATE, DELETE ON platform.operators TO taskflow_app;
