-- 0020 — link previews for chat messages
-- (PLAN.md §3.2, §8.7; ai/phase-5-chat.md §3.10, §7.6)
--
-- A preview is fetched ASYNCHRONOUSLY, after the message has already been sent
-- and delivered (§7.6's resolved call). That ordering is why this is a separate
-- table rather than a column on `messages`: the message is written in one
-- transaction and the preview arrives in another, seconds later, and a column
-- would mean an UPDATE to a row that a dozen clients have already rendered.
--
-- ==========================================================================
-- EVERY VALUE IN THIS TABLE CAME FROM A THIRD-PARTY SERVER
-- ==========================================================================
--
-- `title`, `description`, `image_url` and `site_name` are whatever some host on
-- the internet chose to return, fetched because a user pasted a link. Nothing
-- about them is trustworthy:
--
--   * They are rendered as TEXT, never as markup. There is no
--     `dangerouslySetInnerHTML` anywhere in this codebase (CLAUDE.md rule 4)
--     and a preview card is not the reason to add one.
--   * `image_url` is re-checked against the same outbound-URL rules the page
--     was, because the browser is what loads it — an `og:image` pointing at an
--     internal address would turn every viewer into the fetcher that
--     `apps/api/src/chat/unfurl.ts` exists to avoid being.
--   * Lengths are capped here as well as in the fetcher. The fetcher is the
--     thing that can be bypassed by a second call site; the constraint is not.
--
-- ==========================================================================
-- ONE ROW PER (MESSAGE, URL), AND FAILURES ARE RECORDED
-- ==========================================================================
--
-- A message may contain several links, and the same link may appear in many
-- messages. The primary key is the pair.
--
-- `status` records the attempt, not just its success. A row that says `refused`
-- is what stops the job retrying a URL that will never be allowed — and it is
-- also the only place an operator can see that someone is pasting links to
-- 169.254.169.254, which is worth being able to notice.

CREATE TABLE chat.message_unfurls (
  org_id      uuid        NOT NULL,
  channel_id  uuid        NOT NULL,
  message_id  uuid        NOT NULL,

  -- The URL as it appeared in the message, after trailing punctuation is
  -- stripped. Not normalized further: two spellings of one page are two rows,
  -- which is cheaper than a normalization rule that has to agree with whatever
  -- the fetcher actually requested.
  url         text        NOT NULL,

  -- 'ok'        — fetched and parsed.
  -- 'refused'   — the SSRF control said no. Terminal; never retried.
  -- 'failed'    — timeout, DNS, 5xx, unparseable. Retryable in principle.
  status      text        NOT NULL,

  title       text,
  description text,
  image_url   text,
  site_name   text,

  fetched_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (org_id, message_id, url),

  CONSTRAINT message_unfurls_status_valid
    CHECK (status IN ('ok', 'refused', 'failed')),

  CONSTRAINT message_unfurls_url_length         CHECK (length(url) <= 2048),
  CONSTRAINT message_unfurls_title_length       CHECK (title IS NULL OR length(title) <= 300),
  CONSTRAINT message_unfurls_description_length CHECK (description IS NULL OR length(description) <= 300),
  CONSTRAINT message_unfurls_image_length       CHECK (image_url IS NULL OR length(image_url) <= 2048),
  CONSTRAINT message_unfurls_site_length        CHECK (site_name IS NULL OR length(site_name) <= 300),

  -- Only 'ok' may carry metadata. A 'refused' row with a title would mean the
  -- fetch happened after the control said no, which is a state that should be
  -- unrepresentable rather than merely unwritten.
  CONSTRAINT message_unfurls_metadata_matches_status CHECK (
    status = 'ok'
    OR (title IS NULL AND description IS NULL AND image_url IS NULL AND site_name IS NULL)
  ),

  -- Composite, so a preview cannot be attached to a message in another channel
  -- — the same reasoning as `messages_parent_fk` in 0017. RLS keeps this inside
  -- a tenant and says nothing about which channel.
  CONSTRAINT message_unfurls_message_fk
    FOREIGN KEY (org_id, channel_id, message_id)
      REFERENCES chat.messages (org_id, channel_id, id) ON DELETE CASCADE
);

-- The render path: every preview for the page of messages being displayed.
CREATE INDEX message_unfurls_channel_idx
  ON chat.message_unfurls (org_id, channel_id, message_id);

-- --------------------------------------------------------------------------
-- Row-Level Security (§8.3) — generated form, as every other tenant table.
-- --------------------------------------------------------------------------

ALTER TABLE chat.message_unfurls ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat.message_unfurls FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS message_unfurls_tenant_isolation ON chat.message_unfurls;
CREATE POLICY message_unfurls_tenant_isolation ON chat.message_unfurls
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
