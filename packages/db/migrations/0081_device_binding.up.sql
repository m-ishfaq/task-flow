-- 0081 — device binding for native sessions (ai/phase-14-mobile.md §4.5).
--
-- The strongest compensation for the property native lost by not having httpOnly
-- cookies: a session can be bound to a hardware-backed keypair the phone's secure
-- enclave / StrongBox generated and will never export. Once bound, `identity.
-- refresh()` requires a signature over the presented refresh token from that
-- key — a copied token is then inert off the device that minted it, because
-- producing a valid signature needs the private half, and that half never
-- leaves the hardware that created it.
--
-- Nullable, unlike `channel` (0080): not every session has one. A session
-- predating this migration has no key to check, and neither does a native
-- session whose registration call has not landed yet (a short, accepted window
-- between "session exists" and "device key bound" — see
-- `identity.service.ts`'s `registerDeviceKey`). `identity.refresh()` only
-- requires a signature when a key IS bound; a NULL key means today's
-- behaviour, unchanged. Old sessions age out on their own as refresh tokens
-- expire and users re-authenticate through a build that registers a key.
--
-- Coordinates, not a DER/SPKI blob: `x`/`y` are the raw P-256 point, base64url
-- encoded — what both iOS's `SecKeyCopyExternalRepresentation` and a JWK-shaped
-- payload give you directly, with no ASN.1 assembly on either side of the wire.
-- The curve and algorithm are NEVER read from the client — `packages/security`'s
-- verifier hardcodes P-256/ECDSA-SHA256, the same reasoning `oauth.service.ts`
-- never lets a caller name its own algorithm.
ALTER TABLE identity.sessions
  ADD COLUMN device_public_key_x text,
  ADD COLUMN device_public_key_y text,
  ADD COLUMN device_key_registered_at timestamptz;

-- Same shape as `sessions_revocation_paired`: all three present or all three
-- absent. A row with an X but no Y (or a Y with no registration timestamp) is
-- not a state `refresh()` can reason about, so the database refuses it outright
-- rather than letting a partial write be possible to observe.
ALTER TABLE identity.sessions
  ADD CONSTRAINT sessions_device_key_paired
  CHECK (
    (device_public_key_x IS NULL) = (device_public_key_y IS NULL)
    AND (device_public_key_x IS NULL) = (device_key_registered_at IS NULL)
  );

COMMENT ON COLUMN identity.sessions.device_public_key_x IS
  'Base64url X coordinate of the session''s bound device P-256 public key. NULL until registerDeviceKey binds one (ai/phase-14-mobile.md §4.5).';
COMMENT ON COLUMN identity.sessions.device_public_key_y IS
  'Base64url Y coordinate, paired with device_public_key_x.';
COMMENT ON COLUMN identity.sessions.device_key_registered_at IS
  'When the device key was bound. NULL means identity.refresh() requires no signature for this session.';

-- No grant line: taskflow_app holds the schema's table-level privileges (03-grants
-- default privileges), so new columns on a table it already reads and writes are
-- covered automatically.
