-- Revert 0016 — the realtime consumer.
--
-- Leaves any outbox_dispatch rows with consumer = 'realtime' in place. They are
-- history, and the same reasoning 0006 gave for keeping dispatched rows applies:
-- deleting them would make a re-applied migration redeliver every event the
-- gateway had already broadcast. Nothing can read them once the policies below
-- are gone.

-- Dropped rather than kept: unlike outbox_dispatch these rows are not history,
-- they are broadcast packets whose useful life was a few seconds. Leaving them
-- would mean tenant data in a table nothing can read and nothing prunes.
DROP POLICY IF EXISTS socket_io_attachments_realtime ON platform.socket_io_attachments;
DROP TABLE IF EXISTS platform.socket_io_attachments;

DROP TRIGGER IF EXISTS outbox_appended_notify ON platform.outbox;
DROP FUNCTION IF EXISTS platform.notify_outbox_appended();

DROP POLICY IF EXISTS outbox_dispatch_realtime_read ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_realtime_insert ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_dispatch_realtime_update ON platform.outbox_dispatch;
DROP POLICY IF EXISTS outbox_realtime_read ON platform.outbox;

REVOKE ALL ON platform.outbox_dispatch FROM taskflow_realtime;
REVOKE ALL ON platform.outbox FROM taskflow_realtime;
REVOKE USAGE ON SCHEMA platform FROM taskflow_realtime;
