-- 0076 down — restore the per-emoji primary key. Going down can never
-- violate anything: a message can hold at most one reaction per user, which
-- is a strict subset of what (message_id, user_id, emoji) admits.
ALTER TABLE chat.message_reactions DROP CONSTRAINT message_reactions_pkey;
ALTER TABLE chat.message_reactions ADD PRIMARY KEY (message_id, user_id, emoji);
