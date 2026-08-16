-- 0074 down — drop the per-user hide table. The composite FK on messages
-- means the DROP removes every hide row with it; nothing else references this
-- table.
DROP TABLE chat.message_hidden;
