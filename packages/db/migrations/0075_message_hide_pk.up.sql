-- 0075 — message_hidden composite primary key.
--
-- 0074 created chat.message_hidden with an index but no PK. A repeat
-- "remove for me" on the same message would then insert a second row instead
-- of being a no-op. One hide per (user, message) is the invariant the whole
-- table exists for, so it is a PRIMARY KEY, not just a unique index: the
-- service inserts without checking first, and the constraint is what makes a
-- second hide resolve to nothing.
ALTER TABLE chat.message_hidden ADD PRIMARY KEY (org_id, user_id, message_id);
