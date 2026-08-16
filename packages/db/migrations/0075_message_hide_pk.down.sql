-- 0075 down — drop the composite primary key added on top of 0074's table.
ALTER TABLE chat.message_hidden DROP CONSTRAINT message_hidden_pkey;
