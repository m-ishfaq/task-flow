-- Revert 0020 — chat link previews.
--
-- Self-contained: nothing references `chat.message_unfurls`, so its index,
-- constraints and RLS policy go with the table. Previews are derived data — the
-- fetcher can rebuild any of them from the message text — so unlike 0017 and
-- 0019 this down migration loses nothing that cannot be recreated.

DROP TABLE IF EXISTS chat.message_unfurls;
