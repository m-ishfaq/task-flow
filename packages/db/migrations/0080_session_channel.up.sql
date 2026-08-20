-- 0080 — channel binding for the native (phone) auth path (ai/phase-14-mobile.md §4.3).
--
-- A session now records WHICH client channel minted it. The refresh path uses
-- that to refuse a token presented on the wrong surface: a browser session's
-- refresh token (delivered in an httpOnly cookie) cannot be exchanged on the
-- native route (which delivers the rotated token in the response BODY), and a
-- native session's token cannot be exchanged on the browser cookie route.
--
-- This is defence-in-depth on top of the two separate response schemas the
-- application already keeps (SessionResponse vs NativeSessionResponse). Those
-- stop the browser body from ever carrying a refresh token; this binds the
-- more-exposed, body-delivered native token to the one surface built for it, so
-- a token that leaks between contexts cannot be laundered from cookie-only into
-- body-readable (or vice versa) by presenting it on the other channel.
--
-- DEFAULT 'browser' is not a placeholder: every session that existed before this
-- migration WAS a browser session, and every existing caller keeps minting
-- 'browser' until the native routes explicitly pass 'native'. So no session
-- silently changes meaning when this runs. NOT NULL because a session with no
-- channel is a session the refresh check cannot reason about — the discriminator
-- must never be absent.
ALTER TABLE identity.sessions
  ADD COLUMN channel text NOT NULL DEFAULT 'browser';

-- A closed set, enforced by the database rather than by the application that
-- writes it — the same reason the mesh cap and the recording-consent gate are
-- CHECK constraints. A row claiming an unknown channel is nonsense the table
-- refuses, so the refresh comparison can never meet a value it did not expect.
ALTER TABLE identity.sessions
  ADD CONSTRAINT sessions_channel_valid CHECK (channel IN ('browser', 'native'));

COMMENT ON COLUMN identity.sessions.channel IS
  'The client channel that minted this session: browser (httpOnly cookie) or native (body delivery). The refresh path refuses a token presented on a different channel than the one recorded here (ai/phase-14-mobile.md §4.3).';

-- No grant line: taskflow_app holds the schema''s table-level privileges (03-grants
-- default privileges), so a new column on a table it already reads and writes is
-- covered automatically — unlike a role with a COLUMN-level grant, which would
-- need the new column named explicitly.
