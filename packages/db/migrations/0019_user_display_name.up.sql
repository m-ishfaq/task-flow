-- 0019 — a display name on a user account
-- (PLAN.md §3.6 People; ai/phase-5-chat.md §3.1)
--
-- Until now `identity.users` held an email address and nothing else that names
-- a person, so every surface that had to show WHO — a card assignee, a comment
-- author, a chat message, a DM in the sidebar — rendered an email address.
-- `useMembers`' own `Person.label` recorded this as a known gap: "Email today.
-- Becomes a display name when there is a profile surface."
--
-- Chat is what makes it stop being cosmetic. A board shows an assignee's avatar
-- with a tooltip; a conversation shows the name on every single line, and a DM
-- is LABELLED by the other person — there is no channel name to fall back on,
-- because the database refuses one (0017). An address in that position is not a
-- placeholder for a name, it is the wrong thing entirely.
--
-- ==========================================================================
-- NULLABLE, AND WHY IT STAYS THAT WAY
-- ==========================================================================
--
-- Every existing account has no name, and there is no honest value to backfill.
-- Deriving one from the local part of the address ("m.oneshfaq" -> "M Oneshfaq")
-- guesses at how somebody is called and writes the guess into a column that
-- looks authored — after which nobody can tell an entered name from an inferred
-- one, and the inferred ones never get corrected because they look fine.
--
-- So the column is nullable and the FALLBACK lives in the read path: a caller
-- gets the name if there is one and the email if there is not. That keeps the
-- guess where it can be changed and out of the data.
--
-- ==========================================================================
-- IT IS NOT UNIQUE, DELIBERATELY
-- ==========================================================================
--
-- Two people are allowed to be called the same thing, because two people are
-- often called the same thing. Uniqueness here would turn an ordinary fact
-- about names into a signup failure, and the identifier that must be unique
-- already is: `email_normalized` carries that index and nothing else should.
--
-- The consequence is that a name is not an identifier and must never be used as
-- one. Nothing may look a user up by this column, and no authorization decision
-- may read it — `resolveOrgMembership` keys on the user id, as it always has.

ALTER TABLE identity.users ADD COLUMN display_name text;

-- Bounded, and required to be non-blank WHEN PRESENT. A row carrying a string
-- of spaces is the state where "has a name" is true everywhere in the code and
-- the rendered result is an empty gap, which is worse than null because null
-- has a fallback and this does not.
ALTER TABLE identity.users ADD CONSTRAINT users_display_name_present
  CHECK (display_name IS NULL OR length(btrim(display_name)) > 0);

ALTER TABLE identity.users ADD CONSTRAINT users_display_name_length
  CHECK (display_name IS NULL OR length(display_name) <= 80);
