-- 0017 — chat: channels, channel members, messages
-- (PLAN.md §3.2, §7, §8.2; ai/phase-5-chat.md §3.1, §3.3, §3.9)
--
-- Numbered 0017 rather than 0015 deliberately. Phase 4 owns 0015 (outbox
-- fan-out) and 0016 (the realtime consumer role) on `development-phase4`, and a
-- migration number is not a thing two branches can share: applying both would
-- run one and silently skip the other, since the ledger keys on the number.
--
-- ==========================================================================
-- WHAT THIS SCHEMA IS TRYING TO MAKE IMPOSSIBLE
-- ==========================================================================
--
-- A DM is a channel. Not a second table, not a `dms` relation with its own
-- membership column — a row in `channels` with `type = 'dm'` whose members are
-- exactly its two participants (`ai/phase-5-chat.md` §3.1). That is a security
-- decision before it is a modelling one: the moment DMs get their own table
-- they get their own read path, and the read path for the most private surface
-- in the product becomes the one with the least-exercised authorization code.
-- One table means one `channel:read` check, exercised by every channel test.
--
-- ==========================================================================
-- THERE IS NO channel_members TABLE, AND THAT IS THE POINT
-- ==========================================================================
--
-- Channel membership is a RELATION TUPLE in `authz.relationship_tuples`:
-- (user, 'member', channel:{id}). Not a table here. §3.3 requires that joining
-- a channel resolves `channel:read` through `can()` and not "a parallel code
-- path that checks participantIds.includes(userId) inline" — and a membership
-- table is that parallel path wearing a foreign key. Three things fall out of
-- using the tuple instead, none of which are available to a local table:
--
--   * `can()` already reads it. Tuples are loaded once per request by
--     `resolveOrgMembership` and carried on the principal, so the authorization
--     decision costs no extra query and is the SAME decision the HTTP path, the
--     socket gateway and the permission debug page all make.
--
--   * Removal already force-leaves. Phase 4's `revocation.ts` re-runs the room
--     authorization for affected sockets when `grant.revoked` arrives. Removing
--     someone from a private channel therefore evicts their open tab through
--     machinery that already exists and is already tested, rather than through a
--     second eviction path written for chat.
--
--   * `member` was built for this. Its grant set in packages/policy/src/tuples.ts
--     is `read`/`download` plus `message:create`/`message:update` and its comment
--     reads "channel and team membership" — written in Phase 2, for this.
--
-- The tuple table carries `granted_by` and `created_at`, which is the "who added
-- them and when" a roster needs, and `expires_at`, which is what Wave 4's guest
-- access (§3.8) needs and a membership table would have had to grow.
--
-- The cost, stated plainly: `loadTuples` reads every tuple a user holds on every
-- request, so a person in two hundred channels carries two hundred rows on
-- requests that have nothing to do with chat. Accepted — it is a few kilobytes
-- against a per-request role read Phase 2 already pays for the same reason, and
-- the alternative is a membership check the policy matrix test cannot see.
--
-- ==========================================================================
-- THE COMPOSITE FK PATTERN, AND WHY IT IS NOT OPTIONAL HERE
-- ==========================================================================
--
-- Same reasoning as 0008/0009/0013: RLS stops a row crossing a TENANT and says
-- nothing about a row crossing a CHANNEL inside one tenant. A message written
-- into a channel the author cannot read is an ordinary authorization bug that
-- `withOrgScope` is structurally unable to see. So `messages` carries
-- `channel_id` and references it composite-with-org, and a threaded reply
-- references (org_id, channel_id, id) on its parent — a reply cannot be planted
-- under a message in a different channel even when both ids are known.

-- --------------------------------------------------------------------------
-- Channels
-- --------------------------------------------------------------------------
CREATE TABLE chat.channels (
  id            uuid        PRIMARY KEY,
  org_id        uuid        NOT NULL REFERENCES identity.orgs (id) ON DELETE CASCADE,

  -- 'public'   — every org member may read and join.
  -- 'private'  — membership required; not discoverable by non-members.
  -- 'dm'       — exactly two members, no name, cannot be joined or renamed.
  -- 'group_dm' — three or more members, same rules as 'dm' otherwise.
  --
  -- A CHECK rather than a Postgres enum: adding a value to an enum inside a
  -- transaction is restricted in older Postgres and dropping one is impossible,
  -- so an enum makes the next channel type a harder migration than it needs to
  -- be. The same choice as `views.type` in 0014.
  type          text        NOT NULL,

  -- Null for DMs, which are named by their participants at render time. A DM
  -- with a name would be a private channel wearing a DM's authorization rules.
  name          text,
  topic         text,

  created_by    uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  -- Archive, not delete — the same distinction §7.1 draws for projects and
  -- boards. An archived channel keeps its messages and stops accepting new
  -- ones; retention (Wave 4) is what eventually removes content, and it is a
  -- separate decision made by a separate policy.
  archived_at   timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT channels_type_valid
    CHECK (type IN ('public', 'private', 'dm', 'group_dm')),

  -- A named channel must actually have a name; a DM must not. Expressed as one
  -- constraint over both branches so there is no state where `type` and `name`
  -- disagree — a 'dm' row carrying a name is exactly the row that would let a
  -- DM be listed in a channel browser.
  CONSTRAINT channels_name_matches_type CHECK (
    CASE
      WHEN type IN ('public', 'private') THEN name IS NOT NULL AND length(btrim(name)) > 0
      ELSE name IS NULL
    END
  ),
  CONSTRAINT channels_name_length  CHECK (name IS NULL OR length(name) <= 80),
  CONSTRAINT channels_topic_length CHECK (topic IS NULL OR length(topic) <= 500)
);

-- Required by the composite FKs below. Postgres needs a unique index on
-- exactly the referenced columns, and `id` alone being the PK is not enough.
CREATE UNIQUE INDEX channels_org_id_key ON chat.channels (org_id, id);

-- One channel of a given name per org, case-insensitively, for named channels
-- only. Two #general channels is a data-entry accident that makes every "which
-- one did they mean" conversation permanent. DMs are excluded because their
-- name is null and uniqueness there is a property of the member set instead.
CREATE UNIQUE INDEX channels_org_name_key
  ON chat.channels (org_id, lower(name))
  WHERE name IS NOT NULL AND archived_at IS NULL;

-- The channel browser: this org's live named channels, alphabetically.
CREATE INDEX channels_org_type_idx
  ON chat.channels (org_id, type, lower(name))
  WHERE archived_at IS NULL;

-- --------------------------------------------------------------------------
-- Messages
-- --------------------------------------------------------------------------
CREATE TABLE chat.messages (
  id                uuid        PRIMARY KEY,
  org_id            uuid        NOT NULL,
  channel_id        uuid        NOT NULL,

  -- Null for a top-level message, a message's id for a threaded reply. One
  -- level only, exactly as card comments are (0013): a reply to a reply is a
  -- SERVICE rule, because expressing "my parent's parent must be null" in the
  -- database needs a trigger, and a trigger for one product rule the UI already
  -- enforces is more machinery than the invariant is worth.
  parent_message_id uuid,

  -- Null once the author's account is deleted. The message survives — a thread
  -- that loses its middle becomes incoherent, which is the same reason comment
  -- deletion is a tombstone below.
  author_id         uuid        REFERENCES identity.users (id) ON DELETE SET NULL,

  -- TipTap JSON, never HTML (CLAUDE.md rule 4). Validated against the closed
  -- node/mark whitelist in `work/richtext.ts` before it reaches this column;
  -- jsonb here is storage, not validation.
  body              jsonb       NOT NULL,

  -- The flattened text, maintained by the service in the same statement as
  -- `body`. Exists so a notification consumer resolving @mentions and a future
  -- search indexer do not each have to walk TipTap JSON — and so a LIKE search
  -- has a column to hit. Never rendered: `body` is what the client renders.
  body_text         text        NOT NULL,

  edited_at         timestamptz,

  -- A tombstone, not a row removal — see the note on `parent_message_id`.
  deleted_at        timestamptz,
  -- Whether a moderator removed someone else's message rather than the author
  -- withdrawing their own. Denormalized from the event because the audit log
  -- answers "who deleted this" and the message list needs to answer "was this
  -- removed by a moderator" without joining to it.
  deleted_by_author boolean,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_body_text_length CHECK (length(body_text) <= 20000),

  -- A deleted message records which kind of deletion it was; a live one must
  -- not claim to. Keeping the two columns consistent in a constraint means the
  -- message list can branch on `deleted_at` alone and trust the other column.
  CONSTRAINT messages_deletion_consistent CHECK (
    (deleted_at IS NULL AND deleted_by_author IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by_author IS NOT NULL)
  ),

  CONSTRAINT messages_channel_fk
    FOREIGN KEY (org_id, channel_id) REFERENCES chat.channels (org_id, id) ON DELETE CASCADE
);

-- Required by the reply FK below.
CREATE UNIQUE INDEX messages_org_channel_id_key ON chat.messages (org_id, channel_id, id);

-- A reply cannot name a parent in another channel. This is the constraint RLS
-- cannot express: both messages are in one tenant, so `withOrgScope` sees
-- nothing wrong with a reply whose parent lives in a channel the author has
-- never been a member of.
ALTER TABLE chat.messages ADD CONSTRAINT messages_parent_fk
  FOREIGN KEY (org_id, channel_id, parent_message_id)
    REFERENCES chat.messages (org_id, channel_id, id) ON DELETE CASCADE;

-- The message list: one channel, newest last, paged by id. Ordered by id rather
-- than created_at because ids are UUIDv7 (§7.1) — creation-ordered AND unique,
-- so the order is total. `created_at` has neither property under concurrency,
-- and a paging cursor on a non-unique column silently skips or repeats rows at
-- a page boundary.
CREATE INDEX messages_channel_idx ON chat.messages (org_id, channel_id, id);

-- A thread's replies. Partial, because the overwhelming majority of messages
-- are top-level and indexing their NULLs costs write throughput on the hottest
-- insert path in the product for no read benefit.
CREATE INDEX messages_parent_idx
  ON chat.messages (org_id, parent_message_id, id)
  WHERE parent_message_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, repeated verbatim from
-- packages/db/src/rls.ts, exactly as every other tenant table.
--
-- Note what these policies do NOT do: they say nothing about channel
-- membership. RLS is the TENANT boundary and only that. "May this user read
-- this channel" is `can()`'s question, asked by the service and by the socket
-- gateway's room join, and pushing it down here would put an authorization rule
-- in a place `packages/policy`'s matrix test cannot see it (guardrail 2).
-- --------------------------------------------------------------------------

ALTER TABLE chat.channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.channels FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channels_tenant_isolation ON chat.channels;
CREATE POLICY channels_tenant_isolation ON chat.channels
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE chat.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.messages FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_tenant_isolation ON chat.messages;
CREATE POLICY messages_tenant_isolation ON chat.messages
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
